import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { offlineProfile } from '../../src/host-enforcement/seatbelt.js';
import { LocalPolicyRuntime } from '../../src/policy/runtime.js';
import { fileURLToPath } from 'node:url';
import { CodexDriver } from '../../src/agent-drivers/codex.js';
import { PassThroughContextOptimizer } from '../../src/context-engine/optimizer.js';
import { MemoryOriginalStore } from '../../src/context-engine/originals.js';
import { digest, serialize } from '../../src/context-engine/validation.js';
import type { OptimizationInput } from '../../src/context-engine/contracts.js';
import { hostResource, prepareHostPlan } from '../../src/host-enforcement/manifest.js';
import { OfflineSeatbeltHost } from '../../src/host-enforcement/host.js';
import { hostFixture } from './fixture.js';

test('real Seatbelt allows selected reads and scratch; denies writes, secrets, fork and TCP/UDP/Unix sockets', async t => {
  const f = hostFixture(t), server = createServer(), unix = createServer();
  const socket = join(f.base, 'test.sock');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => unix.listen(socket, resolve));
  t.after(() => { server.close(); unix.close(); });
  const lease = await f.host.open(f.intent, new AbortController().signal);
  try {
    const result = await lease.rpc.request('inspect', { port: (server.address() as { port: number }).port, socket }) as Record<string, unknown>;
    assert.deepEqual(result, { allowedRead: 'allowed source', projectWriteDenied: true, secretReadDenied: true, scratchWriteAllowed: true,
      symlinkEscapeDenied: true, hardlinkEscapeDenied: true, forkDenied: true, tcpDenied: true, unixDenied: true, udpDenied: true, credentialEnvironmentAbsent: true, homePrivate: true });
    await lease.check(new AbortController().signal);
  } finally { lease.rpc.close(); await lease.stop(); }
  await lease.finish({ status: 'completed', viewDigest: f.intent.viewDigest, outputDigest: 'b'.repeat(64) });
  assert.equal(f.runtime.grant(f.grant.id)!.usedActions, 1);
  assert.equal(f.runtime.receipts().at(-1)!.outcome, 'completed');
  assert.equal(f.runtime.receipts().at(-1)!.terminalEvidence!.outputDigest, 'b'.repeat(64));
  assert.equal(f.runtime.fake.calls.length, 0);
});
test('terminal boundary rechecks source, cancellation and runtime deadline after reaping', async t => {
  for (const mode of ['source', 'cancel', 'deadline']) {
    const f = hostFixture(t, { maxRuntimeMs: 650 }), controller = new AbortController();
    const lease = await f.host.open(f.intent, controller.signal); await lease.rpc.request('ready', {});
    lease.rpc.close(); await lease.stop();
    if (mode === 'source') { chmodSync(f.workspace.readFiles[0]!, 0o600); writeFileSync(f.workspace.readFiles[0]!, 'drift'); }
    if (mode === 'cancel') controller.abort();
    if (mode === 'deadline') await new Promise(resolve => setTimeout(resolve, 700));
    await assert.rejects(lease.finish({ status: 'completed', viewDigest: f.intent.viewDigest }));
    assert.equal(f.runtime.receipts().at(-1)!.outcome, 'denied');
  }
});
test('native startup failure consumes reservation and cannot produce completed receipt', async t => {
  const f = hostFixture(t, {}, { executable: '/usr/bin/false', args: [], runtimeFiles: [] });
  try {
    const lease = await f.host.open(f.intent, new AbortController().signal);
    await assert.rejects(lease.rpc.request('ready', {})); await lease.stop();
    await assert.rejects(lease.finish({ status: 'completed', viewDigest: f.intent.viewDigest }));
  } catch { /* open failure receipts the attempted spawn itself */ }
  assert.equal(f.runtime.grant(f.grant.id)!.usedActions, 1);
  assert.ok(['failed', 'denied'].includes(f.runtime.receipts().at(-1)!.outcome));
});
test('Codex protocol fixture completes through real SQLite authorization and native sandbox host', async t => {
  const f = hostFixture(t), content = 'FATAL E42 failed compile';
  const packet: OptimizationInput = { schemaVersion: 1, scope: f.intent.scope, expiresAt: f.intent.expiresAt,
    protected: { objective: 'Diagnose E42', acceptanceCriteria: ['Retain E42'], permissions: [], policy: 'Read-only', checkpoint: 'Reproduced' },
    evidence: [{ id: 'log', sourceUri: 'fixture:log', sourceVersion: 'v1', content, contentDigest: digest(content), compressible: false }], budget: { maxBytes: 4096 } };
  const originals = new MemoryOriginalStore({ ttlMs: 10000, maxBytes: 65536 });
  t.after(() => originals.clear());
  const optimizer = new PassThroughContextOptimizer({ originals, authority: { async authorize(access) {
    return { allowed: serialize(access.scope) === serialize(packet.scope) && access.evidence.every(e => e.id === 'log' && e.contentDigest === digest(content)),
      receiptId: `fixture-packet-${access.phase}` }; // Synthetic packet authority; command authorization is real below.
  } } });
  const view = await optimizer.optimize(packet), intent = { ...f.intent, viewDigest: view.viewDigest };
  const script = fileURLToPath(new URL('../../src/local-runtime/codex-fixture-server.js', import.meta.url));
  const plan = prepareHostPlan({ intent, executable: process.execPath, args: [script], readFiles: [...f.plan.readFiles.map(file => file.path), script], supervisor: f.plan.supervisor.path });
  const grant = f.runtime.issueGrant({ taskId: 'ticket', invocationId: 'worker', role: 'coder', capabilities: [{ action: 'command.run', resource: hostResource(plan) }],
    expiresAt: intent.expiresAt, remainingDepth: 0, maxActions: 1, maxChildren: 0 });
  const host = new OfflineSeatbeltHost({ runtime: f.runtime, grantId: grant.id, plan, scratchRoot: join(f.base, 'scratch') });
  const driver = new CodexDriver({ host, optimizer, workspaceRoot: intent.workspaceRoot, model: intent.model, effort: intent.effort,
    maxRuntimeMs: intent.maxRuntimeMs, maxOutputBytes: intent.maxOutputBytes });
  const result = await driver.run(packet);
  assert.equal(result.output, 'Fixture diagnosis: E42 retained'); assert.equal(result.status, 'completed');
  const receipt = f.runtime.receipts().at(-1)!;
  assert.equal(receipt.event, 'external.finished'); assert.equal(receipt.outcome, 'completed'); assert.equal(receipt.terminalEvidence!.outputDigest, result.outputDigest);
});
test('cancellation and runtime deadline stop active workers', async t => {
  for (const mode of ['cancel', 'deadline']) {
    const f = hostFixture(t, { maxRuntimeMs: 600 }), controller = new AbortController();
    const lease = await f.host.open(f.intent, controller.signal); await lease.rpc.request('ready', {});
    if (mode === 'cancel') controller.abort();
    else await new Promise(resolve => setTimeout(resolve, 650));
    await assert.rejects(lease.check(new AbortController().signal)); await lease.stop();
    await lease.finish({ status: mode === 'cancel' ? 'cancelled' : 'timed-out', viewDigest: f.intent.viewDigest });
    assert.equal(f.runtime.receipts().at(-1)!.outcome, mode === 'cancel' ? 'cancelled' : 'timed-out');
  }
});
test('output overflow terminates worker without retry and invalid terminal cannot consume completion', async t => {
  const f = hostFixture(t, { maxOutputBytes: 1024 }), lease = await f.host.open(f.intent, new AbortController().signal);
  await assert.rejects(lease.rpc.request('flood', {})); await lease.stop();
  await assert.rejects(lease.finish({ status: 'completed', viewDigest: f.intent.viewDigest, outputDigest: 'bad' }));
  await lease.finish({ status: 'failed', viewDigest: f.intent.viewDigest });
  assert.equal(f.runtime.grant(f.grant.id)!.usedActions, 1);
});
test('new host session fences and stops the previous worker', async t => {
  const f = hostFixture(t), lease = await f.host.open(f.intent, new AbortController().signal);
  await lease.rpc.request('ready', {});
  const replacement = LocalPolicyRuntime.open({ stateDirectory: join(f.base, 'policy'), workspaceRoot: f.workspace.workspaceRoot,
    repositoryId: 'project-a', sourceSnapshot: () => f.workspace.sourceSnapshot });
  t.after(() => replacement.close());
  await new Promise(resolve => setTimeout(resolve, 75));
  await assert.rejects(lease.check(new AbortController().signal)); await lease.stop();
  await assert.rejects(lease.finish({ status: 'completed', viewDigest: f.intent.viewDigest }));
  assert.ok(replacement.receipts().some(r => r.event === 'external.recovered' && r.outcome === 'indeterminate'));
});
test('supervisor stops and reaps worker on parent IPC disconnect', async t => {
  const f = hostFixture(t), scratch = join(f.base, 'watchdog'); mkdirSync(scratch, { mode: 0o700 });
  mkdirSync(join(scratch, 'codex')); mkdirSync(join(scratch, 'tmp'));
  const config = { driver: 'codex', executable: f.plan.executable.path, args: f.plan.args, cwd: f.intent.workspaceRoot, profile: offlineProfile(f.plan, scratch),
    scratch, deadline: Date.now() + 5000, maxOutputBytes: 65536 };
  const helper = spawn(f.plan.supervisorNode.path, [f.plan.supervisor.path, Buffer.from(JSON.stringify(config)).toString('base64url')],
    { env: { OPENSSL_CONF: '/dev/null' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  helper.stdout!.resume(); helper.stderr!.resume();
  const exited = new Promise<void>(resolve => helper.on('exit', () => resolve()));
  t.after(() => { if (helper.connected) helper.send('stop'); });
  const pid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no startup')), 1000);
    helper.on('message', raw => { const event = raw as { type: string; workerPid: number }; if (event.type === 'started') { clearTimeout(timer); resolve(event.workerPid); } });
    helper.send('start');
  });
  helper.disconnect(); await exited; helper.stdin!.destroy(); helper.stdout!.destroy(); helper.stderr!.destroy();
  assert.throws(() => process.kill(pid, 0), /ESRCH/); // Diagnostic only; authority never derives from PID.
});
test('scope escalation denied before process dispatch and receipt persisted', async t => {
  const f = hostFixture(t);
  await assert.rejects(f.host.open({ ...f.intent, model: 'unauthorized-model' }, new AbortController().signal), /outside-grant/);
  assert.equal(f.runtime.grant(f.grant.id)!.usedActions, 0);
  assert.equal(f.runtime.receipts().at(-1)!.outcome, 'deny');
});
test('revocation terminates active native worker and prevents completed receipt', async t => {
  const f = hostFixture(t), lease = await f.host.open(f.intent, new AbortController().signal);
  await lease.rpc.request('ready', {}); f.runtime.revoke(f.grant.id);
  await new Promise(resolve => setTimeout(resolve, 75));
  await assert.rejects(lease.check(new AbortController().signal)); await lease.stop();
  await assert.rejects(lease.finish({ status: 'completed', viewDigest: f.intent.viewDigest }));
  assert.equal(f.runtime.receipts().at(-1)!.outcome, 'denied');
});
test('source file drift is detected before dispatch and leaves consumed failed attempt', async t => {
  const f = hostFixture(t);
  chmodSync(f.workspace.readFiles[0]!, 0o600);
  writeFileSync(f.workspace.readFiles[0]!, 'changed');
  await assert.rejects(f.host.open(f.intent, new AbortController().signal), /identity/);
  assert.equal(f.runtime.grant(f.grant.id)!.usedActions, 1);
  assert.equal(f.runtime.receipts().at(-1)!.outcome, 'failed');
});
