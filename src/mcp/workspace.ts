/**
 * Workspace helpers for the editor tools: safe path resolution and a ripgrep-backed search with a
 * pure-TypeScript fallback (so the tools work on machines without ripgrep).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Folders never worth showing to the model. */
export const EXCLUDE_GLOB = '{**/.git/**,**/node_modules/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/dist/**,**/build/**,**/.mypy_cache/**,**/.pytest_cache/**,**/.tox/**}';
const RG_EXCLUDES = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.mypy_cache', '.pytest_cache', '.tox'];

export function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No folder is open in VS Code. Open the repository you want the agent to work on.');
  }
  return folder.uri.fsPath;
}

/** Resolve a workspace-relative path; refuses anything outside the workspace. */
export function resolveInWorkspace(relPath: string): { abs: string; rel: string } {
  const root = workspaceRoot();
  const cleaned = relPath.trim().replace(/^\.?[\\/]+/, '');
  const abs = path.resolve(root, cleaned);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path "${relPath}" is outside the workspace.`);
  }
  return { abs, rel: rel.split(path.sep).join('/') || '.' };
}

export function toRel(absPath: string): string {
  return path.relative(workspaceRoot(), absPath).split(path.sep).join('/');
}

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export interface SearchOptions {
  query: string;
  isRegex: boolean;
  glob?: string;
  maxResults: number;
  caseSensitive: boolean;
}

let rgPathCache: string | null | undefined;

/** VS Code ships ripgrep; fall back to one on PATH. null = not found. */
function ripgrepPath(): string | null {
  if (rgPathCache !== undefined) {
    return rgPathCache;
  }
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = [
    path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
    path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
  ];
  for (const p of (process.env.PATH ?? '').split(path.delimiter)) {
    if (p) {
      candidates.push(path.join(p, exe));
    }
  }
  rgPathCache = candidates.find(c => fs.existsSync(c)) ?? null;
  return rgPathCache;
}

export async function searchWorkspace(opts: SearchOptions): Promise<{ hits: SearchHit[]; engine: string; truncated: boolean }> {
  const rg = ripgrepPath();
  if (rg) {
    try {
      return { ...(await searchWithRipgrep(rg, opts)), engine: 'ripgrep' };
    } catch {
      // fall through to the TypeScript scan
    }
  }
  return { ...(await searchWithScan(opts)), engine: 'scan' };
}

function searchWithRipgrep(rg: string, opts: SearchOptions): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const root = workspaceRoot();
  const args = ['--json', '--max-columns', '300', '--max-filesize', '1M'];
  if (!opts.isRegex) {
    args.push('--fixed-strings');
  }
  args.push(opts.caseSensitive ? '--case-sensitive' : '--ignore-case');
  for (const ex of RG_EXCLUDES) {
    args.push('--glob', `!${ex}`);
  }
  if (opts.glob) {
    args.push('--glob', opts.glob);
  }
  args.push('--', opts.query, '.');

  return new Promise((resolve, reject) => {
    const child = spawn(rg, args, { cwd: root });
    const hits: SearchHit[] = [];
    let truncated = false;
    let buffer = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (hits.length >= opts.maxResults) {
          truncated = true;
          child.kill();
          return;
        }
        try {
          const msg = JSON.parse(line) as {
            type: string;
            data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
          };
          if (msg.type === 'match' && msg.data?.path?.text && msg.data.line_number) {
            hits.push({
              file: msg.data.path.text.replace(/^\.\//, ''),
              line: msg.data.line_number,
              text: (msg.data.lines?.text ?? '').replace(/\s+$/, '').slice(0, 300),
            });
          }
        } catch {
          // partial or non-JSON line: ignore
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', code => {
      // rg exits 1 when nothing matched; a kill() after enough hits is fine too
      if (code === 0 || code === 1 || truncated || code === null) {
        resolve({ hits, truncated });
      } else {
        reject(new Error(stderr.trim() || `ripgrep exited with ${code}`));
      }
    });
  });
}

async function searchWithScan(opts: SearchOptions): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const files = await vscode.workspace.findFiles(opts.glob ?? '**/*', EXCLUDE_GLOB, 5000);
  const flags = opts.caseSensitive ? '' : 'i';
  const pattern = opts.isRegex
    ? new RegExp(opts.query, flags)
    : new RegExp(opts.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const hits: SearchHit[] = [];
  for (const uri of files) {
    let content: string;
    try {
      const stat = await fs.promises.stat(uri.fsPath);
      if (stat.size > 1_000_000) {
        continue;
      }
      content = await fs.promises.readFile(uri.fsPath, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) {
      continue; // binary
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        hits.push({ file: toRel(uri.fsPath), line: i + 1, text: lines[i].replace(/\s+$/, '').slice(0, 300) });
        if (hits.length >= opts.maxResults) {
          return { hits, truncated: true };
        }
      }
    }
  }
  return { hits, truncated: false };
}
