/**
 * Unit tests for the diff/hunk engine and proposal edit matching (pure logic, no VS Code).
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyHunks, computeHunks } from './diff';

const base = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function replaceLine(text: string, n: number, value: string): string {
  const lines = text.split('\n');
  lines[n - 1] = value;
  return lines.join('\n');
}

test('no change → no hunks', () => {
  assert.deepEqual(computeHunks(base, base), []);
});

test('two distant changes → two hunks; accept all reproduces the proposal', () => {
  const proposed = replaceLine(replaceLine(base, 5, 'FIVE'), 30, 'THIRTY');
  const hunks = computeHunks(base, proposed);
  assert.equal(hunks.length, 2);
  assert.equal(applyHunks(base, hunks, [true, true]), proposed);
  assert.equal(applyHunks(base, hunks, [false, false]), base);
});

test('partial acceptance applies only the chosen hunk', () => {
  const proposed = replaceLine(replaceLine(base, 5, 'FIVE'), 30, 'THIRTY');
  const hunks = computeHunks(base, proposed);
  assert.equal(applyHunks(base, hunks, [true, false]), replaceLine(base, 5, 'FIVE'));
  assert.equal(applyHunks(base, hunks, [false, true]), replaceLine(base, 30, 'THIRTY'));
});

test('nearby changes merge into one hunk', () => {
  const proposed = replaceLine(replaceLine(base, 10, 'TEN'), 13, 'THIRTEEN');
  const hunks = computeHunks(base, proposed);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].added, 2);
  assert.equal(hunks[0].removed, 2);
});

test('pure insertion and deletion', () => {
  const lines = base.split('\n');
  const inserted = [...lines.slice(0, 20), 'NEW A', 'NEW B', ...lines.slice(20)].join('\n');
  let hunks = computeHunks(base, inserted);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].added, 2);
  assert.equal(applyHunks(base, hunks, [true]), inserted);

  const deleted = [...lines.slice(0, 3), ...lines.slice(8)].join('\n');
  hunks = computeHunks(base, deleted);
  assert.equal(hunks[0].removed, 5);
  assert.equal(applyHunks(base, hunks, [true]), deleted);
});

test('new file (empty original)', () => {
  const content = 'a\nb\nc\n';
  const hunks = computeHunks('', content);
  assert.equal(hunks.length, 1);
  assert.equal(applyHunks('', hunks, [true]), content);
});

test('change at the very start and end of a file', () => {
  const proposed = replaceLine(replaceLine(base, 1, 'FIRST'), 40, 'LAST');
  const hunks = computeHunks(base, proposed);
  assert.equal(applyHunks(base, hunks, hunks.map(() => true)), proposed);
});

test('trailing newline is preserved exactly', () => {
  const a = 'x\ny';
  const b = 'x\nz';
  const hunks = computeHunks(a, b);
  assert.equal(applyHunks(a, hunks, [true]), b);
});

test('many hunks: every subset applies consistently', () => {
  let proposed = base;
  for (const n of [2, 12, 22, 32]) {
    proposed = replaceLine(proposed, n, `CHANGED ${n}`);
  }
  const hunks = computeHunks(base, proposed);
  assert.equal(hunks.length, 4);
  for (let mask = 0; mask < 16; mask++) {
    const accepted = hunks.map((_, i) => Boolean(mask & (1 << i)));
    let expected = base;
    [2, 12, 22, 32].forEach((n, i) => {
      if (accepted[i]) {
        expected = replaceLine(expected, n, `CHANGED ${n}`);
      }
    });
    assert.equal(applyHunks(base, hunks, accepted), expected, `mask ${mask}`);
  }
});
