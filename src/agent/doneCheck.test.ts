/**
 * Unit tests for the done-check (pure logic).
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doneCheckMessage, findGaps, isTestPath, type RepoFacts, type WorkStep } from './doneCheck';

const FLASK: RepoFacts = { rootFiles: ['CHANGES.rst', 'README.md', 'pyproject.toml'], hasDocs: true, hasLinter: true };
const write = (path: string): WorkStep => ({ kind: 'write', path });
const run = (command: string): WorkStep => ({ kind: 'command', command });

test('test paths are recognised', () => {
  for (const p of ['tests/test_cli.py', 'src/a/test_x.py', 'pkg/x_test.go', 'src/a.test.ts', 'web/__tests__/a.js']) {
    assert.ok(isTestPath(p), p);
  }
  assert.ok(!isTestPath('src/flask/cli.py'));
});

test('Task B run without a changelog entry: only the changelog is reported', () => {
  const steps = [
    write('src/flask/cli.py'),
    write('tests/test_cli.py'),
    write('docs/cli.rst'),
    run('uv run --frozen ruff check --no-fix src/flask/cli.py tests/test_cli.py'),
    run('uv run --frozen ruff format --check src/flask/cli.py tests/test_cli.py'),
    run('uv run --frozen pytest tests/test_cli.py -q'),
  ];
  const gaps = findGaps(steps, FLASK);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /CHANGES\.rst/);
});

test('a complete change has no gaps', () => {
  const steps = [
    write('src/flask/cli.py'),
    write('tests/test_cli.py'),
    write('docs/cli.rst'),
    write('CHANGES.rst'),
    run('uv run --frozen pytest tests/test_cli.py -q'),
    run('uv run --frozen ruff check --no-fix src/flask/cli.py'),
  ];
  assert.deepEqual(findGaps(steps, FLASK), []);
});

test('checks must run after the last change; tests and docs are required', () => {
  const steps = [write('src/flask/cli.py'), run('uv run --frozen pytest -q'), run('ruff check --no-fix .'), write('src/flask/cli.py')];
  const gaps = findGaps(steps, FLASK).join('\n');
  assert.match(gaps, /No test was added/);
  assert.match(gaps, /tests were not run after the last change/);
  assert.match(gaps, /linters were not run after the last change/);
  assert.match(gaps, /No documentation was changed/);
  assert.match(doneCheckMessage(['x']), /^Done-check by the editor/);
});

test('no source change (docs only, or nothing written): no done-check', () => {
  assert.deepEqual(findGaps([write('docs/cli.rst')], FLASK), []);
  assert.deepEqual(findGaps([run('pytest -q')], FLASK), []);
});

test('repositories without docs, linter or changelog are not asked for them', () => {
  const bare: RepoFacts = { rootFiles: ['setup.py'], hasDocs: false, hasLinter: false };
  assert.deepEqual(findGaps([write('pkg/mod.py'), write('tests/test_mod.py'), run('pytest -q')], bare), []);
});
