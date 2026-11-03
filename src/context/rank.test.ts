/**
 * Unit tests for context ranking (pure logic). Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPlan,
  chunkFile,
  definitions,
  estimateTokens,
  extractTerms,
  findFamilies,
  MAX_BUDGET_TOKENS,
  MAX_RENDER_CHARS,
  renderPlan,
  type SourceFile,
} from './rank';

const pad = (n: number, prefix = '    # filler'): string => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n');

const CLI_PY = [
  'import click',
  '',
  'class FlaskGroup(click.Group):',
  '    def __init__(self, add_default_commands=True):',
  '        if add_default_commands:',
  '            self.add_command(run_command)',
  '            self.add_command(shell_command)',
  '            self.add_command(routes_command)',
  pad(40),
  '',
  '@click.command("run", short_help="Run a development server.")',
  'def run_command():',
  '    """Run a local development server."""',
  pad(60),
  '',
  '@click.command("shell", short_help="Run a shell in the app context.")',
  '@with_appcontext',
  'def shell_command():',
  '    """Run an interactive Python shell in the context of a given Flask application."""',
  pad(20),
  '',
  '@click.command("routes", short_help="Show the routes for the app.")',
  '@with_appcontext',
  'def routes_command(sort, all_methods):',
  '    """Show all registered routes with endpoints and methods."""',
  pad(30),
  '',
  'cli = FlaskGroup(name="flask")',
  '',
].join('\n');

const TEST_CLI_PY = [
  'from flask.cli import FlaskGroup',
  '',
  'class TestRoutes:',
  '    def test_simple(self, runner):',
  '        cli = FlaskGroup(create_app=lambda: app)',
  '        result = runner.invoke(cli, ["routes"])',
  '        assert result.exit_code == 0',
  '',
  'def test_help_echo_loading_error():',
  '    result = runner.invoke(cli, ["--help"])',
  '    assert "Run a development server" in result.output',
  '',
].join('\n');

const CLI_RST = [
  'Command Line Interface',
  '======================',
  '',
  'Installing Flask installs the ``flask`` script, a Click command line interface.',
  '',
  'Run the Development Server',
  '--------------------------',
  '',
  'The run command will start the development server.',
  '',
  'Open a Shell',
  '------------',
  '',
  'The shell command opens an interactive Python shell in the app context.',
  '',
].join('\n');

const SESSIONS_PY = ['class SecureCookieSessionInterface:', '    """Cookie sessions."""', pad(200, '    x =')].join('\n');

const FILES: SourceFile[] = [
  { path: 'src/flask/cli.py', text: CLI_PY },
  { path: 'tests/test_cli.py', text: TEST_CLI_PY, companionOf: 'src/flask/cli.py' },
  { path: 'docs/cli.rst', text: CLI_RST, companionOf: 'src/flask/cli.py' },
  { path: 'src/flask/sessions.py', text: SESSIONS_PY },
];

const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, ' +
  'masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in ' +
  'flask --help, be covered by a test, and be documented alongside the other built-in commands.';

test('terms keep the domain words and drop filler', () => {
  const terms = extractTerms(TASK_B);
  for (const t of ['cli', 'command', 'config', 'json', 'help', 'test']) {
    assert.ok(terms.includes(t), `missing ${t} in ${terms.join(',')}`);
  }
  for (const t of ['the', 'add', 'must', 'alongside']) {
    assert.ok(!terms.includes(t), `kept filler ${t}`);
  }
});

test('identifiers in the request become terms (snake_case parts too)', () => {
  const terms = extractTerms('Where is get_debug_flag defined?');
  assert.ok(terms.includes('get_debug_flag'));
  assert.ok(terms.includes('debug'));
});

test('python files are chunked at definitions, decorators included', () => {
  const defs = definitions('src/flask/cli.py', CLI_PY.split('\n'));
  const names = defs.map(d => d.name);
  assert.ok(names.includes('class FlaskGroup'));
  assert.ok(names.includes('def routes_command'));
  const routes = chunkFile('src/flask/cli.py', CLI_PY).find(c => c.name === 'def routes_command');
  assert.ok(routes);
  assert.ok(routes.lines[0].startsWith('@click.command("routes"'), 'decorator kept with its function');
});

test('rst files are chunked at headings', () => {
  const names = chunkFile('docs/cli.rst', CLI_RST).map(c => c.name);
  assert.deepEqual(names, ['Command Line Interface', 'Run the Development Server', 'Open a Shell']);
});

test('Task B: implementation, tests and docs are all chosen; unrelated code is not', () => {
  const plan = buildPlan(TASK_B, extractTerms(TASK_B), FILES, { budget: 3000 });
  const paths = new Set(plan.items.map(i => i.path));
  assert.ok(paths.has('src/flask/cli.py'));
  assert.ok(paths.has('tests/test_cli.py'));
  assert.ok(paths.has('docs/cli.rst'));
  assert.ok(!paths.has('src/flask/sessions.py'));
  assert.ok(plan.used <= plan.budget);
  assert.ok(plan.items.every(i => i.reasons.length > 0));
  // the implementation file is ranked first
  assert.equal(plan.items[0].path, 'src/flask/cli.py');
});

test('the budget is a hard limit, even when small', () => {
  const plan = buildPlan(TASK_B, extractTerms(TASK_B), FILES, { budget: 600 });
  assert.ok(plan.used <= plan.budget);
  assert.ok(plan.items.length >= 1);
  assert.equal(plan.used, plan.items.reduce((n, i) => n + i.tokens, 0));
  assert.ok(plan.items.every(i => i.tokens === estimateTokens(i.lines)));
});

test('rendered plan lists reasons and numbered code', () => {
  const text = renderPlan(buildPlan(TASK_B, extractTerms(TASK_B), FILES, { budget: 3000 }));
  assert.match(text, /Budget 3000 tokens · used \d+/);
  assert.match(text, /Chosen \(why\):/);
  assert.match(text, /src\/flask\/cli\.py:\d+-\d+/);
  assert.match(text, /^\s+\d+ {2}/m);
});

test('rendered plan never exceeds the tool-result size limit, even with a huge budget', () => {
  const big: SourceFile[] = Array.from({ length: 12 }, (_, i) => ({
    path: `src/pkg/cli_${i}.py`,
    text: Array.from({ length: 30 }, (_, k) => `def command_${k}():\n    """cli command ${k} for flask config help"""\n${pad(25, '    x = "padding text for size"')}`).join('\n'),
  }));
  const plan = buildPlan(TASK_B, extractTerms(TASK_B), big, { budget: 100000 });
  assert.ok(plan.budget <= MAX_BUDGET_TOKENS);
  assert.ok(renderPlan(plan).length <= MAX_RENDER_CHARS + 500);
});

test('look-alike files and changelogs cannot crowd out the implementation that owns the tests/docs', () => {
  const CONFIG_PY = [
    'class Config(dict):',
    '    """Works exactly like a dict but provides ways to fill it from files or special dictionaries.',
    '    The configuration is loaded from JSON; any key, secret key, token or password is kept as is."""',
    pad(30, '    # config configuration key secret token password json loaded'),
  ].join('\n');
  const CHANGES = ['Version 0.11', '------------', pad(40, '-   config json key secret token cli command help test flask configuration')].join('\n');
  const files: SourceFile[] = [
    ...FILES,
    { path: 'src/flask/config.py', text: CONFIG_PY },
    { path: 'CHANGES.rst', text: CHANGES },
  ];
  const plan = buildPlan(TASK_B, extractTerms(TASK_B), files, { budget: 2500 });
  const paths = plan.items.map(i => i.path);
  assert.ok(paths.includes('src/flask/cli.py'), `cli.py missing from ${paths.join(', ')}`);
  assert.ok(paths.indexOf('src/flask/cli.py') < Math.max(0, paths.indexOf('CHANGES.rst')) || !paths.includes('CHANGES.rst'));
});

test('no matches → a helpful empty plan', () => {
  const plan = buildPlan('zzz qqq', extractTerms('zzz qqq'), FILES, { budget: 3000 });
  assert.equal(plan.items.length, 0);
  assert.match(renderPlan(plan), /No relevant code found/);
});

test('a small class stays one chunk; methods of a large class are named after it', () => {
  const small = chunkFile('tests/test_cli.py', TEST_CLI_PY);
  assert.ok(small.some(c => c.name === 'class TestRoutes' && c.lines.some(l => l.includes('runner.invoke(cli, ["routes"])'))));
  const big = ['class Big:', '    def __init__(self):', pad(70), '    def other(self):', pad(70)].join('\n');
  const names = chunkFile('src/big.py', big).map(c => c.name);
  assert.ok(names.includes('Big.__init__') && names.includes('Big.other'), names.join(', '));
});

test('sibling pattern: adding a command brings the existing commands, their registration, test and docs', () => {
  const CONFIG_PY = [
    'class Config(dict):',
    '    """The configuration: any key, secret key, token or password."""',
    pad(30, '    # config configuration key secret token password json loaded'),
  ].join('\n');
  const files: SourceFile[] = [...FILES, { path: 'src/flask/config.py', text: CONFIG_PY }];
  const terms = extractTerms(TASK_B);
  const families = findFamilies(files, terms, TASK_B);
  assert.equal(families[0]?.kind, 'command');
  assert.deepEqual(families[0].members, ['run_command', 'shell_command', 'routes_command']);
  assert.ok(families[0].registeredAt !== undefined, 'registration site found');

  const plan = buildPlan(TASK_B, terms, files, { budget: 2500, families });
  const why = (pred: (i: (typeof plan.items)[number]) => boolean): string =>
    plan.items.filter(pred).map(i => i.reasons.join(' ')).join(' | ');
  assert.match(why(i => i.path === 'src/flask/cli.py'), /where the existing commands are registered/);
  assert.match(why(i => i.path === 'src/flask/cli.py'), /an existing command like the requested one/);
  assert.match(why(i => i.name === 'class TestRoutes'), /tests the existing command "routes"/);
  assert.match(why(i => i.path === 'docs/cli.rst'), /documents the existing command/);
  assert.equal(plan.items[0].path, 'src/flask/cli.py', 'the pattern leads, code first');
  assert.ok(plan.used <= plan.budget);
  assert.match(renderPlan(plan), /Pattern: existing commands in src\/flask\/cli\.py: run_command, shell_command, routes_command/);
});

test('questions and generic prefixes never make a family', () => {
  const HELPERS = ['def get_debug_flag():', '    return 1', '', 'def get_load_dotenv():', '    return 2', '', 'x = [get_debug_flag,', '     get_load_dotenv]'].join('\n');
  const files: SourceFile[] = [{ path: 'src/flask/helpers.py', text: HELPERS }];
  const question = 'Where is get_debug_flag defined, and what does it return?';
  assert.deepEqual(findFamilies(files, extractTerms(question), question), []);
  const generic = 'Add a new get helper next to get_debug_flag';
  assert.deepEqual(findFamilies(files, extractTerms(generic), generic), []);
});

test("the project's own name is not a kind, and unregistered look-alikes give way to a registered family", () => {
  const TESTING_PY = ['class FlaskClient:', '    pass', '', 'class FlaskCliRunner:', '    pass', ''].join('\n');
  const files: SourceFile[] = [...FILES, { path: 'src/flask/testing.py', text: TESTING_PY }];
  const families = findFamilies(files, extractTerms(TASK_B), TASK_B);
  assert.deepEqual(families.map(f => f.kind), ['command']);
});

test('a heading that only shares a word with a member is not taken for its docs', () => {
  const API_RST = ['URL Route Registrations', '-----------------------', '', 'Generally there are three ways to define rules for the routing system.', ''].join('\n');
  const files: SourceFile[] = [...FILES, { path: 'docs/api.rst', text: API_RST }];
  const terms = extractTerms(TASK_B);
  const plan = buildPlan(TASK_B, terms, files, { budget: 4000, families: findFamilies(files, terms, TASK_B) });
  assert.ok(!plan.items.some(i => i.path === 'docs/api.rst' && i.reasons.some(r => r.startsWith('documents'))));
});
