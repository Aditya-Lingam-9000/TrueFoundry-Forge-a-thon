/**
 * The editor's capabilities as an MCP server, served over Streamable HTTP on 127.0.0.1 and
 * protected by a per-launch bearer token. TrueForge connects to it at the start of every turn,
 * so the agent — not the extension — decides what to read.
 *
 * Milestone 1 tools (read-only): list_files, read_file, search_code.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as vscode from 'vscode';
import * as z from 'zod';
import { EXCLUDE_GLOB, resolveInWorkspace, searchWorkspace, toRel } from './workspace';

const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 40_000;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(err: unknown): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
}

/** Builds a fresh MCP server with the editor tools (stateless: one per HTTP request). */
function buildServer(log: (msg: string) => void): McpServer {
  const server = new McpServer({ name: 'forge-editor', version: '0.1.0' });

  server.registerTool(
    'list_files',
    {
      title: 'List files',
      description:
        'List workspace files matching a glob (workspace-relative paths). Use it to learn the repository layout. ' +
        'Examples: "**/*.py", "src/**", "docs/*.rst".',
      inputSchema: {
        glob: z.string().optional().describe('Glob pattern, default "**/*"'),
        max_results: z.number().int().min(1).max(1000).optional().describe('Default 200'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ glob, max_results }) => {
      try {
        const limit = max_results ?? 200;
        const uris = await vscode.workspace.findFiles(glob || '**/*', EXCLUDE_GLOB, limit + 1);
        const files = uris.map(u => toRel(u.fsPath)).sort();
        const shown = files.slice(0, limit);
        log(`list_files(${glob ?? '**/*'}) -> ${files.length > limit ? `${limit}+` : files.length} files`);
        return ok(
          shown.join('\n') +
            (files.length > limit ? `\n… more files exist; narrow the glob.` : '') +
            (files.length === 0 ? '(no files match)' : ''),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description:
        `Read a workspace file with line numbers. Reads at most ${MAX_READ_LINES} lines per call: ` +
        'use start_line/end_line for large files (the reply states the total line count).',
      inputSchema: {
        path: z.string().describe('Workspace-relative path, e.g. src/flask/helpers.py'),
        start_line: z.number().int().min(1).optional().describe('First line to read (1-based), default 1'),
        end_line: z.number().int().min(1).optional().describe('Last line to read (inclusive)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: relPath, start_line, end_line }) => {
      try {
        const { abs, rel } = resolveInWorkspace(relPath);
        // Prefer the open editor's text (it may have unsaved changes) over the file on disk.
        const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === abs);
        const text = open ? open.getText() : await fs.promises.readFile(abs, 'utf8');
        const lines = text.split(/\r?\n/);
        const start = Math.min(start_line ?? 1, Math.max(lines.length, 1));
        const end = Math.min(end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1, lines.length);
        let body = '';
        for (let i = start; i <= end; i++) {
          const line = `${String(i).padStart(5)}  ${lines[i - 1]}\n`;
          if (body.length + line.length > MAX_READ_CHARS) {
            body += `… (stopped at ${MAX_READ_CHARS} characters; continue with start_line=${i})\n`;
            break;
          }
          body += line;
        }
        log(`read_file(${rel}, ${start}-${end} of ${lines.length})`);
        const more = end < lines.length ? ` — continue with start_line=${end + 1}` : '';
        return ok(`${rel} (lines ${start}-${end} of ${lines.length}${more})\n${body}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'search_code',
    {
      title: 'Search code',
      description:
        'Search the workspace for text (or a regex) and return matching lines as path:line: text. ' +
        'Use it to find where symbols are defined or used before reading files.',
      inputSchema: {
        query: z.string().min(1).describe('Text or regular expression to find'),
        is_regex: z.boolean().optional().describe('Treat query as a regular expression (default false)'),
        glob: z.string().optional().describe('Only search files matching this glob, e.g. "**/*.py"'),
        case_sensitive: z.boolean().optional().describe('Default false'),
        max_results: z.number().int().min(1).max(500).optional().describe('Default 50'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, is_regex, glob, case_sensitive, max_results }) => {
      try {
        const { hits, engine, truncated } = await searchWorkspace({
          query,
          isRegex: is_regex ?? false,
          glob,
          caseSensitive: case_sensitive ?? false,
          maxResults: max_results ?? 50,
        });
        log(`search_code(${JSON.stringify(query)}${glob ? `, ${glob}` : ''}) -> ${hits.length} hits via ${engine}`);
        if (hits.length === 0) {
          return ok('No matches.');
        }
        return ok(
          hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n') +
            (truncated ? `\n… more matches exist; narrow the query or glob.` : ''),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

export interface EditorMcpEndpoint {
  url: string;
  token: string;
  dispose(): Promise<void>;
}

/** Start the MCP server on a free 127.0.0.1 port. */
export async function startEditorMcpServer(log: (msg: string) => void): Promise<EditorMcpEndpoint> {
  const token = randomBytes(24).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);

  const httpServer = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) and no session to delete (DELETE).
      res
        .writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      res
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }

    const server = buildServer(log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log(`MCP request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res
          .writeHead(500, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = httpServer.address() as AddressInfo;
  log(`editor MCP server listening on http://127.0.0.1:${port}/mcp`);

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    dispose: () =>
      new Promise<void>(resolve => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      }),
  };
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
