/**
 * Turns `propose_write` arguments into a concrete proposal: the file's current text and the text
 * it would have. Deterministic (no editor state beyond reading the file), so the review (before
 * approval) and the write (after approval) compute exactly the same thing.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { resolveInWorkspace } from '../mcp/workspace';
import { applyEdits, MAX_CONTENT_REWRITE_LINES, ProposalError, type ProposeWriteArgs } from './edits';

export {
  MAX_CONTENT_REWRITE_LINES,
  normalizeProposeArgs,
  parseProposeArgs,
  ProposalError,
  type EditSpec,
  type ProposeWriteArgs,
} from './edits';

export interface Proposal {
  rel: string;
  abs: string;
  exists: boolean;
  /** Line ending of the file on disk (new files use \n). */
  eol: '\n' | '\r\n';
  /** Exact current text (original line endings), used to revert. */
  rawOriginal: string;
  /** Normalised (\n) current and proposed texts. */
  original: string;
  proposed: string;
  description: string;
}

/** Stable identity of a proposal: the same file and the same resulting text. */
export function proposalKey(p: Proposal): string {
  return `${p.rel}\u0000${createHash('sha256').update(p.proposed).digest('hex')}`;
}

export async function buildProposal(args: ProposeWriteArgs): Promise<Proposal> {
  let resolved: { abs: string; rel: string };
  try {
    resolved = resolveInWorkspace(args.path);
  } catch (err) {
    throw new ProposalError(err instanceof Error ? err.message : String(err));
  }
  const { abs, rel } = resolved;

  const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === abs);
  let rawOriginal = '';
  let exists = false;
  if (open) {
    rawOriginal = open.getText();
    exists = true;
  } else {
    try {
      const stat = await fs.promises.stat(abs);
      if (stat.isDirectory()) {
        throw new ProposalError(`${rel} is a directory.`);
      }
      rawOriginal = await fs.promises.readFile(abs, 'utf8');
      exists = true;
    } catch (err) {
      if (err instanceof ProposalError) {
        throw err;
      }
      exists = false;
    }
  }
  const eol: '\n' | '\r\n' = rawOriginal.includes('\r\n') ? '\r\n' : '\n';
  const original = rawOriginal.replace(/\r\n/g, '\n');
  const description = (args.description ?? '').trim();

  const hasEdits = Array.isArray(args.edits) && args.edits.length > 0;
  let proposed: string;
  if (hasEdits) {
    if (!exists) {
      throw new ProposalError(`${rel} does not exist. To create a file, pass "content" instead of "edits".`);
    }
    proposed = applyEdits(original, args.edits ?? [], rel);
  } else if (typeof args.content === 'string') {
    const existingLines = original.split('\n').length;
    if (exists && existingLines > MAX_CONTENT_REWRITE_LINES) {
      throw new ProposalError(
        `${rel} has ${existingLines} lines, too many to rewrite with "content" (a partial rewrite would delete code). ` +
          'Change it with "old_text"/"new_text" (or "edits"): copy the exact lines to replace from read_file.',
      );
    }
    proposed = args.content.replace(/\r\n/g, '\n');
    if (proposed.length > 0 && !proposed.endsWith('\n')) {
      proposed += '\n';
    }
  } else {
    throw new ProposalError(
      'propose_write needs the change: pass "old_text" (exact lines copied from the file) and "new_text" ' +
        '(their replacement), or "edits": [{"old_text": ..., "new_text": ...}] for several changes. ' +
        '"content" is only for creating a new file.',
    );
  }

  if (proposed === original) {
    throw new ProposalError(`The proposed change to ${rel} does not change anything.`);
  }
  return { rel, abs, exists, eol, rawOriginal, original, proposed, description };
}
