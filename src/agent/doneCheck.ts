/**
 * Done-check: when the agent finishes a request that changed source files, the editor compares
 * what was actually done (reviewed writes, approved commands) with what a complete change in this
 * repository needs, and returns the gaps. The agent then gets one follow-up: fix each gap or say
 * why it does not apply. Models follow long instruction lists only some of the time; this check
 * does not depend on that. Pure logic (no vscode import) so it is unit-tested.
 */

export type WorkStep = { kind: 'write'; path: string } | { kind: 'command'; command: string };

export interface RepoFacts {
  /** names of the files in the workspace root */
  rootFiles: string[];
  /** the workspace has a docs/ (or doc/) folder */
  hasDocs: boolean;
  /** the project configures a linter or formatter (ruff, flake8, black, eslint, prettier, ...) */
  hasLinter: boolean;
}

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)\/|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DOC_PATH = /(?:^|\/)docs?\/|\.(?:rst|md|markdown|adoc|txt)$/i;
const SOURCE_PATH = /\.(?:py|pyi|[cm]?[jt]sx?|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift)$/;
const CHANGELOG = /^(?:CHANGES|CHANGELOG|HISTORY|NEWS|RELEASE[-_]?NOTES)(?:\.(?:rst|md|markdown|txt))?$/i;
const TEST_COMMAND = /\b(?:pytest|py\.test|unittest|tox|nox|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test|jest|vitest|mocha|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|rspec)\b/;
const LINT_COMMAND = /\b(?:ruff|flake8|pylint|black|isort|mypy|pyright|eslint|prettier|tsc|golangci-lint|rubocop|clippy)\b/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/** The gaps in a finished request, as instructions for the agent (empty: nothing missing). */
export function findGaps(steps: WorkStep[], repo: RepoFacts): string[] {
  const writes = steps.filter((s): s is Extract<WorkStep, { kind: 'write' }> => s.kind === 'write').map(s => s.path);
  const changedSource = writes.some(p => SOURCE_PATH.test(p) && !isTestPath(p) && !DOC_PATH.test(p));
  if (!changedSource) {
    return [];
  }
  const lastWrite = steps.reduce((last, s, i) => (s.kind === 'write' ? i : last), -1);
  const ranAfterLastWrite = (pattern: RegExp): boolean =>
    steps.some((s, i) => i > lastWrite && s.kind === 'command' && pattern.test(s.command));

  const gaps: string[] = [];
  if (!writes.some(isTestPath)) {
    gaps.push('No test was added or changed. Add or update a test that covers the new behaviour, next to the tests of similar features.');
  }
  if (!ranAfterLastWrite(TEST_COMMAND)) {
    gaps.push('The tests were not run after the last change. Run the tests of the changed area.');
  }
  if (repo.hasLinter && !ranAfterLastWrite(LINT_COMMAND)) {
    gaps.push("The project's linters were not run after the last change. Run them in check mode on the changed files and fix what they report.");
  }
  if (repo.hasDocs && !writes.some(p => DOC_PATH.test(p) && !CHANGELOG.test(p.split('/').pop() ?? ''))) {
    gaps.push('No documentation was changed. If the change is user-visible, document it next to the documentation of similar features.');
  }
  const changelog = repo.rootFiles.find(f => CHANGELOG.test(f));
  if (changelog && !writes.includes(changelog)) {
    gaps.push(
      `The project keeps a changelog (${changelog}) and it was not updated. If the change is user-visible, add an entry in its ` +
        'format: if its newest section is already released, start a new section for the next version at the very top, marked ' +
        'as unreleased like earlier sections. Add only new lines (do not retype existing ones) and do not invent issue numbers.',
    );
  }
  return gaps;
}

export function doneCheckMessage(gaps: string[]): string {
  return (
    'Done-check by the editor (automatic, once per request). Before you finish, these items look incomplete:\n' +
    gaps.map((g, i) => `${i + 1}. ${g}`).join('\n') +
    '\nFor each item, either do it now (with propose_write / run_command as usual) or, if it does not apply to this ' +
    'change, say why in one sentence. Then give your final answer again, listing every file changed and every check run.'
  );
}
