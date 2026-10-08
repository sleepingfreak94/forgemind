import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLiveArguments } from '../../src/local-runtime/live-cli.js';
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
