import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostFixture } from './fixture.js';
import { hostResource, pinFile, prepareHostPlan } from '../../src/host-enforcement/manifest.js';
import { snapshotWorkspace } from '../../src/host-enforcement/workspace.js';
import type { CursorIntent, DriverIntent } from '../../src/agent-drivers/contracts.js';

test('Cursor envelopes bind configuration, persistence and driver-specific environment and reject cross-driver fields', t => {
  const f = hostFixture(t, {}, { runtimeFiles: [] });
  const { driver: _driver, effort: _effort, provider: _provider, cliVersion: _version, ephemeral: _ephemeral, ...common } = f.intent;
  const intent: CursorIntent = { ...common, driver: 'cursor', provider: 'cursor', cliVersion: '2026.07.09-a3815c0', protocolVersion: 1,
    sessionMode: 'ask', ephemeral: false, persistence: 'private-scratch', configuration: { modelOptionId: 'model', modeOptionId: 'mode',
      options: [{ configId: 'model', value: common.model }, { configId: 'mode', value: 'ask' }] } };
  const options = { intent, executable: process.execPath, args: [], readFiles: [], supervisor: f.plan.supervisor.path };
  const plan = prepareHostPlan(options);
  assert.equal(plan.version, 'macos-offline-v2'); assert.ok(Object.isFrozen(plan.intent));
  assert.notEqual(hostResource(plan), hostResource(prepareHostPlan({ ...options, intent: f.intent })));
  for (const invalid of [{ ...intent, ephemeral: true }, { ...intent, provider: 'openai' }, { ...intent, cliVersion: 'unknown' },
    { ...intent, effort: 'high' }, { ...intent, sessionMode: 'agent' }, { ...intent, protocolVersion: 2 }, { ...intent, persistence: 'ambient' },
    { ...intent, configuration: { ...intent.configuration, options: [{ configId: 'model', value: 'other' }, { configId: 'mode', value: 'ask' }] } },
    { ...f.intent, persistence: 'private-scratch' }]) {
    assert.throws(() => prepareHostPlan({ ...options, intent: invalid as DriverIntent }));
  }
  let read = false;
  const hostile = { ...intent.configuration, get options() { read = true; return intent.configuration.options; } };
  assert.throws(() => prepareHostPlan({ ...options, intent: { ...intent, configuration: hostile } })); assert.equal(read, false);
});

test('sealed command envelope resists mutation and binds argv, limits, scope and environment policy', t => {
  const f = hostFixture(t, {}, { runtimeFiles: [] });
  assert.ok(Object.isFrozen(f.plan)); assert.ok(Object.isFrozen(f.plan.args)); assert.ok(Object.isFrozen(f.plan.intent.scope));
  const common = { intent: f.intent, executable: process.execPath, args: ['a'], readFiles: [], supervisor: f.plan.supervisor.path };
  assert.notEqual(hostResource(prepareHostPlan(common)), hostResource(prepareHostPlan({ ...common, args: ['b'] })));
  assert.notEqual(hostResource(prepareHostPlan(common)), hostResource(prepareHostPlan({ ...common, intent: { ...f.intent, maxRuntimeMs: 1 } })));
  let read = false;
  const hostile = { ...f.intent, get model() { read = true; return 'bad'; } };
  assert.throws(() => prepareHostPlan({ ...common, intent: hostile })); assert.equal(read, false);
  const args = ['a']; Object.defineProperty(args, '0', { get() { read = true; return 'bad'; }, enumerable: true });
  assert.throws(() => prepareHostPlan({ ...common, args })); assert.equal(read, false);
});
test('workspace copies only selected files and rejects traversal, symlinks and hardlink-like aliases', t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-snapshot-'))), source = join(base, 'source'), stage = join(base, 'stage');
  mkdirSync(source, { mode: 0o700 }); mkdirSync(stage, { mode: 0o700 });
  writeFileSync(join(source, 'okay.txt'), 'safe'); writeFileSync(join(source, '.env'), 'synthetic secret');
  symlinkSync(join(source, '.env'), join(source, 'link'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const snapshot = snapshotWorkspace(source, stage, ['okay.txt']);
  assert.equal(snapshot.readFiles.length, 1); assert.ok(snapshot.sourceSnapshot.length === 64);
  for (const path of ['../source/.env', '/etc/passwd', 'link']) assert.throws(() => snapshotWorkspace(source, stage, [path]));
  linkSync(join(source, 'okay.txt'), join(source, 'hardlink'));
  assert.throws(() => snapshotWorkspace(source, stage, ['hardlink']));
});
test('legacy task launcher blocks live coding before resolving or starting an agent', () => {
  const result = spawnSync(process.execPath, ['scripts/run-harness.mjs', 'write code'], { env: {}, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Live coding is disabled/); assert.equal(result.stdout, '');
});
test('executable/runtime pins reject setuid and setgid identity expansion', t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-pin-'))), file = join(base, 'binary');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(file, 'synthetic executable');
  for (const mode of [0o4700, 0o2700]) { chmodSync(file, mode); assert.throws(() => pinFile(file), /untrusted/); }
});
