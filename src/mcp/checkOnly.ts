/**
 * Guard for run_command: every file change must go through a reviewed propose_write, so
 * formatters and linters only ever run in check mode, and commands that discard uncommitted
 * work are refused. Pure (no vscode import): used by the MCP tool and by the approval card, so
 * the user approves exactly the command that will run.
 */

export interface GuardedCommand {
  /** The command that will actually run. */
  command: string;
  /** What was changed to make it check-only (empty when unchanged). */
  notes: string[];
  /** Set when the command must not run at all. */
  refused?: string;
}

const REFUSALS: Array<[RegExp, string]> = [
  [
    /(?:^|[\s;&|(])git\s+(?:checkout|clean|reset|restore|stash)\b/,
    'git checkout/clean/reset/restore/stash can discard the user\'s uncommitted work, so they are not allowed. Use propose_write to change files.',
  ],
  [
    /\bpre-commit\s+run\b/,
    'pre-commit hooks can rewrite files without review. Run the individual checkers in check mode instead, e.g. "ruff check --no-fix <files>" and "ruff format --check <files>".',
  ],
];

/** Rewrites one command segment (no &&, ||, ;, |) so that it cannot modify files. */
function guardSegment(segment: string, notes: string[]): string {
  let s = segment;
  if (/\bruff\s+check\b/.test(s)) {
    const before = s;
    s = s.replace(/\s--(?:fix|fix-only|unsafe-fixes)(?![\w-])/g, '');
    if (!/\s--no-fix(?![\w-])/.test(s)) {
      s = s.replace(/\bruff\s+check\b/, 'ruff check --no-fix');
    }
    if (s !== before) {
      notes.push('ruff check runs with --no-fix');
    }
  }
  if (/\bruff\s+format\b/.test(s) && !/\s--(?:check|diff)(?![\w-])/.test(s)) {
    s = s.replace(/\bruff\s+format\b/, 'ruff format --check');
    notes.push('ruff format runs with --check');
  }
  if (/(?:^|[\s/])black(?=\s|$)/.test(s) && !/\s--(?:check|diff)(?![\w-])/.test(s)) {
    s = s.replace(/((?:^|[\s/])black)(?=\s|$)/, '$1 --check');
    notes.push('black runs with --check');
  }
  if (/(?:^|[\s/])isort(?=\s|$)/.test(s) && !/\s(?:--check-only|--check|--diff|-c)(?![\w-])/.test(s)) {
    s = s.replace(/((?:^|[\s/])isort)(?=\s|$)/, '$1 --check-only');
    notes.push('isort runs with --check-only');
  }
  if (/\bprettier\b/.test(s) && /\s(?:--write|-w)(?![\w-])/.test(s)) {
    s = s.replace(/\s(?:--write|-w)(?![\w-])/g, ' --check');
    notes.push('prettier runs with --check instead of --write');
  }
  if (/\beslint\b/.test(s) && /\s--fix(?![\w-])/.test(s)) {
    s = s.replace(/\s--fix(?![\w-])/g, '');
    notes.push('eslint runs without --fix');
  }
  return s;
}

export function guardCommand(command: string): GuardedCommand {
  for (const [pattern, reason] of REFUSALS) {
    if (pattern.test(command)) {
      return { command, notes: [], refused: reason };
    }
  }
  const notes: string[] = [];
  // Separators are kept (captured) so the command is reassembled unchanged around the segments.
  const parts = command.split(/(\s*(?:&&|\|\||;|\|)\s*)/);
  const guarded = parts.map((part, i) => (i % 2 === 1 ? part : guardSegment(part, notes))).join('');
  return { command: guarded, notes };
}
