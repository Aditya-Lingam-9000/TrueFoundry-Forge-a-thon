/**
 * Context ranking: which code goes into the agent's context, within a token budget.
 *
 * Strategy (pure, unit-tested; I/O lives in retrieve.ts):
 *   1. Terms: identifiers and keywords from the request (snake/camel parts, light stemming,
 *      stop-words removed).
 *   2. Chunks: files are split at definitions (Python/JS/TS functions and classes, Markdown/RST
 *      headings), long chunks into windows — so we rank functions, not whole files. A small class
 *      stays one chunk (a test class is copied as a whole); methods of a large class are split.
 *   3. Score: BM25 over chunks, plus boosts for a definition named after a term, a path containing
 *      a term, and test/doc companions of the best implementation files.
 *   3b. Sibling pattern: a request to add a new member of a family ("a new built-in command") is
 *      best served by the existing members. Families are top-level definitions sharing an affix that
 *      is a request term (run_command, shell_command, routes_command for "command"). Their
 *      definitions, the place that registers them together, the test class named after one of them
 *      and the docs that name or list them are boosted, with that reason.
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
  /** definition or heading name, e.g. "def routes_command", "FlaskGroup.__init__" or "Open a Shell" */
  name: string;
  /** bare identifier of a code definition, e.g. "routes_command" or "__init__" */
  ident?: string;
  lines: string[];
}

/** Existing definitions of one kind in one file, e.g. the built-in CLI commands. */
export interface Family {
  /** the request term they share as a name affix, e.g. "command" */
  kind: string;
  file: string;
  /** identifiers, e.g. ["run_command", "shell_command", "routes_command"] */
  members: string[];
  /** their names without the affix, e.g. ["run", "shell", "routes"] */
  short: string[];
  /** 0-based line where two or more members are registered together, if any */
  registeredAt?: number;
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
  /** sibling patterns found, as sentences (e.g. "existing commands in src/flask/cli.py: …") */
  patterns: string[];
  items: PlanItem[];
}

export const STRATEGY =
  'lexical search (ripgrep) + file paths + definitions + test/doc companions + sibling pattern (existing members of ' +
  'the requested kind, where they are registered, their tests and docs) → chunks at function/class/heading ' +
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

export interface Definition {
  /** 0-based line where the chunk starts (decorators included) */
  line: number;
  name: string;
  ident?: string;
  /** indentation of a code definition (0 = top level) */
  indent?: number;
  isClass?: boolean;
}

/** Definition / heading starts: 0-based line index and a display name. */
export function definitions(path: string, lines: string[]): Definition[] {
  const lang = language(path);
  const defs: Definition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lang === 'py') {
      const m = PY_DEF.exec(line);
      if (m) {
        let start = i;
        while (start > 0 && /^\s*@/.test(lines[start - 1])) {
          start--; // keep decorators with their function
        }
        defs.push({ line: start, name: `${line.trim().split(/[(:]/)[0]}`, ident: m[2], indent: m[1].length, isClass: /^\s*class\s/.test(line) });
      }
    } else if (lang === 'js') {
      const m = JS_DEF.exec(line);
      if (m) {
        defs.push({ line: i, name: line.trim().split(/[({=]/)[0].trim(), ident: m[1] ?? m[2] ?? m[3], indent: 0, isClass: Boolean(m[2]) });
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

/**
 * Nested definitions (methods, inner functions) start their own chunk only when their top-level
 * parent is too long to be one chunk; they are then named after the parent ("FlaskGroup.__init__").
 * A small class or function stays whole.
 */
function nestDefinitions(defs: Definition[], lineCount: number): Definition[] {
  const top = defs.filter(d => !d.indent);
  const out: Definition[] = [];
  for (const d of defs) {
    if (!d.indent) {
      out.push(d);
      continue;
    }
    const parentIndex = top.findIndex((t, i) => t.line < d.line && (i + 1 >= top.length || top[i + 1].line > d.line));
    const parent = top[parentIndex];
    if (!parent) {
      out.push(d);
      continue;
    }
    const parentEnd = parentIndex + 1 < top.length ? top[parentIndex + 1].line : lineCount;
    if (parentEnd - parent.line > MAX_CHUNK_LINES) {
      out.push({ ...d, name: parent.ident && d.ident ? `${parent.ident}.${d.ident}` : d.name });
    }
  }
  return out;
}

/** Split a file into chunks at definitions/headings; long chunks become windows. */
export function chunkFile(path: string, text: string): Chunk[] {
  const lines = text.split('\n');
  const defs = nestDefinitions(definitions(path, lines), lines.length);
  const bounds: { line: number; name: string; ident?: string }[] = [];
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
          ident: b.ident,
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

const TEST_OR_DOC = /(^|\/)(tests?|docs?|__tests__)\/|(^|\/)test_[^/]+$|_test\.[^/]+$|\.(test|spec)\.[^/]+$|\.(rst|md|markdown)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]+$|_test\.[^/]+$|\.(test|spec)\.[^/]+$/i;

/** A request that creates something: only then is the family of existing ones the pattern to follow. */
const CREATES = /\b(add|adds|adding|new|create|creates|another|implement|introduce)\b/i;
/** Verb-like affixes shared by unrelated helpers (get_debug_flag, get_load_dotenv): never a family. */
const GENERIC_AFFIXES = new Set(['get', 'set', 'is', 'has', 'make', 'add', 'create', 'build', 'load', 'init', 'to', 'from', 'with', 'handle', 'do', 'on']);

/**
 * Families of existing definitions in implementation files: two or more top-level definitions whose
 * names start or end with the same request term (run_command, shell_command → "command"), plus the
 * line that registers them together, if any. Families with a registration site come first.
 * Only for requests that create something, and only for kinds the request names as a plain word
 * (not as part of an identifier the user mentioned).
 */
export function findFamilies(files: SourceFile[], terms: string[], query: string): Family[] {
  if (!CREATES.test(query)) {
    return [];
  }
  const plainWords = new Set(tokenize(query.replace(/[A-Za-z]+_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]+/g, ' ')));
  const termSet = new Set(terms.filter(t => plainWords.has(t) && !GENERIC_AFFIXES.has(t)));
  const families: Family[] = [];
  for (const f of files) {
    if (TEST_OR_DOC.test(f.path)) {
      continue;
    }
    const lines = f.text.split('\n');
    const groups = new Map<string, { members: string[]; short: string[] }>();
    for (const d of definitions(f.path, lines)) {
      if (d.indent || !d.ident) {
        continue;
      }
      const parts = splitIdentifier(d.ident).map(x => x.toLowerCase()).filter(Boolean);
      if (parts.length < 2) {
        continue;
      }
      for (const [affix, rest] of [
        [stem(parts[parts.length - 1]), parts.slice(0, -1)],
        [stem(parts[0]), parts.slice(1)],
      ] as [string, string[]][]) {
        if (termSet.has(affix) && affix.length >= 3) {
          const g = groups.get(affix) ?? { members: [], short: [] };
          if (!g.members.includes(d.ident)) {
            g.members.push(d.ident);
            g.short.push(rest.join('_'));
          }
          groups.set(affix, g);
        }
      }
    }
    for (const [kind, g] of groups) {
      if (g.members.length < 2) {
        continue;
      }
      const mention = (line: string): string | undefined =>
        g.members.find(m => new RegExp(`\\b${m}\\b`).test(line) && !new RegExp(`(def|class|function)\\s+${m}\\b`).test(line));
      let registeredAt: number | undefined;
      for (let i = 0; i < lines.length && registeredAt === undefined; i++) {
        const a = mention(lines[i]);
        if (a) {
          const near = lines.slice(i + 1, i + 3).map(mention);
          if (near.some(b => b && b !== a)) {
            registeredAt = i;
          }
        }
      }
      families.push({ kind, file: f.path, members: g.members, short: g.short, registeredAt });
    }
  }
  // The project's own name (FlaskClient, FlaskCliRunner in src/flask/) is a prefix, not a kind.
  const kinds = families.filter(f => !f.file.split('/').slice(0, -1).some(dir => stem(dir.toLowerCase()) === f.kind));
  kinds.sort(
    (a, b) => Number(b.registeredAt !== undefined) - Number(a.registeredAt !== undefined) || b.members.length - a.members.length,
  );
  // A family registered in one place is clearly a family; once one is found, weaker look-alikes go.
  return kinds[0]?.registeredAt !== undefined ? kinds.filter(f => f.registeredAt !== undefined) : kinds;
}

/** Extra score and reasons a chunk earns from the sibling pattern (0 when unrelated). */
function siblingBoost(chunk: Chunk, families: Family[]): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const text = chunk.lines.join('\n');
  const nameTokens = new Set(tokenize(chunk.ident ?? chunk.name));
  for (const fam of families) {
    const plural = `${fam.kind}s`;
    if (chunk.path === fam.file) {
      if (chunk.ident && fam.members.includes(chunk.ident)) {
        score += 4;
        reasons.push(`an existing ${fam.kind} like the requested one (${chunk.ident})`);
      }
      if (fam.registeredAt !== undefined && chunk.startLine - 1 <= fam.registeredAt && fam.registeredAt <= chunk.endLine - 1) {
        score += 5;
        reasons.push(`where the existing ${plural} are registered (${fam.members.join(', ')})`);
      }
      continue;
    }
    if (!TEST_OR_DOC.test(chunk.path)) {
      continue;
    }
    const named = fam.short.filter(sh => sh.length >= 3 && nameTokens.has(stem(sh)));
    if (TEST_PATH.test(chunk.path)) {
      // A test class named after a member (TestRoutes) is the pattern to copy for a new test.
      const testClass = chunk.ident && fam.short.find(sh => chunk.ident?.toLowerCase() === `test${sh.replace(/_/g, '')}`);
      if (testClass) {
        score += 4;
        reasons.push(`tests the existing ${fam.kind} "${testClass}"`);
      } else if (named.length) {
        score += 1.5;
        reasons.push(`tests the existing ${fam.kind} "${named[0]}"`);
      }
      continue;
    }
    const listed = fam.members.filter(m => new RegExp(`\\b${m}\\b`).test(text));
    // A heading that merely shares a word with a member ("URL Route Registrations" vs "routes")
    // counts only if the section is about this kind of thing too.
    if (named.length && !listed.length && !tokenize(text).includes(fam.kind)) {
      continue;
    }
    if (named.length) {
      score += 3;
      reasons.push(`documents the existing ${fam.kind} "${named[0]}"`);
    }
    if (listed.length) {
      score += 2;
      reasons.push(`names the existing ${plural} (${listed.join(', ')})`);
    }
  }
  return { score, reasons };
}

/** The sibling patterns, as sentences for the plan header. */
export function describeFamilies(families: Family[]): string[] {
  return families.map(
    f =>
      `existing ${f.kind}s in ${f.file}: ${f.members.join(', ')}` +
      (f.registeredAt !== undefined ? ` (registered together at line ${f.registeredAt + 1})` : '') +
      ` — a new ${f.kind} should follow them`,
  );
}

interface Scored {
  chunk: Chunk;
  score: number;
  reasons: string[];
  termHits: Map<string, number>;
  /** the part of the score that comes from the sibling pattern */
  pattern: number;
}

/** Share of the budget that the sibling pattern may take before the rest is ranked. */
export const PATTERN_SHARE = 0.6;

/** Score every chunk of the given files against the terms. */
export function scoreChunks(files: SourceFile[], terms: string[], families: Family[] = []): Scored[] {
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
      const nameTokens = new Set(tokenize(chunk.ident ?? chunk.name));
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
    // The sibling pattern stands on its own: the test of an existing command may not mention a
    // single word of the request.
    const sibling = siblingBoost(chunk, families);
    if (sibling.score > 0) {
      score += sibling.score;
      reasons.unshift(...sibling.reasons);
    }
    return { chunk, score, reasons, termHits: tf, pattern: sibling.score };
  });
}

/** One chunk per role of the sibling pattern (registration, member, test, each docs file). */
function patternRole(s: Scored): string {
  const why = s.reasons.join(' ');
  if (why.includes('are registered')) {
    return 'registration';
  }
  if (why.includes('like the requested one')) {
    return 'member';
  }
  if (TEST_PATH.test(s.chunk.path)) {
    return 'test';
  }
  return `docs:${s.chunk.path}`;
}

/** The first `size` lines of a chunk. */
function headWindow(chunk: Chunk, size: number): Chunk {
  if (chunk.lines.length <= size) {
    return chunk;
  }
  return { ...chunk, endLine: chunk.startLine + size - 1, lines: chunk.lines.slice(0, size) };
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
  /** sibling patterns found by findFamilies (retrieval passes them; default: none) */
  families?: Family[];
}

/** Rank and pack chunks into a plan within the token budget. */
export function buildPlan(query: string, terms: string[], files: SourceFile[], opts: PackOptions): ContextPlan {
  const budget = Math.min(MAX_BUDGET_TOKENS, Math.max(500, opts.budget));
  const maxFiles = opts.maxFiles ?? 8;
  const termSet = new Set(terms);
  const families = (opts.families ?? []).slice(0, 2);
  const scored = scoreChunks(files, terms, families).filter(s => s.score > 0);
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
      const size = Math.max(20, Math.floor((budget * 0.3 * 4) / 60));
      // A class keeps its head (class line, fixtures, first methods): that is the pattern to copy.
      chunk = /^class\s/.test(chunk.name) ? headWindow(chunk, size) : densestWindow(chunk, termSet, size);
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

  // 0. the sibling pattern first: registration, an existing member, its test and its docs. When a
  //    request adds a new member of a family, these show the agent exactly what to write and where.
  const patternChunks = scored.filter(s => s.pattern > 0).sort((a, b) => b.pattern - a.pattern || b.score - a.score);
  const roles = new Set<string>();
  const patternOrder: string[] = [];
  for (const s of patternChunks) {
    const role = patternRole(s);
    if (roles.has(role) || used >= budget * PATTERN_SHARE) {
      continue;
    }
    if (take(s)) {
      roles.add(role);
      if (!patternOrder.includes(s.chunk.path)) {
        patternOrder.push(s.chunk.path);
      }
    }
  }

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
    if (s.score >= top * 0.15 && !perFile.has(s.chunk.path)) {
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
    if (patternOrder.includes(p)) {
      // the sibling pattern leads, in reading order: code, then its test, then its docs
      const kindRank = TEST_PATH.test(p) ? 1 : TEST_OR_DOC.test(p) ? 2 : 0;
      return -100 + kindRank * 10 + patternOrder.indexOf(p);
    }
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
    patterns: describeFamilies(families),
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
    ...plan.patterns.map(p => `Pattern: ${p}`),
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
