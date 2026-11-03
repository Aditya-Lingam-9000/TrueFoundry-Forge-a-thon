/**
 * Unit tests for the run_command guard (pure logic).
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardCommand } from './checkOnly';

test('tests and other commands are unchanged', () => {
  for (const cmd of ['uv run --frozen pytest tests/test_cli.py -q', 'npm test', 'mypy src/flask/cli.py', 'git diff --stat']) {
    assert.deepEqual(guardCommand(cmd), { command: cmd, notes: [] });
  }
});

test('ruff check always runs with --no-fix, even when --fix was asked for', () => {
  assert.equal(guardCommand('uv run --frozen ruff check src/flask/cli.py').command, 'uv run --frozen ruff check --no-fix src/flask/cli.py');
  assert.equal(guardCommand('ruff check --fix --unsafe-fixes .').command, 'ruff check --no-fix .');
  assert.equal(guardCommand('python -m ruff check --fix-only x.py').command, 'python -m ruff check --no-fix x.py');
  assert.deepEqual(guardCommand('ruff check --no-fix x.py'), { command: 'ruff check --no-fix x.py', notes: [] });
});

test('formatters run in check mode', () => {
  assert.equal(guardCommand('uv run --frozen ruff format src/flask/cli.py').command, 'uv run --frozen ruff format --check src/flask/cli.py');
  assert.equal(guardCommand('ruff format --diff x.py').command, 'ruff format --diff x.py');
  assert.equal(guardCommand('black src').command, 'black --check src');
  assert.equal(guardCommand('.venv/bin/black --diff src').command, '.venv/bin/black --diff src');
  assert.equal(guardCommand('isort src').command, 'isort --check-only src');
  assert.equal(guardCommand('npx prettier --write src').command, 'npx prettier --check src');
  assert.equal(guardCommand('npx eslint --fix src').command, 'npx eslint src');
});

test('every segment of a compound command is guarded; separators are kept', () => {
  const g = guardCommand('uv run --frozen ruff check a.py && uv run --frozen ruff format a.py; pytest -q');
  assert.equal(g.command, 'uv run --frozen ruff check --no-fix a.py && uv run --frozen ruff format --check a.py; pytest -q');
  assert.deepEqual(g.notes, ['ruff check runs with --no-fix', 'ruff format runs with --check']);
});

test('commands that discard work or rewrite files unreviewed are refused', () => {
  for (const cmd of ['git checkout -- .', 'git clean -fd', 'cd x && git reset --hard', 'git restore src/a.py', 'git stash', 'pre-commit run --all-files']) {
    assert.ok(guardCommand(cmd).refused, cmd);
  }
  assert.equal(guardCommand('git status --short').refused, undefined);
});
