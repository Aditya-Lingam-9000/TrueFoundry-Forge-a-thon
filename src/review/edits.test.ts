/**
 * Unit tests for propose_write argument normalisation and exact-text edits (pure logic).
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEdits, MAX_CONTENT_REWRITE_LINES, normalizeProposeArgs, parseProposeArgs, stripLineNumbers } from './edits';

const FILE = [
  'def get_debug_flag() -> bool:',
  '    """Docstring."""',
  '    val = os.environ.get("FLASK_DEBUG")',
  '    return bool(val and val.lower() not in {"0", "false", "no"})',
  '',
  '',
  'def get_load_dotenv(default: bool = True) -> bool:',
  '    val = os.environ.get("FLASK_SKIP_DOTENV")',
  '    return val.lower() in ("0", "false", "no")',
  '',
].join('\n');

const OLD = '    return bool(val and val.lower() not in {"0", "false", "no"})';
const NEW = '    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})';

test('edits as a list', () => {
  const a = normalizeProposeArgs({ path: 'x.py', edits: [{ old_text: OLD, new_text: NEW }] });
  assert.deepEqual(a.edits, [{ old_text: OLD, new_text: NEW }]);
});

test('edits as a single object', () => {
  const a = normalizeProposeArgs({ path: 'x.py', edits: { old_text: OLD, new_text: NEW } });
  assert.equal(a.edits?.length, 1);
});

test('edits as a JSON string, with alias keys', () => {
  const a = normalizeProposeArgs({ path: 'x.py', edits: JSON.stringify([{ old_string: OLD, new_string: NEW }]) });
  assert.deepEqual(a.edits, [{ old_text: OLD, new_text: NEW }]);
});

test('top-level old_text / new_text', () => {
  const a = normalizeProposeArgs({ path: 'x.py', old_text: OLD, new_text: NEW, description: 'd' });
  assert.deepEqual(a.edits, [{ old_text: OLD, new_text: NEW }]);
  assert.equal(a.description, 'd');
});

test('raw arguments string parses the same way as the MCP object', () => {
  const obj = { path: 'x.py', edits: JSON.stringify({ old_text: OLD, new_text: NEW }) };
  assert.deepEqual(parseProposeArgs(JSON.stringify(obj)), normalizeProposeArgs(obj));
});

test('missing path and broken edits are rejected', () => {
  assert.throws(() => normalizeProposeArgs({ edits: [] }), /path/);
  assert.throws(() => normalizeProposeArgs({ path: 'x', edits: 'not json' }), /valid JSON/);
  assert.throws(() => normalizeProposeArgs({ path: 'x', edits: [{ old_text: 'a' }] }), /old_text/);
});

test('exact single match is replaced; the look-alike function is untouched', () => {
  const out = applyEdits(FILE, [{ old_text: OLD, new_text: NEW }], 'helpers.py');
  assert.ok(out.includes('"off", "n"'));
  assert.ok(out.includes('return val.lower() in ("0", "false", "no")'));
});

test('ambiguous old_text is refused', () => {
  assert.throws(() => applyEdits(FILE, [{ old_text: '    val = os.environ.get(', new_text: 'x' }], 'f'), /2 times/);
});

test('old_text copied with read_file line numbers still applies', () => {
  const numbered = `   31      val = os.environ.get("FLASK_DEBUG")\n   32  ${OLD}`;
  const newNumbered = `   31      val = os.environ.get("FLASK_DEBUG")\n   32  ${NEW}`;
  const out = applyEdits(FILE, [{ old_text: numbered, new_text: newNumbered }], 'helpers.py');
  assert.ok(out.includes('"off", "n"'));
  assert.ok(!/^\s*\d+ {2}/m.test(out.split('\n')[3]));
});

test('wrong indentation falls back to an indentation-insensitive match', () => {
  const out = applyEdits(FILE, [{ old_text: OLD.trim(), new_text: NEW.trim() }], 'helpers.py');
  assert.ok(out.includes(NEW));
});

test('text that is not in the file is refused with a helpful message', () => {
  assert.throws(() => applyEdits(FILE, [{ old_text: 'nope', new_text: 'x' }], 'f'), /not found/);
});

test('stripLineNumbers only strips when every line is numbered', () => {
  assert.equal(stripLineNumbers('   1  a\n   2  b'), 'a\nb');
  assert.equal(stripLineNumbers('   1  a\nb'), '   1  a\nb');
});

test('rewrite limit is a sane size', () => {
  assert.ok(MAX_CONTENT_REWRITE_LINES >= 50 && MAX_CONTENT_REWRITE_LINES <= 500);
});
