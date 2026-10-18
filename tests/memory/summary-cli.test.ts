import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSummaryArgs, summaryMain } from '../../src/local-runtime/summary-cli.js';
import { validateWeeklySummary } from '../../src/memory/weekly-summary.js';
import { fixture } from './fixture.js';

// HOST ONLY: do not select this suite in a native no-fork sandbox.
const executable = fileURLToPath(new URL('../../src/local-runtime/summary-cli.js', import.meta.url));
const due = Date.UTC(2026, 9, 18, 4, 30);
function invoke(args: string[]) {
  let stdout = '', stderr = '';
  const code = summaryMain(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, () => due);
  return { code, stdout, stderr };
}

test('parser accepts only exact command flags and canonical decimal safe integers', () => {
  assert.deepEqual(parseSummaryArgs(['--help']), { command: 'help' });
  const owner = resolve('owner'), project = join(owner, 'project'), state = join(owner, 'private');
  const common = ['--workspace', project, '--state-dir', state];
  const valid = parseSummaryArgs(['generate', ...common, '--due', '2000', '--lower', '0', '--upper', '42', '--page-size', '100']);
  assert.ok(valid.command === 'generate');
  assert.equal(valid.workspace, project); assert.equal(valid.stateDirectory, state);
  for (const args of [[], ['wat'], ['status', ...common, '--provider', 'x'], ['config', ...common],
    ['config', ...common, '--enable', 'false'], ['status', '--workspace', project],
    ['status', ...common, '--workspace', join(owner, 'duplicate')], ['status', ...common, '--help'],
    ['status', ...common, 'extra'], ['prepare', ...common, '--reservation', 'r', '--task', 't', '--provenance', 'native'],
    ['generate', ...common, '--due', '1', '--lower', '0', '--page-size', '101'],
    ['generate', ...common, '--due', '1', '--lower', '0', '--upper', '0', '--account', 'x'],
    ['generate', ...common, '--due', '1', '--lower', '0', '--max-bytes', '65537'],
    ['status', '--workspace', `${owner}${sep}..${sep}project`, '--state-dir', state]]) assert.throws(() => parseSummaryArgs(args));
  for (const value of ['NaN', 'Infinity', '-1', '1.5', '1e3', '01', ' 1', '9007199254740992', '']) {
    assert.throws(() => parseSummaryArgs(['generate', ...common, '--due', value, '--lower', '0']));
  }
});

test('exported main validates before output and preserves a committed tick across stdout failure', () => {
  const f = fixture(), common = ['--workspace', f.root, '--state-dir', f.directory];
  try {
    assert.equal(invoke(['status', ...common]).code, 0);
    assert.equal((JSON.parse(invoke(['status', ...common]).stdout) as { enabled: boolean }).enabled, false);
    assert.equal(invoke(['config', ...common, '--enable', 'true']).code, 0);
    let errors = '';
    assert.equal(summaryMain(['tick', ...common], { stdout: () => { throw new Error('interrupted output'); }, stderr: text => { errors += text; } }, () => due), 2);
    assert.equal(errors, 'Weekly command failed: invalid owner input. Use --help.\n');
    assert.doesNotMatch(errors, /interrupted output/);
    const repaired = invoke(['result', ...common]); assert.equal(repaired.code, 0);
    const summary = validateWeeklySummary(JSON.parse(repaired.stdout)); assert.equal(summary.dueAt, due);
    assert.equal(summary.dependencyCount, 0);
    assert.equal((JSON.parse(invoke(['tick', ...common]).stdout) as { status: string }).status, 'not-due');
    assert.deepEqual(invoke(['result', ...common, '--due', String(due)]), repaired);
    const bad = invoke(['generate', ...common, '--due', '1', '--lower', '0', '--max-bytes', '1']);
    assert.equal(bad.code, 2); assert.equal(bad.stdout, ''); assert.match(bad.stderr, /failed/);
    assert.equal(invoke(['disable', ...common]).code, 0);
    assert.equal((JSON.parse(invoke(['tick', ...common]).stdout) as { status: string }).status, 'disabled');
  } finally { f.dispose(); }
});

test('host compiled entry runs help, restart-stable prepare, generate and explicit opt-in controls', () => {
  const f = fixture(), common = ['--workspace', f.root, '--state-dir', f.directory];
  const run = (args: string[]) => spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8', timeout: 10000 });
  try {
    const help = run(['--help']); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /no providers/);
    const status = run(['status', ...common]); assert.equal(status.status, 0, status.stderr);
    assert.equal((JSON.parse(status.stdout) as { enabled: boolean }).enabled, false);
    const args = ['prepare', ...common, '--reservation', 'cli-owner', '--task', 'cli-task', '--provenance', 'fixture'];
    const prepared = run(args), replayed = run(args);
    assert.equal(prepared.status, 0, prepared.stderr); assert.equal(replayed.status, 0, replayed.stderr);
    assert.deepEqual(JSON.parse(prepared.stdout), JSON.parse(replayed.stdout));
    const summary = run(['generate', ...common, '--due', String(due), '--lower', '0']);
    assert.equal(summary.status, 0, summary.stderr); assert.equal(validateWeeklySummary(JSON.parse(summary.stdout)).selectedRuns, 0);
    const configured = run(['config', ...common, '--enable', 'true']); assert.equal(configured.status, 0, configured.stderr);
    const disabled = run(['disable', ...common]); assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal((JSON.parse(run(['tick', ...common]).stdout) as { status: string }).status, 'disabled');
    const invalid = run(['status', ...common, '--account', 'forbidden']);
    assert.equal(invalid.status, 2); assert.equal(invalid.stdout, '');
  } finally { f.dispose(); }
});
