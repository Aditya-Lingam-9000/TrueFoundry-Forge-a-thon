/**
 * retrieve_context I/O: find candidate files for a request, read them, and let rank.ts choose the
 * chunks that fit the token budget.
 *
 *   candidates = files with term hits (ripgrep), weighted by how rare each term is across files
 *              + files whose path contains a term
 *              + test/doc companions of the best implementation files (tests/test_<name>.py, docs/<name>.rst, …)
 *              + sibling pattern: if the candidates contain a family of existing definitions of the requested
 *                kind (run_command, shell_command, … for "command"), the files that name those members
 *                (their tests and docs) and the companions of the family's file
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EXCLUDE_GLOB, searchWorkspace, toRel, workspaceRoot } from '../mcp/workspace';
import { buildPlan, extractTerms, findFamilies, tokenize, type ContextPlan, type SourceFile } from './rank';

const MAX_CANDIDATES = 18;
/** files added because they name the members of a sibling family */
const MAX_SIBLING_FILES = 6;
const MAX_FILE_BYTES = 400_000;
const TEXT_EXT =
  /\.(py|pyi|js|jsx|ts|tsx|mjs|cjs|json|toml|cfg|ini|ya?ml|md|rst|txt|html|css|scss|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|sh|sql)$/i;

export async function retrieveContext(query: string, budget: number): Promise<ContextPlan> {
  const terms = extractTerms(query);
  if (terms.length === 0) {
    return buildPlan(query, terms, [], { budget });
  }
  const all = (await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, 20000))
    .map(u => toRel(u.fsPath))
    .filter(p => TEXT_EXT.test(p));
  const totalFiles = Math.max(1, all.length);
  const score = new Map<string, number>();
  const bump = (file: string, s: number): void => {
    score.set(file, (score.get(file) ?? 0) + s);
  };

  // 1. term hits, weighted by rarity across files (a term in every file says little)
  for (const term of terms.slice(0, 10)) {
    const { hits } = await searchWorkspace({ query: term, isRegex: false, caseSensitive: false, maxResults: 400 });
    const perFile = new Map<string, number>();
    for (const h of hits) {
      if (TEXT_EXT.test(h.file)) {
        perFile.set(h.file, (perFile.get(h.file) ?? 0) + 1);
      }
    }
    const idf = Math.log(1 + totalFiles / (1 + perFile.size));
    for (const [file, n] of perFile) {
      bump(file, idf * Math.log2(1 + n));
    }
  }
  // 2. path matches
  const termSet = new Set(terms);
  for (const file of all) {
    const hit = tokenize(file).filter(t => termSet.has(t)).length;
    if (hit) {
      bump(file, 2 * hit);
    }
  }

  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const candidates = ranked.slice(0, MAX_CANDIDATES);

  // 3. companions of the best implementation files: their tests and docs
  const companionOf = new Map<string, string>();
  for (const file of candidates.filter(f => !isTestOrDoc(f)).slice(0, 5)) {
    addCompanions(file, all, candidates, companionOf);
  }

  // 4. read
  const files = await readFiles(candidates, companionOf);

  // 5. sibling pattern: existing members of the requested kind, and the files that name them
  const families = findFamilies(files, terms, query);
  const family = families[0];
  if (family) {
    const extra: string[] = [];
    addCompanions(family.file, all, extra, companionOf);
    const pattern = family.members.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const { hits } = await searchWorkspace({ query: `\\b(${pattern})\\b`, isRegex: true, caseSensitive: true, maxResults: 200 });
    const counts = new Map<string, number>();
    for (const h of hits) {
      if (TEXT_EXT.test(h.file) && h.file !== family.file) {
        counts.set(h.file, (counts.get(h.file) ?? 0) + 1);
      }
    }
    extra.push(...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, MAX_SIBLING_FILES));
    const have = new Set(files.map(f => f.path));
    files.push(...(await readFiles([...new Set(extra)].filter(f => !have.has(f)), companionOf)));
  }
  return buildPlan(query, terms, files, { budget, families });
}

/** Test and doc companions of an implementation file (tests/test_<base>.py, docs/<base>.rst, …). */
function addCompanions(file: string, all: string[], into: string[], companionOf: Map<string, string>): void {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  if (base.length < 3 || base === '__init__') {
    return;
  }
  for (const other of all) {
    const ob = path.basename(other).toLowerCase();
    const isCompanion =
      ob === `test_${base}.py` ||
      ob === `${base}_test.py` ||
      ob.startsWith(`${base}.test.`) ||
      ob.startsWith(`${base}.spec.`) ||
      (/(^|\/)docs?\//.test(other) && (ob === `${base}.rst` || ob === `${base}.md`));
    if (isCompanion && other !== file && !companionOf.has(other)) {
      companionOf.set(other, file);
      if (!into.includes(other)) {
        into.push(other);
      }
    }
  }
}

/** Read candidate files (open editors first, so unsaved text counts); skip large or binary files. */
async function readFiles(candidates: string[], companionOf: Map<string, string>): Promise<SourceFile[]> {
  const root = workspaceRoot();
  const openDocs = new Map(vscode.workspace.textDocuments.map(d => [d.uri.fsPath, d]));
  const files: SourceFile[] = [];
  for (const rel of candidates) {
    const abs = path.join(root, rel);
    try {
      const doc = openDocs.get(abs);
      let text: string;
      if (doc) {
        text = doc.getText();
      } else {
        const stat = await fs.promises.stat(abs);
        if (stat.size > MAX_FILE_BYTES) {
          continue;
        }
        text = await fs.promises.readFile(abs, 'utf8');
      }
      if (text.includes('\u0000')) {
        continue;
      }
      files.push({ path: rel, text: text.replace(/\r\n/g, '\n'), companionOf: companionOf.get(rel), open: Boolean(doc) });
    } catch {
      // unreadable: skip
    }
  }
  return files;
}

function isTestOrDoc(file: string): boolean {
  return /(^|\/)(tests?|docs?)\//.test(file) || /(^|\/)test_[^/]+$|_test\.[^/]+$|\.(test|spec)\.[^/]+$/.test(file);
}
