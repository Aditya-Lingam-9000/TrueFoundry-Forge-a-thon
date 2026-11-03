/**
 * Context ranking: which code goes into the agent's context, within a token budget.
 *
 * Strategy (pure, unit-tested; I/O lives in retrieve.ts):
 *   1. Terms: identifiers and keywords from the request (snake/camel parts, light stemming,
 *      stop-words removed).
 *   2. Chunks: files are split at definitions (Python/JS/TS functions and classes, Markdown/RST
 *      headings), long chunks into windows — so we rank functions, not whole files.
 *   3. Score: BM25 over chunks, plus boosts for a definition named after a term, a path containing
 *      a term, and test/doc companions of the best implementation files.
 *   4. Pack: guarantee the best chunk of each top file first (so implementation, tests and docs
 *      all make it in), then fill the budget by score. Oversized chunks are trimmed to their densest
 *      window. Tokens are estimated as characters / 4.
 */

export interface SourceFile {
  path: string;
  text: string;
  /** set by retrieval: why this file was considered */
  companionOf?: string;
  open?: boolean;
}

export interface Chunk {
  path: string;
  /** 1-based inclusive */
  startLine: number;
  endLine: number;
  /** definition or heading name, e.g. "def routes_command" or "Open a Shell" */
  name: string;
  lines: string[];
}

export interface PlanItem {
  path: string;
  startLine: number;
  endLine: number;
  name: string;
  score: number;
  tokens: number;
  reasons: string[];
  lines: string[];
}

export interface ContextPlan {
  query: string;
  terms: string[];
  budget: number;
  used: number;
  filesConsidered: number;
  chunksConsidered: number;
  items: PlanItem[];
}

export const STRATEGY =
  'lexical search (ripgrep) + file paths + definitions + test/doc companions → chunks at function/class/heading ' +
  'boundaries → BM25 with boosts → best chunk of each top file first, then by score, within the token budget';

const STOP_WORDS = new Set(
  (
    'a an and are as at be been but by can could do does for from had has have how i if in into is it its ' +
    'me my no not of on or our should so than that the their them then there these they this those to too ' +
    'up us was we were what when where which while who why will with would you your also add adds added ' +
    'make makes making use uses using used new must need needs want please change changes changed update ' +
    'updates updated ensure every any all each like just only well same other another more most some such ' +
    'very via its it is be one two way thing things value values case cases file files code alongside'
  ).split(/\s+/),
);

export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) {
    return word.slice(0, -3) + 'y';
  }
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) {
    return word.slice(0, -1);
  }
  return word;
}

function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s\-./]+/)
    .filter(Boolean);
}

/** Lower-cased, stemmed tokens of a text (identifiers kept whole and split into parts). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const id = m[0];
    const lower = id.toLowerCase();
    if (lower.length >= 3) {
      out.push(stem(lower));
    }
    const parts = splitIdentifier(id);
    if (parts.length > 1) {
      for (const p of parts) {
        const lp = p.toLowerCase();
        if (lp.length >= 3) {
          out.push(stem(lp));
        }
      }
    }
  }
  return out;
}

/** Search terms of a request, most specific first (quoted/identifier-like terms, then words). */
export function extractTerms(query: string, max = 24): string[] {
  const special: string[] = [];
  for (const m of query.matchAll(/[`"']([^`"']{2,60})[`"']/g)) {
    special.push(...tokenize(m[1]));
  }
  for (const m of query.matchAll(/[A-Za-z]+_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]+/g)) {
    special.push(...tokenize(m[0]));
  }
  const words = tokenize(query);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of [...special, ...words]) {
    if (!STOP_WORDS.has(t) && !seen.has(t)) {
      seen.add(t);
      terms.push(t);
    }
  }
  return terms.slice(0, max);
}

const PY_DEF = /^(\s{0,4})(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const JS_DEF =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function))/;
const MD_HEADING = /^#{1,6}\s+(.+)$/;
const RST_UNDERLINE = /^([=\-~^"'`#*+])\1{2,}\s*$/;

function language(path: string): 'py' | 'js' | 'md' | 'rst' | 'other' {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'py' || ext === 'pyi') {
    return 'py';
  }
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext)) {
    return 'js';
  }
  if (ext === 'md' || ext === 'markdown') {
    return 'md';
  }
  if (ext === 'rst') {
    return 'rst';
  }
  return 'other';
}

/** Definition / heading starts: 0-based line index and a display name. */
export function definitions(path: string, lines: string[]): { line: number; name: string }[] {
  const lang = language(path);
  const defs: { line: number; name: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lang === 'py') {
      const m = PY_DEF.exec(line);
      if (m) {
        let start = i;
        while (start > 0 && /^\s*@/.test(lines[start - 1])) {
          start--; // keep decorators with their function
        }
        defs.push({ line: start, name: `${line.trim().split(/[(:]/)[0]}` });
      }
    } else if (lang === 'js') {
      const m = JS_DEF.exec(line);
      if (m) {
        defs.push({ line: i, name: line.trim().split(/[({=]/)[0].trim() });
      }
    } else if (lang === 'md') {
      const m = MD_HEADING.exec(line);
      if (m) {
        defs.push({ line: i, name: m[1].trim() });
      }
    } else if (lang === 'rst') {
      const next = lines[i + 1];
      if (next !== undefined && line.trim() && RST_UNDERLINE.test(next) && next.trim().length >= line.trim().length) {
        defs.push({ line: i, name: line.trim() });
      }
    }
  }
  return defs;
}

const MAX_CHUNK_LINES = 120;
const WINDOW_LINES = 80;

/** Split a file into chunks at definitions/headings; long chunks become windows. */
export function chunkFile(path: string, text: string): Chunk[] {
  const lines = text.split('\n');
  const defs = definitions(path, lines);
  const bounds: { line: number; name: string }[] = [];
  if (defs.length === 0 || defs[0].line > 0) {
    bounds.push({ line: 0, name: '(top of file)' });
  }
  bounds.push(...defs);
  const chunks: Chunk[] = [];
  bounds.forEach((b, i) => {
    const end = i + 1 < bounds.length ? bounds[i + 1].line : lines.length;
    if (end <= b.line) {
      return;
    }
    for (let s = b.line, part = 1; s < end; s += WINDOW_LINES, part++) {
      const e = end - b.line > MAX_CHUNK_LINES ? Math.min(end, s + WINDOW_LINES) : end;
      const slice = lines.slice(s, e);
      if (slice.some(l => l.trim())) {
        chunks.push({
          path,
          startLine: s + 1,
          endLine: e,
          name: end - b.line > MAX_CHUNK_LINES ? `${b.name} (part ${part})` : b.name,
          lines: slice,
        });
      }
      if (e === end) {
        break;
      }
    }
  });
  return chunks;
}

/**
 * Tokens a chunk costs in the rendered plan: its text plus the 7-character line-number prefix of
 * every line and a header line (~4 characters per token).
 */
export function estimateTokens(lines: string[]): number {
  return Math.ceil(lines.reduce((n, l) => n + l.length + 8, 0) / 4) + 20;
}

/**
 * TrueForge refuses a single tool result above 24,000 characters ("Content too big"), so a plan
 * must stay well below that: the budget is capped, and renderPlan enforces a character ceiling.
 */
export const MAX_BUDGET_TOKENS = 4500;
export const MAX_RENDER_CHARS = 20_000;
export const MAX_CHUNKS_PER_FILE = 4;
export const MAX_CHUNKS_PER_COMPANION = 3;
const CHANGELOG = /(^|\/)(changes|changelog|history|news)(\.[a-z]+)?$/i;

interface Scored {
  chunk: Chunk;
  score: number;
  reasons: string[];
  termHits: Map<string, number>;
}

/** Score every chunk of the given files against the terms. */
export function scoreChunks(files: SourceFile[], terms: string[]): Scored[] {
  const termSet = new Set(terms);
  const chunks = files.flatMap(f => chunkFile(f.path, f.text));
  const fileOf = new Map(files.map(f => [f.path, f]));
  const tfs = chunks.map(c => {
    const tf = new Map<string, number>();
    for (const tok of tokenize(c.lines.join('\n'))) {
      if (termSet.has(tok)) {
        tf.set(tok, (tf.get(tok) ?? 0) + 1);
      }
    }
    return tf;
  });
  const lengths = chunks.map(c => Math.max(1, c.lines.length));
  const avgLen = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
  const df = new Map<string, number>();
  for (const tf of tfs) {
    for (const t of tf.keys()) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const n = chunks.length;
  const k1 = 1.2;
  const b = 0.75;
  // A term in most candidate paths (e.g. the package name) says nothing about relevance.
  const pathTokensOf = new Map(files.map(f => [f.path, new Set(tokenize(f.path))]));
  const distinctivePathTerms = new Set(
    terms.filter(t => {
      const inPaths = files.filter(f => pathTokensOf.get(f.path)?.has(t)).length;
      return inPaths > 0 && inPaths / Math.max(1, files.length) <= 0.3;
    }),
  );

  return chunks.map((chunk, i) => {
    const tf = tfs[i];
    let score = 0;
    const contrib: [string, number][] = [];
    for (const t of terms) {
      const f = tf.get(t) ?? 0;
      if (!f) {
        continue;
      }
      const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      const s = (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * lengths[i]) / avgLen));
      score += s;
      contrib.push([t, s]);
    }
    const reasons: string[] = [];
    contrib.sort((x, y) => y[1] - x[1]);
    if (contrib.length) {
      reasons.push(`mentions ${contrib.slice(0, 5).map(c => c[0]).join(', ')}`);
    }
    // Changelogs mention every feature ever added; they are rarely where a change belongs.
    if (CHANGELOG.test(chunk.path)) {
      score *= 0.4;
    }
    // Boosts only refine chunks that actually match the request (BM25 > 0); they never pull in
    // a chunk on their own.
    const bm25 = score;
    if (bm25 > 0) {
      const nameTokens = new Set(tokenize(chunk.name));
      const named = terms.filter(t => nameTokens.has(t));
      if (named.length && chunk.name !== '(top of file)') {
        score += 2 * named.length;
        reasons.push(`defines "${chunk.name}"`);
      }
      const inPath = terms.filter(t => distinctivePathTerms.has(t) && pathTokensOf.get(chunk.path)?.has(t));
      if (inPath.length) {
        score += Math.min(1.5, 0.75 * inPath.length);
        reasons.push(`path matches ${inPath.join(', ')}`);
      }
      const file = fileOf.get(chunk.path);
      if (file?.companionOf) {
        score += 1;
        reasons.push(`${/test/i.test(chunk.path) ? 'tests' : 'docs'} for ${file.companionOf}`);
      }
      if (file?.open) {
        score += 0.5;
        reasons.push('open in the editor');
      }
    }
    return { chunk, score, reasons, termHits: tf };
  });
}

/** Trim a chunk to the window of `size` lines with the most term mentions. */
function densestWindow(chunk: Chunk, terms: Set<string>, size: number): Chunk {
  if (chunk.lines.length <= size) {
    return chunk;
  }
  const hits = chunk.lines.map(l => tokenize(l).filter(t => terms.has(t)).length);
  let best = 0;
  let sum = hits.slice(0, size).reduce((a, c) => a + c, 0);
  let bestSum = sum;
  for (let s = 1; s + size <= hits.length; s++) {
    sum += hits[s + size - 1] - hits[s - 1];
    if (sum > bestSum) {
      bestSum = sum;
      best = s;
    }
  }
  return {
    ...chunk,
    startLine: chunk.startLine + best,
    endLine: chunk.startLine + best + size - 1,
    lines: chunk.lines.slice(best, best + size),
  };
}

export interface PackOptions {
  budget: number;
  maxFiles?: number;
}

/** Rank and pack chunks into a plan within the token budget. */
export function buildPlan(query: string, terms: string[], files: SourceFile[], opts: PackOptions): ContextPlan {
  const budget = Math.min(MAX_BUDGET_TOKENS, Math.max(500, opts.budget));
  const maxFiles = opts.maxFiles ?? 8;
  const termSet = new Set(terms);
  const scored = scoreChunks(files, terms).filter(s => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;

  const items: PlanItem[] = [];
  let used = 0;
  const taken = new Set<Scored>();
  const perFile = new Map<string, number>();
  const isCompanion = new Set(files.filter(f => f.companionOf).map(f => f.path));
  const take = (s: Scored): boolean => {
    // diversity: a few chunks per file, so one file cannot crowd out the others
    const cap = isCompanion.has(s.chunk.path) ? MAX_CHUNKS_PER_COMPANION : MAX_CHUNKS_PER_FILE;
    if ((perFile.get(s.chunk.path) ?? 0) >= cap) {
      return false;
    }
    let chunk = s.chunk;
    if (estimateTokens(chunk.lines) > budget * 0.35) {
      chunk = densestWindow(chunk, termSet, Math.max(20, Math.floor((budget * 0.3 * 4) / 60)));
    }
    const tokens = estimateTokens(chunk.lines);
    if (used + tokens > budget) {
      return false;
    }
    used += tokens;
    taken.add(s);
    perFile.set(s.chunk.path, (perFile.get(s.chunk.path) ?? 0) + 1);
    items.push({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      name: chunk.name,
      score: Math.round(s.score * 10) / 10,
      tokens,
      reasons: s.reasons,
      lines: chunk.lines,
    });
    return true;
  };

  // 1. coverage: the best chunk of each of the top files
  const bestPerFile = new Map<string, Scored>();
  for (const s of scored) {
    if (!bestPerFile.has(s.chunk.path)) {
      bestPerFile.set(s.chunk.path, s);
    }
  }
  // Implementation files whose tests/docs also matched are the centre of the change: cover them
  // first, so a budget filled by look-alike files never drops them.
  const owners = new Set(
    files.filter(f => f.companionOf && bestPerFile.has(f.path)).map(f => f.companionOf as string),
  );
  const ranked = [...bestPerFile.values()];
  const fileOrder = [
    ...ranked.filter(s => owners.has(s.chunk.path)),
    ...ranked.filter(s => !owners.has(s.chunk.path)),
  ].slice(0, maxFiles);
  for (const s of fileOrder) {
    if (s.score >= top * 0.15) {
      take(s);
    }
  }
  // 2. fill by score
  for (const s of scored) {
    if (taken.has(s) || s.score < top * 0.25) {
      continue;
    }
    if (!fileOrder.some(f => f.chunk.path === s.chunk.path) && items.length >= maxFiles * 2) {
      continue;
    }
    take(s);
  }

  // present in file-rank order (tests/docs right after the file they belong to), then by line
  const rank = new Map(fileOrder.map((s, i) => [s.chunk.path, i]));
  const companionOf = new Map(files.filter(f => f.companionOf).map(f => [f.path, f.companionOf as string]));
  const groupRank = (p: string): number => {
    const owner = companionOf.get(p);
    if (owner !== undefined && rank.has(owner)) {
      return (rank.get(owner) ?? 99) + 0.5 + (rank.get(p) ?? 0) / 100;
    }
    return rank.get(p) ?? 99;
  };
  items.sort((a, b) => groupRank(a.path) - groupRank(b.path) || a.startLine - b.startLine);
  return {
    query,
    terms,
    budget,
    used,
    filesConsidered: files.length,
    chunksConsidered: scored.length,
    items,
  };
}

/** The plan as the tool result the model reads: summary, reasons, then numbered code. */
export function renderPlan(plan: ContextPlan): string {
  if (plan.items.length === 0) {
    return (
      `No relevant code found for: ${plan.query}\nTerms searched: ${plan.terms.join(', ') || '(none)'}. ` +
      'Try search_code with a more specific identifier, or list_files.'
    );
  }
  const files = [...new Set(plan.items.map(i => i.path))];
  const out = [
    `Context plan for: ${plan.query}`,
    `Budget ${plan.budget} tokens · used ${plan.used} · ${plan.items.length} chunks from ${files.length} files ` +
      `(ranked ${plan.chunksConsidered} matching chunks in ${plan.filesConsidered} candidate files)`,
    `Terms: ${plan.terms.join(', ')}`,
    `Strategy: ${STRATEGY}`,
    '',
    'Chosen (why):',
    ...plan.items.map(
      (it, i) =>
        `${i + 1}. ${it.path}:${it.startLine}-${it.endLine}  ${it.name}  (score ${it.score}) — ${it.reasons.join('; ')}`,
    ),
  ];
  const footer =
    '\nLine numbers are for orientation only: when you copy code into old_text, leave them out. ' +
    'Read more with read_file (start_line/end_line) only if something is missing.';
  let size = out.join('\n').length + footer.length;
  const omitted: string[] = [];
  for (const it of plan.items) {
    const block = [
      '',
      `--- ${it.path}:${it.startLine}-${it.endLine} (${it.name}) ---`,
      ...it.lines.map((l, k) => `${String(it.startLine + k).padStart(5)}  ${l}`),
    ];
    const blockSize = block.join('\n').length + 1;
    if (size + blockSize > MAX_RENDER_CHARS) {
      omitted.push(`${it.path}:${it.startLine}-${it.endLine}`); // safety net: never exceed the tool-result limit
      continue;
    }
    size += blockSize;
    out.push(...block);
  }
  if (omitted.length) {
    out.push('', `(Code of ${omitted.join(', ')} omitted to stay within the size limit: read it with read_file.)`);
  }
  out.push(footer);
  return out.join('\n');
}
