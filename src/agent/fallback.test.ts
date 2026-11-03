/**
 * Unit tests for the model fallback decisions (pure logic).
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isModelFailure, isTransient, modelChain, nextAction, RETRY_DELAY_MS, shortReason } from './fallback';

const CHAIN = ['nvidia/nemotron-3-5-super', 'backup/model-b', 'kaggle/model-c'];

test('TrueForge model errors are recognised; agent errors are not', () => {
  assert.ok(isModelFailure('[Model Error] Cannot connect to API: getaddrinfo ENOTFOUND x.trycloudflare.com'));
  assert.ok(isModelFailure('[Model Error] 401 Unauthorized'));
  assert.ok(isModelFailure('Too many requests (429)'));
  assert.ok(!isModelFailure('Iteration limit of 80 reached'));
  assert.ok(!isModelFailure('Tool forge-editor failed'));
});

test('transient failures are retried, broken configuration is not', () => {
  assert.ok(isTransient('[Model Error] 429 Too Many Requests'));
  assert.ok(isTransient('[Model Error] 503 Service Unavailable'));
  assert.ok(isTransient('[Model Error] ETIMEDOUT'));
  assert.ok(!isTransient('[Model Error] 401 Unauthorized'));
  assert.ok(!isTransient('[Model Error] Cannot connect to API: getaddrinfo ENOTFOUND host'));
  assert.ok(!isTransient('[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9'));
  assert.ok(!isTransient('[Model Error] Invalid API key provided'));
});

test('invalid key or unreachable endpoint: switch to the next model at once', () => {
  assert.deepEqual(nextAction('[Model Error] 401 Unauthorized', CHAIN[0], CHAIN, new Set([CHAIN[0]]), false), {
    kind: 'switch',
    model: 'backup/model-b',
  });
  assert.deepEqual(nextAction('[Model Error] Cannot connect to API: ENOTFOUND', CHAIN[1], CHAIN, new Set(CHAIN.slice(0, 2)), false), {
    kind: 'switch',
    model: 'kaggle/model-c',
  });
});

test('busy model: one retry with a delay, then the next model', () => {
  const tried = new Set([CHAIN[0]]);
  assert.deepEqual(nextAction('[Model Error] 429', CHAIN[0], CHAIN, tried, false), { kind: 'retry', delayMs: RETRY_DELAY_MS });
  assert.deepEqual(nextAction('[Model Error] 429', CHAIN[0], CHAIN, tried, true), { kind: 'switch', model: 'backup/model-b' });
});

test('every model failed, or no fallback configured: give up with a reason', () => {
  assert.equal(nextAction('[Model Error] 401', CHAIN[2], CHAIN, new Set(CHAIN), true).kind, 'give-up');
  const single = modelChain('nvidia/nemotron-3-5-super', []);
  const a = nextAction('[Model Error] 401', single[0], single, new Set(single), false);
  assert.deepEqual(a, { kind: 'give-up', reason: 'no fallback model is configured' });
  assert.equal(nextAction('Iteration limit reached', CHAIN[0], CHAIN, new Set([CHAIN[0]]), false).kind, 'give-up');
});

test('model chain: primary first, no duplicates or blanks; readable reasons', () => {
  assert.deepEqual(modelChain('a/x', ['b/y', 'a/x', ' ', 'c/z ']), ['a/x', 'b/y', 'c/z']);
  assert.equal(shortReason('The model call failed: [Model Error] 401 Unauthorized'), '401 Unauthorized');
});

test('the exact messages TrueForge 0.182 reports switch models at once', () => {
  for (const msg of [
    '[Model Error] Request failed (401): Unauthorized',
    '[Model Error] Request failed (403): Forbidden',
    '[Model Error] Cannot connect to API: bad port',
  ]) {
    assert.ok(isModelFailure(msg), msg);
    assert.equal(nextAction(msg, CHAIN[0], CHAIN, new Set([CHAIN[0]]), false).kind, 'switch', msg);
  }
});
