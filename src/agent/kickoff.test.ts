/**
 * Unit tests for the scout kickoff note (pure logic).
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoutInput, scoutKickoff } from './kickoff';

const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, ' +
  'masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in ' +
  'flask --help, be covered by a test, and be documented alongside the other built-in commands.';

test('a multi-file creation request gets the scout as its first step, with the request word for word', () => {
  const note = scoutKickoff(TASK_B, []);
  assert.ok(note);
  assert.match(note, /create_sub_agent with name "scout"/);
  assert.ok(note.includes(`TASK: ${TASK_B}`), 'the scout sees the exact request');
  assert.match(scoutInput(TASK_B), /retrieve_context with the task and budget_tokens 4500/);
  assert.match(scoutInput(TASK_B), /at most 8 tool calls/);
});

test('a sibling pattern alone is enough to call for the scout', () => {
  assert.ok(scoutKickoff('Add a new built-in command that lists the blueprints', ['existing commands in src/flask/cli.py: …']));
});

test('questions, one-file fixes and requests without creation get no kickoff', () => {
  assert.equal(scoutKickoff('Where is get_debug_flag defined, and what does it return when FLASK_DEBUG=off?', []), undefined);
  assert.equal(scoutKickoff('In src/flask/helpers.py, make get_debug_flag treat off and n as false.', []), undefined);
  assert.equal(scoutKickoff('Explain how the tests for the CLI are organised', []), undefined);
});
