/**
 * propose_write argument handling and exact-text edits. Pure (no VS Code), so it is unit-tested
 * and shared by the review (before approval) and the write (after approval).
 */
import { createHash } from 'node:crypto';

/**
 * Identity of one propose_write call: the hash of its normalised arguments. The review computes it
 * from the model's raw argument string, the MCP tool from the arguments TrueForge passes on; both
 * normalise to the same object, so the approved proposal is found again at write time.
 */
export function argsKey(args: ProposeWriteArgs): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex');
}

export interface EditSpec {
  old_text: string;
  new_text: string;
}

export interface ProposeWriteArgs {
  path: string;
  edits?: EditSpec[];
  content?: string;
  description?: string;
}

/** Existing files longer than this must be changed with edits, never rewritten with `content`. */
export const MAX_CONTENT_REWRITE_LINES = 120;

export class ProposalError extends Error {}

/** Parse the JSON arguments string the model produced for propose_write. */
export function parseProposeArgs(raw: string): ProposeWriteArgs {
  let value: unknown;
  try {
    value = JSON.parse(raw || '{}');
  } catch {
    throw new ProposalError('The propose_write arguments are not valid JSON.');
  }
  return normalizeProposeArgs(value);
}

/**
 * Accept the shapes models actually produce. Used both when the review is prepared (from the
 * model's raw arguments) and when the approved write runs (from the MCP tool arguments), so both
 * sides always compute the same proposal:
 *   - edits as a list of {old_text, new_text}, a single such object, or a JSON string of either
 *   - a single edit given directly as top-level old_text / new_text
 * Inside a JSON string, old_string/new_string and search/replace are accepted as aliases (MCP
 * schema validation never strips anything inside a string).
 */
export function normalizeProposeArgs(value: unknown): ProposeWriteArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProposalError('The propose_write arguments must be an object.');
  }
  const v = value as Record<string, unknown>;
  if (typeof v.path !== 'string' || !v.path.trim()) {
    throw new ProposalError('propose_write needs a "path".');
  }
  const args: ProposeWriteArgs = { path: v.path };
  if (typeof v.content === 'string') {
    args.content = v.content;
  }
  if (typeof v.description === 'string') {
    args.description = v.description;
  }

  const edits: EditSpec[] = [];
  let rawEdits: unknown = v.edits;
  let fromString = false;
  if (typeof rawEdits === 'string' && rawEdits.trim()) {
    try {
      rawEdits = JSON.parse(rawEdits);
      fromString = true;
    } catch {
      throw new ProposalError(
        '"edits" must be a list of {"old_text": ..., "new_text": ...} objects (it was a string that is not valid JSON).',
      );
    }
  }
  const list: unknown[] = Array.isArray(rawEdits) ? rawEdits : rawEdits && typeof rawEdits === 'object' ? [rawEdits] : [];
  list.forEach((e, i) => {
    const edit = (e ?? {}) as Record<string, unknown>;
    const pick = (keys: string[]): unknown => keys.map(k => edit[k]).find(x => typeof x === 'string');
    const oldText = fromString ? pick(['old_text', 'old_string', 'search', 'old']) : edit.old_text;
    const newText = fromString ? pick(['new_text', 'new_string', 'replace', 'new']) : edit.new_text;
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      throw new ProposalError(`edits[${i}] needs string "old_text" and "new_text".`);
    }
    edits.push({ old_text: oldText, new_text: newText });
  });
  const topOld = [v.old_text, v.old_string].find(x => typeof x === 'string');
  const topNew = [v.new_text, v.new_string].find(x => typeof x === 'string');
  if (typeof topOld === 'string' && typeof topNew === 'string') {
    edits.push({ old_text: topOld, new_text: topNew });
  }
  if (edits.length > 0) {
    args.edits = edits;
  }
  return args;
}

/** Prose and markup files, where re-indenting an existing line is a mistake, not a refactoring. */
const PROSE_FILE = /\.(?:rst|md|markdown|txt|adoc)$/i;

/**
 * Models sometimes retype the lines around an insertion and change their spacing (in a changelog,
 * a list item indented by 5 spaces instead of 4). In prose files that is never intended, so such
 * an edit is refused with the offending line, before the user has to review it.
 */
export function assertNoRespacing(oldText: string, newText: string, rel: string, label = 'old_text'): void {
  if (!PROSE_FILE.test(rel)) {
    return;
  }
  const newLines = newText.split('\n');
  const kept = new Set(newLines);
  for (const line of oldText.split('\n')) {
    if (line.trim() && !kept.has(line) && newLines.some(n => n !== line && n.trim() === line.trim())) {
      throw new ProposalError(
        `${label} changes only the spacing of an existing line in ${rel}: "${line.trim().slice(0, 80)}". ` +
          'Keep existing lines exactly as they are: repeat them unchanged in new_text and add only the new text.',
      );
    }
  }
}

export function applyEdits(text: string, edits: EditSpec[], rel: string): string {
  let current = text;
  edits.forEach((edit, i) => {
    let oldText = edit.old_text.replace(/\r\n/g, '\n');
    let newText = edit.new_text.replace(/\r\n/g, '\n');
    // Models often copy old_text straight from read_file output, line numbers included.
    if (countOccurrences(current, oldText) === 0) {
      const strippedOld = stripLineNumbers(oldText);
      if (strippedOld !== oldText) {
        oldText = strippedOld;
        newText = stripLineNumbers(newText);
      }
    }
    const label = edits.length > 1 ? `edits[${i}]` : 'old_text';
    assertNoRespacing(oldText, newText, rel, label);
    if (!oldText) {
      throw new ProposalError(`${label} is empty: copy the exact lines to replace from ${rel}.`);
    }
    const count = countOccurrences(current, oldText);
    if (count === 1) {
      current = current.replace(oldText, () => newText);
      return;
    }
    if (count > 1) {
      throw new ProposalError(
        `${label} appears ${count} times in ${rel}; include more surrounding lines so it matches exactly once.`,
      );
    }
    const fuzzy = replaceIgnoringIndentation(current, oldText, newText);
    if (fuzzy === 'ambiguous') {
      throw new ProposalError(
        `${label} matches several places in ${rel} (ignoring indentation); include more surrounding lines.`,
      );
    }
    if (fuzzy === undefined) {
      throw new ProposalError(
        `${label} was not found in ${rel}. Read the file again with read_file and copy the exact lines to replace` +
          (edits.length > 1 && i > 0 ? ' (earlier edits in this call are applied first).' : '.'),
      );
    }
    current = fuzzy;
  });
  return current;
}

/** "   28  def f():" → "def f():" — only when EVERY non-blank line carries read_file's number prefix. */
export function stripLineNumbers(text: string): string {
  const lines = text.split('\n');
  const prefix = /^\s*\d+ {2}/;
  const nonBlank = lines.filter(l => l.trim());
  if (nonBlank.length === 0 || !nonBlank.every(l => prefix.test(l))) {
    return text;
  }
  return lines.map(l => l.replace(prefix, '')).join('\n');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return count;
    }
    count++;
    from = at + needle.length;
  }
}

/**
 * Fallback for models that get indentation or trailing whitespace slightly wrong: match the
 * old_text lines by their trimmed content, then re-indent new_text by the same offset.
 */
function replaceIgnoringIndentation(text: string, oldText: string, newText: string): string | 'ambiguous' | undefined {
  const lines = text.split('\n');
  const oldLines = trimOuterBlankLines(oldText.split('\n'));
  if (oldLines.length === 0) {
    return undefined;
  }
  const key = (s: string): string => s.trim();
  const matches: number[] = [];
  for (let start = 0; start + oldLines.length <= lines.length; start++) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k++) {
      if (key(lines[start + k]) !== key(oldLines[k])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches.push(start);
    }
  }
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    return 'ambiguous';
  }
  const start = matches[0];
  const firstOld = oldLines.find(l => l.trim()) ?? '';
  const firstFile = lines.slice(start, start + oldLines.length).find(l => l.trim()) ?? '';
  const oldIndent = leadingWhitespace(firstOld);
  const fileIndent = leadingWhitespace(firstFile);
  const replacement = trimOuterBlankLines(newText.split('\n')).map(l =>
    oldIndent !== fileIndent && l.startsWith(oldIndent) ? fileIndent + l.slice(oldIndent.length) : l,
  );
  return [...lines.slice(0, start), ...replacement, ...lines.slice(start + oldLines.length)].join('\n');
}

function trimOuterBlankLines(lines: string[]): string[] {
  let s = 0;
  let e = lines.length;
  while (s < e && !lines[s].trim()) {
    s++;
  }
  while (e > s && !lines[e - 1].trim()) {
    e--;
  }
  return lines.slice(s, e);
}

function leadingWhitespace(s: string): string {
  return /^\s*/.exec(s)?.[0] ?? '';
}

/** Same code, ignoring line endings, trailing whitespace and blank lines around it. */
export function sameCode(a: string, b: string): boolean {
  const norm = (s: string): string =>
    trimOuterBlankLines(s.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''))).join('\n');
  return norm(a) === norm(b);
}

/** A user's selection: whole lines [startLine, endLine], 1-based inclusive, and their text. */
export interface SelectionScope {
  rel: string;
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * Replace the selected lines of `original` (normalised \n text) with `newText`. Returns undefined
 * when the selected lines no longer hold the selected text.
 */
export function replaceSelection(original: string, scope: SelectionScope, newText: string): string | undefined {
  const lines = original.split('\n');
  const start = scope.startLine - 1;
  const end = scope.endLine; // exclusive
  if (start < 0 || end > lines.length || start >= end) {
    return undefined;
  }
  if (!sameCode(lines.slice(start, end).join('\n'), scope.text)) {
    return undefined;
  }
  let replacement = stripLineNumbers(newText.replace(/\r\n/g, '\n'));
  if (replacement.endsWith('\n')) {
    replacement = replacement.slice(0, -1);
  }
  const middle = replacement === '' ? [] : replacement.split('\n');
  return [...lines.slice(0, start), ...middle, ...lines.slice(end)].join('\n');
}

/** Throws unless `proposed` differs from `original` only inside the selected lines. */
export function assertWithinSelection(original: string, proposed: string, scope: SelectionScope): void {
  const o = original.split('\n');
  const p = proposed.split('\n');
  const before = scope.startLine - 1;
  const after = o.length - scope.endLine;
  const ok =
    p.length >= before + after &&
    o.slice(0, before).every((line, i) => line === p[i]) &&
    o.slice(o.length - after).every((line, i) => line === p[p.length - after + i]);
  if (!ok) {
    throw new ProposalError(
      `This is an inline edit of the user's selection: only lines ${scope.startLine}-${scope.endLine} of ${scope.rel} may ` +
        'change. Keep everything outside the selection exactly as it is.',
    );
  }
}
