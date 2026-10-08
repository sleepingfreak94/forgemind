// These commands emit synthetic JSON fixtures. They do not drive or observe a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBrowserQaConfiguration } from '../../src/live-workflow/browser-qa-command.js';
import type { BrowserQaCommandConfiguration } from '../../src/live-workflow/browser-qa-command.js';
import type { BrowserQaRequest, BrowserQaReport } from '../../src/live-workflow/browser-qa.js';
import { parseLiveArguments, liveMain } from '../../src/local-runtime/live-cli.js';
const fixtureScript = `
const args=process.argv.slice(1); const get=k=>args[args.indexOf(k)+1];
if(process.env.OPENAI_API_KEY||process.env.GH_TOKEN||process.env.NODE_OPTIONS||process.env.AWS_SECRET_ACCESS_KEY||process.env.PATH||process.env.FIXTURE_SECRET) process.exit(4);
if(process.env.HOME===${JSON.stringify(process.env.HOME)}||process.cwd()!==get('--workspace')) process.exit(5);
process.stdout.write(JSON.stringify({version:1,phase:get('--phase'),workspace:get('--workspace'),taskId:get('--task-id'),
scenarioId:get('--scenario-id'),baselineSource:get('--baseline-source'),currentSource:get('--source'),requestId:get('--request-id'),
startedAt:Number(get('--requested-at')),completedAt:Date.now(),checks:[{id:'fixture',viewportWidth:375,passed:get('--phase')==='candidate',detail:'Synthetic command fixture; no browser observation'}]}));`.replace(/\n/g, ' ');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-browser-command-'))), workspace = join(root, 'repo'), path = join(root, 'qa.json');
  mkdirSync(workspace);
  const config: BrowserQaCommandConfiguration = { version: 1, scenarioId: 'fixture', executable: realpathSync(process.execPath),
    args: ['-e', fixtureScript, '--'], timeoutMs: 2000, maxOutputBytes: 8192 };
  const write = (value: unknown = config, at = path) => writeFileSync(at, JSON.stringify(value), { mode: 0o600 });
  const request = (phase: 'baseline' | 'candidate' = 'candidate'): BrowserQaRequest => ({ phase, workspace,
    task: { taskId: 'fixture' } as BrowserQaRequest['task'], scenarioId: 'fixture', baselineSource: 'a'.repeat(64),
    currentSource: (phase === 'baseline' ? 'a' : 'b').repeat(64), requestId: 'synthetic-command-request',
    requestedAt: Date.now(), signal: new AbortController().signal });
  write();
  return { root, workspace, path, config, write, request, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test('host command passes explicit source/root/phase and never inherits credentials or runtime injection (fixture)', async () => {
  const f = fixture(), keys = ['OPENAI_API_KEY', 'GH_TOKEN', 'NODE_OPTIONS', 'AWS_SECRET_ACCESS_KEY', 'FIXTURE_SECRET'];
  const original = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = 'synthetic-secret-must-not-inherit'; });
  try {
    const setup = loadBrowserQaConfiguration(f.path, f.workspace);
    for (const phase of ['baseline', 'candidate'] as const) {
      const request = f.request(phase), report = await setup.adapter(request) as BrowserQaReport;
      assert.equal(report.phase, phase); assert.equal(report.currentSource, request.currentSource);
      assert.equal(report.checks[0]!.passed, phase === 'candidate');
      assert.equal(report.workspace, f.workspace); assert.equal(report.requestId, request.requestId);
    }
  } finally {
    keys.forEach((key, index) => { if (original[index] === undefined) delete process.env[key]; else process.env[key] = original[index]; }); f.cleanup();
  }
});
for (const [name, mutate] of [
  ['unknown environment', (c: BrowserQaCommandConfiguration) => ({ ...c, env: { GH_TOKEN: 'fixture' } })],
  ['unknown override', (c: BrowserQaCommandConfiguration) => ({ ...c, optional: true })],
  ['relative executable', (c: BrowserQaCommandConfiguration) => ({ ...c, executable: 'node' })],
  ['noncanonical executable', (c: BrowserQaCommandConfiguration) => ({ ...c, executable: '/usr/../bin/node' })],
  ['oversized timeout', (c: BrowserQaCommandConfiguration) => ({ ...c, timeoutMs: 120001 })],
  ['unbounded output', (c: BrowserQaCommandConfiguration) => ({ ...c, maxOutputBytes: 65537 })],
  ['zero timeout', (c: BrowserQaCommandConfiguration) => ({ ...c, timeoutMs: 0 })],
  ['oversized arguments', (c: BrowserQaCommandConfiguration) => ({ ...c, args: Array(65).fill('arg') })],
  ['oversized argument', (c: BrowserQaCommandConfiguration) => ({ ...c, args: ['a'.repeat(8193)] })],
  ['oversized argv', (c: BrowserQaCommandConfiguration) => ({ ...c, args: Array(4).fill('a'.repeat(8192)) })],
  ['control argument', (c: BrowserQaCommandConfiguration) => ({ ...c, args: ['bad\narg'] })],
] as const) test('host command config rejects ' + name, () => {
  const f = fixture(); try { f.write(mutate(f.config)); assert.throws(() => loadBrowserQaConfiguration(f.path, f.workspace)); } finally { f.cleanup(); }
});
test('config/executable must be canonical, bounded, private, regular and outside writable source', () => {
  const f = fixture();
  try {
    const alias = join(f.root, 'alias'); symlinkSync(f.path, alias);
    assert.throws(() => loadBrowserQaConfiguration(alias, f.workspace), /canonical/);
    const hard = join(f.root, 'hard'); linkSync(f.path, hard);
    assert.throws(() => loadBrowserQaConfiguration(f.path, f.workspace), /private/); rmSync(hard);
    chmodSync(f.path, 0o644); assert.throws(() => loadBrowserQaConfiguration(f.path, f.workspace), /private/); chmodSync(f.path, 0o600);
    writeFileSync(f.path, 'a'.repeat(65537)); assert.throws(() => loadBrowserQaConfiguration(f.path, f.workspace), /bounded/); f.write();
    const inside = join(f.workspace, 'qa.json'); f.write(f.config, inside);
    assert.throws(() => loadBrowserQaConfiguration(inside, f.workspace), /outside/);
    const executable = join(f.root, 'fake-executable'); writeFileSync(executable, 'fixture', { mode: 0o644 });
    f.write({ ...f.config, executable }); assert.throws(() => loadBrowserQaConfiguration(f.path, f.workspace), /executable/);
    chmodSync(executable, 0o777); assert.throws(() => loadBrowserQaConfiguration(f.path, f.workspace), /untrusted/);
    const exeAlias = join(f.root, 'exe-alias'); symlinkSync(realpathSync(process.execPath), exeAlias);
    f.write({ ...f.config, executable: exeAlias }); assert.throws(() => loadBrowserQaConfiguration(f.path, f.workspace), /canonical/);
    f.write({ ...f.config, executable: inside }); chmodSync(inside, 0o700);
    assert.throws(() => loadBrowserQaConfiguration(f.path, f.workspace), /outside/);
  } finally { f.cleanup(); }
});
for (const [name, script, expected] of [
  ['output bound', "process.stdout.write('x'.repeat(65537))", /output limit/],
  ['stderr bound', "process.stderr.write('x'.repeat(65537))", /output limit/],
  ['timeout', 'setInterval(()=>{},1000)', /timeout/],
  ['exit failure', 'process.exit(2)', /failed/],
  ['missing result', '', /JSON/],
  ['invalid schema', "process.stdout.write('{}')", /hash|binding/],
  ['invalid utf8', 'process.stdout.write(Buffer.from([255]))', /UTF-8/],
  ['invalid candidate', fixtureScript.replace("get('--phase')==='candidate'", 'false'), /candidate checks failed/],
] as const) test('command fails closed: ' + name + ' (fixture)', async () => {
  const f = fixture();
  try {
    f.write({ ...f.config, args: ['-e', script, '--'], timeoutMs: name === 'timeout' ? 200 : 5000 });
    await assert.rejects(loadBrowserQaConfiguration(f.path, f.workspace).adapter(f.request()), expected);
  } finally { f.cleanup(); }
});
test('fixed arguments never invoke a shell, and config/executable drift is rejected (fixture)', async () => {
  const f = fixture();
  try {
    const marker = join(f.root, 'injected'), literal = '$(touch ' + marker + ')';
    f.write({ ...f.config, args: ['-e', fixtureScript, '--', literal] });
    const setup = loadBrowserQaConfiguration(f.path, f.workspace);
    await setup.adapter(f.request()); assert.equal(existsSync(marker), false);
    f.write({ ...f.config, args: ['-e', "throw Error('changed')"] });
    await assert.rejects(setup.adapter(f.request()), /identity changed/);
    const executable = join(f.root, 'node-fixture'); copyFileSync(realpathSync(process.execPath), executable); chmodSync(executable, 0o700);
    f.write({ ...f.config, executable }); const pinned = loadBrowserQaConfiguration(f.path, f.workspace);
    writeFileSync(executable, 'changed fixture executable');
    await assert.rejects(pinned.adapter(f.request()), /identity changed/);
  } finally { f.cleanup(); }
});
test('abort stops a running command without leaking stderr content (fixture)', async () => {
  const f = fixture(), controller = new AbortController();
  try {
    f.write({ ...f.config, args: ['-e', "process.stderr.write('synthetic-sensitive-data');setInterval(()=>{},1000)", '--'] });
    const running = loadBrowserQaConfiguration(f.path, f.workspace).adapter({ ...f.request(), signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(running, error => /cancelled/.test(String(error)) && !String(error).includes('sensitive-data'));
  } finally { f.cleanup(); }
});
const common = ['run', '--workspace', '/repo', '--task', '/task.json'];
const live = ['--connection', '/account', '--codex', '/codex', '--state-root', '/runs', '--worktree-root', '/trees'];
test('browser QA CLI flag grammar is host opt-in only and cannot be silently ignored', () => {
  const flags = ['--browser-qa-config', '/private/qa.json'];
  assert.equal(parseLiveArguments([...common, ...live, ...flags]).values['--browser-qa-config'], '/private/qa.json');
  assert.throws(() => parseLiveArguments([...common, ...flags]), /complete connection tuple/);
  for (const value of ['qa.json', '/a/../qa.json', '/a//qa.json', '/qa.json\n', '--yes'])
    assert.throws(() => parseLiveArguments([...common, ...live, '--browser-qa-config', value]));
  for (const extra of [flags, ['--browser-qa-executable', '/node'], ['--skip-browser-qa', '/yes'], ['--browser-qa-config=/private/qa.json']])
    assert.throws(() => parseLiveArguments([...common, ...live, ...flags, ...extra]));
  for (const mode of ['inspect', 'connect', 'auth-status', 'billing-reset'])
    assert.throws(() => parseLiveArguments([mode, '--workspace', '/repo', ...flags]));
});
test('invalid host config stops CLI before authentication/state/model access', async () => {
  const f = fixture(), manifest = join(f.root, 'task.json');
  try {
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, taskId: 'fixture', objective: 'Fixture',
      readPaths: ['value'], writePaths: ['value'], checks: [{ id: 'fixture', executable: '/missing', args: [], timeoutMs: 1000 }],
      model: 'fixture', effort: 'low', maxModelRequests: 3, maxPromptBytes: 65536, maxOutputBytes: 65536, maxRuntimeMs: 60000, draftPr: false }));
    f.write({ ...f.config, env: { GH_TOKEN: 'fixture' } });
    await assert.rejects(liveMain(['run', '--workspace', f.workspace, '--task', manifest,
      '--connection', join(f.root, 'account'), '--codex', realpathSync(process.execPath), '--state-root', join(f.root, 'runs'),
      '--worktree-root', join(f.root, 'worktrees'), '--browser-qa-config', f.path]));
    for (const path of ['account', 'runs', 'worktrees']) assert.equal(existsSync(join(f.root, path)), false);
  } finally { f.cleanup(); }
});
