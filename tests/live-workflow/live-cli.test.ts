import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveMain, parseLiveArguments } from '../../src/local-runtime/live-cli.js';
import { ChatGPTPlanSession, assertChatGPTPlanSession, openChatGPTPlanSession } from '../../src/live-workflow/chatgpt-plan.js';
import { NativeCodexModel, startBroker } from '../../src/live-workflow/provider.js';
import type { LiveTask } from '../../src/live-workflow/contracts.js';

test('CLI accepts explicit connection tuple, never endpoint/token/approval bypass flags', () => {
  const common = ['run', '--workspace', '/repo', '--task', '/task.json'];
  assert.equal(parseLiveArguments(common).mode, 'run');
  const live = ['--connection', '/account', '--codex', '/codex', '--state-root', '/runs', '--worktree-root', '/trees'];
  assert.equal(parseLiveArguments([...common, ...live]).values['--connection'], '/account');
  for (const flag of ['--yes', '--api-key', '--endpoint', '--model-factory', '--transport', '--billing-verified'])
    assert.throws(() => parseLiveArguments([...common, flag, '/bypass']));
  assert.throws(() => parseLiveArguments([...common, '--connection', '/account']));
  assert.throws(() => parseLiveArguments(['connect', '--connection', '../account']));
  assert.throws(() => parseLiveArguments(['connect', '--connection', '/repo/../account']));
  assert.throws(() => parseLiveArguments(['inspect', '--workspace', '/repo', '--connection', '/account']));
});
test('connection CLI refuses noninteractive authentication before any network or state access', () => {
  const executable = fileURLToPath(new URL('../../src/local-runtime/live-cli.js', import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [executable, 'connect', '--connection', '/nonexistent/forgemind-test'],
    { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] }),
  error => String((error as { stderr: Buffer }).stderr).includes('requires an owner terminal'));
});
const run = ['run', '--workspace', '/repo', '--task', '/task.json'];
const publication = ['--gh', '/opt/gh', '--author-name', 'Repository Owner', '--author-email', '123+owner@users.noreply.github.com'];
test('publication tuple is optional and all-or-none with bounded non-path author strings', () => {
  assert.equal(parseLiveArguments([...run, ...publication]).values['--author-name'], 'Repository Owner');
  assert.equal(parseLiveArguments([...run, '--author-name', 'Élodie O’Neil', '--author-email', 'owner@example.invalid', '--gh', '/opt/gh']).values['--gh'], '/opt/gh');
  for (let subset = 1; subset < 7; subset++) {
    const flags = [0, 1, 2].filter(i => subset & (1 << i)).flatMap(i => publication.slice(i * 2, i * 2 + 2));
    assert.throws(() => parseLiveArguments([...run, ...flags]), /supplied together/);
  }
  assert.throws(() => parseLiveArguments([...run, ...publication, '--connection', '/account']), /Connection/);
});
test('publication grammar rejects malformed identities, paths, duplicate and helper argument injection', () => {
  const invalid = [
    ['--author-name', ' '], ['--author-name', ' Owner'], ['--author-name', 'Owner '],
    ['--author-name', 'A'.repeat(121)], ['--author-name', 'Owner <other>'], ['--author-name', 'Owner\nInjected'],
    ['--author-name', 'Owner\u0085Injected'], ['--author-name', 'Owner\u202eInjected'],
    ['--author-name', '$(touch marker)'], ['--author-name', 'Owner;echo injected'],
    ['--author-email', 'not-an-email'], ['--author-email', 'owner@example..com'],
    ['--author-email', '.owner@example.com'], ['--author-email', 'owner..name@example.com'],
    ['--author-email', 'owner@-example.com'], ['--author-email', 'owner@example.com;evil'],
    ['--author-email', 'owner@example.com\n'], ['--author-email', 'a'.repeat(65) + '@example.com'],
    ['--author-email', 'a@' + 'b'.repeat(64) + '.com'],
    ['--author-email', 'a'.repeat(64) + '@' + ('b'.repeat(63) + '.').repeat(3) + 'com'],
    ['--gh', '../gh'], ['--gh', '/opt/../gh'], ['--gh', '/opt//gh'], ['--gh', '/opt/gh auth git-credential\n'],
  ];
  for (const [key, value] of invalid) {
    const args = [...publication]; args[args.indexOf(key!) + 1] = value!;
    assert.throws(() => parseLiveArguments([...run, ...args]), key + ': ' + JSON.stringify(value));
  }
  for (const extra of [['--gh', '/other/gh'], ['--author-name', 'Other'], ['--author-email', 'other@example.com'],
    ['--gh-args', '/args'], ['--git-credential-helper', '/helper'], ['--author-name=Owner']])
    assert.throws(() => parseLiveArguments([...run, ...publication, ...extra]));
  assert.throws(() => parseLiveArguments(['inspect', '--workspace', '/repo', ...publication]));
  for (const mode of ['connect', 'auth-status'])
    assert.throws(() => parseLiveArguments([mode, '--connection', '/account', ...publication]));
});
test('draft PR requires publication configuration before account review, worktree or model access', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-publication-cli-'))), manifest = join(root, 'task.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, taskId: 'publication', objective: 'Fixture',
    readPaths: ['value.txt'], writePaths: ['value.txt'], checks: [{ id: 'fixture', executable: '/missing/node', args: [], timeoutMs: 1000 }],
    model: 'fixture-model', effort: 'low', maxModelRequests: 3, maxPromptBytes: 65536,
    maxOutputBytes: 65536, maxRuntimeMs: 60000, draftPr: true }));
  const args = ['run', '--workspace', root, '--task', manifest];
  const live = ['--connection', join(root, 'account'), '--codex', '/missing/codex',
    '--state-root', join(root, 'runs'), '--worktree-root', join(root, 'trees')];
  await assert.rejects(liveMain(args), /Draft PR requires explicit publication/);
  await assert.rejects(liveMain([...args, ...live]), /Draft PR requires explicit publication/);
  for (const path of ['account', 'runs', 'trees']) assert.equal(existsSync(join(root, path)), false);
});
test('plain or constructed plan session cannot authorize requests or native launch', async () => {
  const session = new ChatGPTPlanSession();
  assert.throws(() => assertChatGPTPlanSession(session), /Unrecognized/);
  assert.throws(() => session.binding(), /Fresh subscription-only/);
  await assert.rejects(session.request('{}', new AbortController().signal), /Fresh subscription-only/);
  await assert.rejects(openChatGPTPlanSession('/missing', { isTTY: false, confirm: async () => 'credits-disabled x' }), /interactive/);
  const task = { maxRuntimeMs: 1000 } as LiveTask;
  const options = { task, planSession: session, authority: null!, source: () => '', signal: new AbortController().signal };
  await assert.rejects(startBroker(options), /Unrecognized/);
  await assert.rejects(new NativeCodexModel({ ...options, executable: '/missing' }).complete('', {}, {}, options.signal), /Unrecognized/);
});
test('host rejects unsafe gh executables before account access or owner review', { skip: process.platform !== 'darwin' }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-gh-pin-cli-'))), workspace = join(root, 'repo');
  mkdirSync(workspace); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const stream of [process.stdin, process.stdout]) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    t.after(() => { if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else Reflect.deleteProperty(stream, 'isTTY'); });
  }
  const manifest = join(root, 'task.json');
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, taskId: 'publication', objective: 'Fixture',
    readPaths: ['value.txt'], writePaths: ['value.txt'], checks: [{ id: 'fixture', executable: '/missing/node', args: [], timeoutMs: 1000 }],
    model: 'fixture-model', effort: 'low', maxModelRequests: 3, maxPromptBytes: 65536,
    maxOutputBytes: 65536, maxRuntimeMs: 60000, draftPr: true }));
  const gh = join(root, 'gh'), alias = join(root, 'gh-alias'), unsafe = join(root, 'gh with args');
  writeFileSync(gh, 'synthetic helper; must never execute'); chmodSync(gh, 0o644);
  writeFileSync(unsafe, 'synthetic helper; must never execute'); chmodSync(unsafe, 0o755); symlinkSync(gh, alias);
  const args = ['run', '--workspace', workspace, '--task', manifest, '--connection', join(root, 'account'),
    '--codex', realpathSync(process.execPath), '--state-root', join(root, 'runs'), '--worktree-root', join(root, 'trees'),
    '--author-name', 'Owner', '--author-email', 'owner@example.invalid'];
  await assert.rejects(liveMain([...args, '--gh', gh]), /Canonical executable gh helper/);
  chmodSync(gh, 0o777);
  await assert.rejects(liveMain([...args, '--gh', gh]), /untrusted file/);
  chmodSync(gh, 0o755);
  for (const path of [alias, unsafe]) await assert.rejects(liveMain([...args, '--gh', path]), /Canonical executable gh helper/);
  for (const path of ['account', 'runs', 'trees']) assert.equal(existsSync(join(root, path)), false);
});
