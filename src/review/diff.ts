/**
 * Line diff → hunks → apply a chosen subset of hunks.
 *
 * Texts are compared as arrays from `text.split('\n')` (so a trailing newline is a final empty
 * line and joining with '\n' round-trips exactly). Common prefix/suffix are trimmed first, then the
 * middle is diffed with an LCS table (edits are usually local, so the table stays small).
 */

export interface Hunk {
  index: number;
  /** Range in the original lines replaced by this hunk: [origStart, origEnd), 0-based. */
  origStart: number;
  origEnd: number;
  /** Range in the proposed lines: [newStart, newEnd). */
  newStart: number;
  newEnd: number;
  /** What original[origStart:origEnd] becomes if the hunk is accepted (context lines included). */
  newLines: string[];
  /** Display lines with ' ', '-', '+' prefixes. */
  lines: string[];
  header: string;
  added: number;
  removed: number;
}

interface Op {
  kind: 'eq' | 'del' | 'ins';
  /** cursors before this op: index into original (a) and proposed (b) */
  ao: number;
  bo: number;
}

const MAX_TABLE_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  return text.split('\n');
}

function diffOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    pre++;
  }
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    suf++;
  }
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) {
    ops.push({ kind: 'eq', ao: i, bo: i });
  }

  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n > 0 && m > 0 && n * m <= MAX_TABLE_CELLS) {
    // L[i][j] = LCS length of a[pre+i:] and b[pre+j:]
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] =
          a[pre + i] === b[pre + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[pre + i] === b[pre + j]) {
        ops.push({ kind: 'eq', ao: pre + i, bo: pre + j });
        i++;
        j++;
      } else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) {
        ops.push({ kind: 'del', ao: pre + i, bo: pre + j });
        i++;
      } else {
        ops.push({ kind: 'ins', ao: pre + i, bo: pre + j });
        j++;
      }
    }
    for (; i < n; i++) {
      ops.push({ kind: 'del', ao: pre + i, bo: pre + m });
    }
    for (; j < m; j++) {
      ops.push({ kind: 'ins', ao: pre + n, bo: pre + j });
    }
  } else {
    // nothing in common in the middle (or too large for the table): delete all, then insert all
    for (let i = 0; i < n; i++) {
      ops.push({ kind: 'del', ao: pre + i, bo: pre });
    }
    for (let j = 0; j < m; j++) {
      ops.push({ kind: 'ins', ao: pre + n, bo: pre + j });
    }
  }

  for (let k = 0; k < suf; k++) {
    ops.push({ kind: 'eq', ao: a.length - suf + k, bo: b.length - suf + k });
  }
  return ops;
}

/** Hunks between two texts (already newline-normalised), with `context` lines around each change. */
export function computeHunks(original: string, proposed: string, context = 3): Hunk[] {
  const a = splitLines(original);
  const b = splitLines(proposed);
  const ops = diffOps(a, b);
  const changes: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind !== 'eq') {
      changes.push(i);
    }
  });
  if (changes.length === 0) {
    return [];
  }

  // Group changes whose gap of unchanged lines is small enough to share context.
  const groups: [number, number][] = [];
  let gs = changes[0];
  let ge = changes[0];
  for (let k = 1; k < changes.length; k++) {
    const c = changes[k];
    if (c - ge - 1 <= 2 * context) {
      ge = c;
    } else {
      groups.push([gs, ge]);
      gs = c;
      ge = c;
    }
  }
  groups.push([gs, ge]);

  return groups.map(([s, e], index) => {
    const first = Math.max(0, s - context);
    const last = Math.min(ops.length - 1, e + context);
    const startOp = ops[first];
    const endOp = ops[last];
    const origStart = startOp.ao;
    const origEnd = endOp.ao + (endOp.kind === 'ins' ? 0 : 1);
    const newStart = startOp.bo;
    const newEnd = endOp.bo + (endOp.kind === 'del' ? 0 : 1);
    const lines: string[] = [];
    let added = 0;
    let removed = 0;
    for (let k = first; k <= last; k++) {
      const op = ops[k];
      if (op.kind === 'eq') {
        lines.push(' ' + a[op.ao]);
      } else if (op.kind === 'del') {
        lines.push('-' + a[op.ao]);
        removed++;
      } else {
        lines.push('+' + b[op.bo]);
        added++;
      }
    }
    const header = `@@ -${origStart + 1},${origEnd - origStart} +${newStart + 1},${newEnd - newStart} @@`;
    return { index, origStart, origEnd, newStart, newEnd, newLines: b.slice(newStart, newEnd), lines, header, added, removed };
  });
}

/** Apply the accepted hunks to the original text; rejected hunks keep the original lines. */
export function applyHunks(original: string, hunks: Hunk[], accepted: boolean[]): string {
  const a = splitLines(original);
  const out: string[] = [];
  const pushRange = (src: string[], from: number, to: number): void => {
    for (let i = from; i < to; i++) {
      out.push(src[i]);
    }
  };
  let cursor = 0;
  for (const h of hunks) {
    pushRange(a, cursor, h.origStart);
    if (accepted[h.index]) {
      pushRange(h.newLines, 0, h.newLines.length);
    } else {
      pushRange(a, h.origStart, h.origEnd);
    }
    cursor = h.origEnd;
  }
  pushRange(a, cursor, a.length);
  return out.join('\n');
}
