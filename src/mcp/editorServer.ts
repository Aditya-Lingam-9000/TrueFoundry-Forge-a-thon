/**
 * The editor's capabilities as an MCP server, served over Streamable HTTP on 127.0.0.1 and
 * protected by a per-launch bearer token. TrueForge connects to it at the start of every turn,
 * so the agent — not the extension — decides what to read.
 *
 * Read-only tools: list_files, read_file, search_code.
 * Gated tools (TrueForge pauses for approval before running them):
 *   propose_write — the user reviews the change hunk by hunk in the editor; only accepted hunks are written
 *   run_command   — the user approves the exact command in the agent panel
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as vscode from 'vscode';
import * as z from 'zod';
import { definitions, renderPlan, type ContextPlan } from '../context/rank';
import { retrieveContext } from '../context/retrieve';
import type { ChangeController } from '../review/changeController';
import type { CommandRunner } from './commandRunner';
import { EXCLUDE_GLOB, resolveInWorkspace, searchWorkspace, toRel } from './workspace';

export interface EditorToolDeps {
  log: (msg: string) => void;
  changes: ChangeController;
  commands: CommandRunner;
  /** default token budget of retrieve_context */
  contextBudget: () => number;
  /** every context plan, so the panel can show what was chosen and why */
  onContextPlan?: (plan: ContextPlan) => void;
}

const EDIT_SCHEMA = z.object({
  old_text: z.string().describe('Exact current text to replace (unique in the file)'),
  new_text: z.string().describe('Replacement text'),
});

const MAX_READ_LINES = 200;
/** read_file without a range returns the outline instead for files longer than this */
const WHOLE_FILE_LIMIT = 250;
const MAX_READ_CHARS = 16_000;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(err: unknown): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
}

/** Builds a fresh MCP server with the editor tools (stateless: one per HTTP request). */
function buildServer(deps: EditorToolDeps): McpServer {
  const { log } = deps;
  const server = new McpServer({ name: 'forge-editor', version: '0.3.0' });

  server.registerTool(
    'retrieve_context',
    {
      title: 'Retrieve relevant code',
      description:
        'START HERE for any task. Describe the task in plain words; returns the most relevant code of the ' +
        'repository (functions, classes, doc sections — not whole files), ranked and packed into a token budget, ' +
        'with the reason each piece was chosen. Implementation, its tests and its docs are covered together. ' +
        'Use search_code / file_outline / read_file afterwards only for what is still missing.',
      inputSchema: {
        query: z.string().min(3).describe('The task or question, with any names you know (functions, commands, files)'),
        budget_tokens: z
          .number()
          .int()
          .min(1000)
          .max(24000)
          .optional()
          .describe('Token budget for the returned code (default from settings, usually 4000; capped at 4500)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, budget_tokens }) => {
      try {
        const plan = await retrieveContext(query, budget_tokens ?? deps.contextBudget());
        const files = new Set(plan.items.map(i => i.path)).size;
        log(`retrieve_context(${JSON.stringify(query.slice(0, 80))}) -> ${plan.items.length} chunks / ${files} files, ${plan.used}/${plan.budget} tokens`);
        deps.onContextPlan?.(plan);
        return ok(renderPlan(plan));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'file_outline',
    {
      title: 'File outline',
      description:
        'List the functions, classes and section headings of a file with their line numbers, so you can read ' +
        'exactly the right range with read_file instead of the whole file.',
      inputSchema: {
        path: z.string().describe('Workspace-relative path'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: relPath }) => {
      try {
        const { abs, rel } = resolveInWorkspace(relPath);
        const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === abs);
        const text = (open ? open.getText() : await fs.promises.readFile(abs, 'utf8')).replace(/\r\n/g, '\n');
        const lines = text.split('\n');
        const defs = definitions(rel, lines);
        log(`file_outline(${rel}) -> ${defs.length} entries`);
        if (defs.length === 0) {
          return ok(`${rel}: ${lines.length} lines, no functions/classes/headings recognised. Use read_file with a range.`);
        }
        return ok(
          `${rel} (${lines.length} lines)\n` +
            defs
              .map((d, i) => {
                const end = defs[i + 1]?.line ?? lines.length;
                return `${String(d.line + 1).padStart(5)}-${String(end).padEnd(5)} ${d.name}`;
              })
              .join('\n'),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

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
        `Read a workspace file with line numbers. Reads at most ${MAX_READ_LINES} lines per call. ` +
        'Prefer a precise start_line/end_line range (find it with retrieve_context or file_outline) over reading ' +
        'whole files; the reply states the total line count.',
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
        if (start_line === undefined && end_line === undefined && lines.length > WHOLE_FILE_LIMIT) {
          // Paging through a big file fills the context window; give the map instead.
          const defs = definitions(rel, lines);
          log(`read_file(${rel}) -> outline only (${lines.length} lines)`);
          const outline = defs
            .map((d, i) => `${String(d.line + 1).padStart(5)}-${String(defs[i + 1]?.line ?? lines.length).padEnd(5)} ${d.name}`)
            .join('\n');
          return ok(
            `${rel} has ${lines.length} lines: too long to read at once. Read only the range you need with ` +
              `start_line/end_line (at most ${MAX_READ_LINES} lines).` +
              (outline ? `\nOutline (start-end  definition):\n${outline}` : ' Use search_code to find the right lines.'),
          );
        }
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

  server.registerTool(
    'propose_write',
    {
      title: 'Propose a file change',
      description:
        'Propose a change to ONE file. The user reviews it hunk by hunk in the editor and nothing is written until ' +
        'they decide; the result says which hunks were applied or rejected.\n' +
        'To change an existing file: read it first, then pass "old_text" = the EXACT current lines (copied from ' +
        'read_file without the line numbers, same indentation, plus a few unchanged lines around them so they ' +
        'match exactly once) and "new_text" = what those lines become. Example: ' +
        '{"path": "src/app.py", "old_text": "def f():\\n    return 1\\n", "new_text": "def f():\\n    return 2\\n", ' +
        '"description": "make f return 2"}.\n' +
        'Several changes in the same file: "edits": [{"old_text": ..., "new_text": ...}, ...] (applied in order).\n' +
        'To create a NEW file: "content" with the full text. Never use "content" to rewrite an existing file.\n' +
        'Call it once per file; several files can be proposed in parallel.',
      inputSchema: {
        path: z.string().describe('Workspace-relative path of the file to change or create'),
        old_text: z.string().optional().describe('Exact current lines to replace (must match exactly once)'),
        new_text: z.string().optional().describe('Replacement for old_text'),
        edits: z
          .union([z.array(EDIT_SCHEMA), EDIT_SCHEMA, z.string()])
          .optional()
          .describe('Several changes in this file: a list of {old_text, new_text}'),
        content: z.string().optional().describe('Full text, ONLY when creating a new file'),
        description: z.string().optional().describe('One sentence: what this change does and why'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async args => {
      try {
        const result = await deps.changes.applyApproved(args);
        log(`propose_write(${args.path}) -> applied`);
        return ok(result);
      } catch (err) {
        log(`propose_write(${args.path}) -> ${err instanceof Error ? err.message : String(err)}`);
        return fail(err);
      }
    },
  );

  server.registerTool(
    'run_command',
    {
      title: 'Run a shell command',
      description:
        'Run a shell command in the workspace (for example tests: "uv run --frozen pytest tests/test_cli.py -q"). ' +
        'The user approves the exact command first. Returns the exit code and the output (long output is trimmed). ' +
        'Never use it to edit files: use propose_write.',
      inputSchema: {
        command: z.string().min(1).describe('The command line to run'),
        cwd: z.string().optional().describe('Workspace-relative working directory (default: workspace root)'),
        timeout_seconds: z.number().int().min(1).max(900).optional().describe('Default 180'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ command, cwd, timeout_seconds }, extra) => {
      try {
        const r = await deps.commands.run(command, cwd, timeout_seconds ?? 180, extra.signal);
        log(`run_command(${command}) -> exit ${r.exitCode ?? 'killed'} in ${r.seconds.toFixed(1)} s`);
        const status = r.timedOut
          ? `timed out after ${timeout_seconds ?? 180} s`
          : r.killed
            ? 'stopped by the user'
            : `exit code ${r.exitCode}`;
        const result: ToolResult = {
          content: [{ type: 'text', text: `$ ${command}\n[${status}, ${r.seconds.toFixed(1)} s]\n${r.output}` }],
          isError: r.exitCode !== 0,
        };
        return result;
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
export async function startEditorMcpServer(deps: EditorToolDeps): Promise<EditorMcpEndpoint> {
  const { log } = deps;
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

    const server = buildServer(deps);
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
