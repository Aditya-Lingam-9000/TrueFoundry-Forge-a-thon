/**
 * Explicit context: @file and @symbol mentions in a chat message.
 *
 *   @src/flask/cli.py  or  @cli.py   → that file (whole if short, otherwise its outline)
 *   @routes_command    or  @FlaskGroup → the function/class definition chunk
 *
 * Resolved mentions are attached to the message, within a token budget, before it goes to
 * TrueForge, so the agent starts with exactly what the user pointed at.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EXCLUDE_GLOB, searchWorkspace, toRel, workspaceRoot } from '../mcp/workspace';
import { chunkFile, definitions, estimateTokens } from './rank';

export interface Mention {
  token: string;
  kind: 'file' | 'symbol';
  resolved: boolean;
  where?: string;
  note?: string;
}

export interface MentionResult {
  attachment: string;
  mentions: Mention[];
}

const MENTION = /(^|[\s(,])@([A-Za-z0-9_][A-Za-z0-9_./-]*[A-Za-z0-9_])/g;
const FILE_LIKE = /\/|\.[A-Za-z0-9]{1,8}$/;
const WHOLE_FILE_LINES = 250;

export function findMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    if (!out.includes(m[2])) {
      out.push(m[2]);
    }
  }
  return out;
}

function numbered(lines: string[], first: number): string {
  return lines.map((l, i) => `${String(first + i).padStart(5)}  ${l}`).join('\n');
}

async function readText(rel: string): Promise<string> {
  const abs = path.join(workspaceRoot(), rel);
  const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === abs);
  return (open ? open.getText() : await fs.promises.readFile(abs, 'utf8')).replace(/\r\n/g, '\n');
}

export async function resolveMentions(text: string, budget: number): Promise<MentionResult> {
  const tokens = findMentions(text);
  if (tokens.length === 0) {
    return { attachment: '', mentions: [] };
  }
  const files = (await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, 20000)).map(u => toRel(u.fsPath));
  const blocks: string[] = [];
  const mentions: Mention[] = [];
  let used = 0;

  const add = (mention: Mention, header: string, lines: string[], first: number): void => {
    const cost = estimateTokens(lines);
    if (used + cost > budget) {
      mention.note = 'not attached: over the @-mention budget (the agent can still read it)';
      mentions.push(mention);
      return;
    }
    used += cost;
    blocks.push(`--- ${header} ---\n${numbered(lines, first)}`);
    mentions.push(mention);
  };

  for (const token of tokens) {
    if (FILE_LIKE.test(token)) {
      const exact = files.filter(f => f === token || f.endsWith(`/${token}`));
      const byName = exact.length ? exact : files.filter(f => path.basename(f) === path.basename(token));
      if (byName.length === 0) {
        mentions.push({ token, kind: 'file', resolved: false, note: 'no such file in the workspace' });
        continue;
      }
      const rel = [...byName].sort((a, b) => a.length - b.length)[0];
      const lines = (await readText(rel)).split('\n');
      const mention: Mention = {
        token,
        kind: 'file',
        resolved: true,
        where: rel,
        note: byName.length > 1 ? `also matches ${byName.length - 1} other file(s)` : undefined,
      };
      if (lines.length <= WHOLE_FILE_LINES) {
        add(mention, `@${token} → ${rel} (whole file, ${lines.length} lines)`, lines, 1);
      } else {
        const defs = definitions(rel, lines);
        const outline = defs.map((d, i) => `${d.line + 1}-${defs[i + 1]?.line ?? lines.length}  ${d.name}`);
        const header = `@${token} → ${rel} (${lines.length} lines; outline only, read ranges with read_file)`;
        const cost = estimateTokens(outline);
        if (used + cost <= budget) {
          used += cost;
          blocks.push(`--- ${header} ---\n${outline.join('\n')}`);
        } else {
          mention.note = 'outline not attached: over the @-mention budget';
        }
        mentions.push(mention);
      }
      continue;
    }

    // symbol: the last segment of a dotted name (FlaskGroup.__init__ → __init__, preferring FlaskGroup's file)
    const parts = token.split('.');
    const name = parts[parts.length - 1];
    const owner = parts.length > 1 ? parts[parts.length - 2] : undefined;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const { hits } = await searchWorkspace({
      query: `\\b(?:def|class|function|interface|type|const|let|var)\\s+${escaped}\\b`,
      isRegex: true,
      caseSensitive: true,
      maxResults: 20,
    });
    // prefer source over tests/docs/examples, then shorter paths
    const secondary = (file: string): number => (/(^|\/)(tests?|docs?|examples?)\//.test(file) ? 1 : 0);
    const ranked = [...hits].sort((a, b) => secondary(a.file) - secondary(b.file) || a.file.length - b.file.length);
    let best = ranked[0];
    if (owner) {
      const ownerClass = new RegExp(`\\bclass\\s+${owner.replace(/[^A-Za-z0-9_]/g, '')}\\b`);
      for (const h of ranked) {
        if (ownerClass.test(await readText(h.file))) {
          best = h;
          break;
        }
      }
    }
    if (!best) {
      mentions.push({ token, kind: 'symbol', resolved: false, note: 'no definition found (search_code may still find usages)' });
      continue;
    }
    const hit = best;
    const chunk = chunkFile(hit.file, await readText(hit.file)).find(c => c.startLine <= hit.line && hit.line <= c.endLine);
    if (!chunk) {
      mentions.push({ token, kind: 'symbol', resolved: false, note: 'definition could not be read' });
      continue;
    }
    const lines = chunk.lines.slice(0, 150);
    add(
      {
        token,
        kind: 'symbol',
        resolved: true,
        where: `${hit.file}:${chunk.startLine}-${chunk.startLine + lines.length - 1}`,
        note: ranked.length > 1 ? `${ranked.length} definitions found; attached the most likely one` : undefined,
      },
      `@${token} → ${hit.file}:${chunk.startLine}-${chunk.startLine + lines.length - 1} (${chunk.name})`,
      lines,
      chunk.startLine,
    );
  }

  const attachment = blocks.length
    ? `Context the user attached with @-mentions (line numbers are for orientation only):\n${blocks.join('\n\n')}`
    : '';
  return { attachment, mentions };
}
