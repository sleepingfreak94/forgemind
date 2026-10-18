import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TaskGrant } from '../../src/policy/contracts.js';
import { LocalPolicyRuntime } from '../../src/policy/runtime.js';
import type { ContinuationCheckpoint, ResumeTarget, StoredContinuation } from '../../src/live-workflow/continuation-contracts.js';
import { continuationSchema } from '../../src/live-workflow/continuation-contracts.js';
import { ContinuationStore } from '../../src/live-workflow/continuation-store.js';
import { handoffResource, prepareResume } from '../../src/live-workflow/continuation.js';
import type { PrepareResumeOptions } from '../../src/live-workflow/continuation.js';
import { hash, serialize, validateCheckpoint, validateTarget } from '../../src/live-workflow/continuation-validation.js';
import { continuationMain, parseContinuationArgs } from '../../src/local-runtime/continuation-cli.js';
import type { ContinuationCliPorts } from '../../src/local-runtime/continuation-cli.js';

const sourceA = 'a'.repeat(64); const sourceB = 'b'.repeat(64);
class Fixture {
  readonly base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'fm-continuation-')));
  readonly root = join(this.base, 'workspace');
  readonly state = join(this.base, 'state');
  readonly policyState = join(this.base, 'authority');
  now = 1800000000000;
  source = sourceA;
  policy = 'local-v1';
  store: ContinuationStore;
  runtime: LocalPolicyRuntime;
  constructor() {
    mkdirSync(this.root, { mode: 0o700 }); mkdirSync(this.policyState, { mode: 0o700 });
    writeFileSync(join(this.root, 'work.txt'), 'fixture', { mode: 0o600 });
    this.store = this.openStore(); this.runtime = this.openRuntime();
  }
  openStore(): ContinuationStore {
    return new ContinuationStore({ workspaceRoot: this.root, projectId: 'project', stateDirectory: this.state,
      source: () => this.source, clock: () => this.now });
  }
  openRuntime(): LocalPolicyRuntime {
    return LocalPolicyRuntime.open({ workspaceRoot: this.root, repositoryId: 'project', stateDirectory: this.policyState,
      sourceSnapshot: () => this.source, clock: () => this.now });
  }
  checkpoint(changes: Partial<ContinuationCheckpoint> = {}): ContinuationCheckpoint {
    return { schemaVersion: continuationSchema, projectId: 'project', root: this.root, taskId: 'task',
      sourceIdentity: this.source, policyVersion: this.policy, objective: 'Implement and verify the feature',
      acceptanceCriteria: ['Exact source passes owner checks'], evidence: [], decisions: [], hypotheses: [],
      failedApproaches: [], nextSteps: ['QA checks the implementation'], origin: { instanceId: randomUUID(), role: 'coder' },
      parentDigest: null, createdAt: this.now - 100, expiresAt: this.now + 60000,
      budget: { limit: { runtimeMs: 1000000, turns: 10, toolCalls: 20, inputBytes: 1000000,
        resultBytes: 1000000, wireBytes: 1000000, outputBytes: 1000000, retries: 0 },
      used: { runtimeMs: 100, turns: 2, toolCalls: 3, inputBytes: 32, resultBytes: 32, wireBytes: 32, outputBytes: 32, retries: 0 } },
      requestCapabilities: [{ action: 'file.read', resource: join(this.root, 'work.txt') },
        { action: 'file.write', resource: join(this.root, 'work.txt') }], status: 'ready', pendingEffects: [],
      reconciliation: { status: 'none', evidenceIds: [], invalidatedAssumptions: [] }, ...changes };
  }
  target(changes: Partial<ResumeTarget> = {}): ResumeTarget {
    return { role: 'qa', capabilities: [{ action: 'file.read', resource: join(this.root, 'work.txt') }],
      expiresAt: this.now + 30000, remainingDepth: 0, maxActions: 4, maxChildren: 0, ...changes };
  }
  authorize(stored: StoredContinuation, target = this.target(), parentChanges: Partial<TaskGrant> = {}): PrepareResumeOptions {
    const parent = this.runtime.issueGrant({ taskId: stored.checkpoint.taskId, invocationId: randomUUID(), role: 'lead',
      capabilities: [...stored.checkpoint.requestCapabilities, { action: 'command.run', resource: handoffResource(stored.digest, stored.checkpoint, target) }],
      expiresAt: stored.checkpoint.expiresAt, remainingDepth: 1, maxActions: 20, maxChildren: 8,
      ...parentChanges });
    return { store: this.store, runtime: this.runtime, currentPolicy: () => this.policy,
      binding: { digest: stored.digest, projectId: 'project', root: this.root, taskId: stored.checkpoint.taskId,
        parentGrantId: parent.id, instanceId: randomUUID(), invocationId: randomUUID(), target } };
  }
  close(): void {
    try { this.runtime.close(); } finally { try { this.store.close(); } finally { rmSync(this.base, { recursive: true, force: true }); } }
  }
}
function fixture(work: (f: Fixture) => void): void { const f = new Fixture(); try { work(f); } finally { f.close(); } }
function reconcile(f: Fixture, parent: StoredContinuation, changes: Partial<ContinuationCheckpoint> = {}): ContinuationCheckpoint {
  return { ...structuredClone(parent.checkpoint), parentDigest: parent.digest, createdAt: f.now,
    sourceIdentity: f.source, policyVersion: f.policy, origin: { instanceId: randomUUID(), role: 'lead' },
    decisions: [], hypotheses: [], evidence: [{ id: 'owner-check', kind: 'reconciliation', source: 'owner:effect-audit',
      sourceIdentity: f.source, digest: hash('owner audit artifact'), epistemic: 'observed', result: 'recorded', summary: 'Owner checked effects and new source' }],
    reconciliation: { status: 'owner-reconciled', evidenceIds: ['owner-check'], invalidatedAssumptions: ['Prior source and effect assumptions'] }, ...changes };
}

test('durable canonical save/reopen and coder to QA handoff use a new real child grant', () => fixture(f => {
  const input = f.checkpoint(); const stored = f.store.save(input);
  input.objective = 'mutated outside the store';
  f.store.close(); f.store = f.openStore();
  assert.equal(f.store.inspect(stored.digest).digest, hash(stored.checkpoint));
  assert.equal(f.store.inspect(stored.digest).checkpoint.objective, 'Implement and verify the feature');
  const options = f.authorize(stored); const lease = prepareResume(options);
  lease.check();
  assert.equal(lease.packet.role, 'qa'); assert.equal(lease.grant.parentId, options.binding.parentGrantId);
  assert.notEqual(lease.packet.instanceId, stored.checkpoint.origin.instanceId);
  assert.equal(lease.grant.sessionId, f.runtime.sessionId);
  assert.deepEqual(lease.packet.checkpoint.budget.used, stored.checkpoint.budget.used);
  assert.equal(lease.packet.remainingBudget.turns, 8); assert.equal(lease.packet.remainingBudget.retries, 0);
  assert.equal(f.runtime.receipts().filter(r => r.event === 'external.finished' && r.outcome === 'completed').length, 1);
  assert.throws(() => prepareResume(f.authorize(stored)), /consumed/);
  const reviewer = f.store.save(f.checkpoint({ taskId: 'review-task' }));
  const reviewLease = prepareResume(f.authorize(reviewer, f.target({ role: 'reviewer' })));
  reviewLease.check(); assert.deepEqual(reviewLease.grant.capabilities.map(c => c.action), ['file.read']);
}));

test('exact project/task/root/origin and resource ceiling bindings fail closed', () => fixture(f => {
  const stored = f.store.save(f.checkpoint()); const options = f.authorize(stored);
  for (const patch of [{ projectId: 'other' }, { taskId: 'other' }, { root: f.base }, { instanceId: stored.checkpoint.origin.instanceId }]) {
    assert.throws(() => prepareResume({ ...options, binding: { ...options.binding, ...patch } }));
  }
  assert.throws(() => prepareResume({ ...options, binding: { ...options.binding,
    target: f.target({ capabilities: [{ action: 'file.read', resource: join(f.root, 'other.txt') }] }) } }), /ceiling/);
  assert.throws(() => prepareResume(f.authorize(stored, f.target(), { taskId: 'wrong-task' })), /mismatched/);
  assert.throws(() => validateTarget(f.root, f.target({ role: 'reviewer', capabilities: stored.checkpoint.requestCapabilities }), f.now), /read-only/);
  prepareResume(options).check();
}));

test('parent chain preserves cumulative counters, limits, scope, expiry and a single child', () => fixture(f => {
  const stored = f.store.save(f.checkpoint());
  for (const edit of ['counter', 'limit', 'expiry', 'task', 'source', 'capability'] as const) {
    const child: ContinuationCheckpoint = { ...structuredClone(stored.checkpoint), parentDigest: stored.digest, createdAt: f.now };
    if (edit === 'counter') child.budget.used.turns--;
    if (edit === 'limit') child.budget.limit.turns = 11;
    if (edit === 'expiry') child.expiresAt++;
    if (edit === 'task') child.taskId = 'different';
    if (edit === 'source') { f.source = sourceB; child.sourceIdentity = sourceB; }
    if (edit === 'capability') child.requestCapabilities.push({ action: 'file.read', resource: join(f.root, 'new.txt') });
    assert.throws(() => f.store.save(child)); f.source = sourceA;
  }
  const child: ContinuationCheckpoint = { ...structuredClone(stored.checkpoint), parentDigest: stored.digest, createdAt: f.now }; child.budget.used.turns++;
  const savedChild = f.store.save(child);
  assert.throws(() => prepareResume(f.authorize(stored)), /superseded/);
  assert.throws(() => f.store.save({ ...child, nextSteps: ['fork'] }));
  assert.throws(() => f.store.save({ ...child, parentDigest: 'f'.repeat(64), taskId: 'orphan' }), /missing/);
  prepareResume(f.authorize(savedChild)).check();
}));

test('exhausted cumulative budgets and child action/depth escalation are denied', () => fixture(f => {
  for (const key of ['runtimeMs', 'turns', 'toolCalls', 'inputBytes', 'resultBytes', 'wireBytes', 'outputBytes'] as const) {
    const checkpoint = f.checkpoint({ taskId: key }); checkpoint.budget.used[key] = checkpoint.budget.limit[key]!;
    assert.throws(() => prepareResume(f.authorize(f.store.save(checkpoint))), /exhausted/);
  }
  for (const [taskId, target] of [['actions', f.target({ maxActions: 100 })], ['depth', f.target({ remainingDepth: 1 })]] as const) {
    const stored = f.store.save(f.checkpoint({ taskId }));
    assert.throws(() => prepareResume(f.authorize(stored, target)), /escalation/);
    assert.throws(() => prepareResume(f.authorize(stored)), /consumed/);
  }
  assert.ok(f.runtime.receipts().some(r => r.event === 'external.finished' && r.outcome === 'indeterminate'));
}));

for (const cause of ['source', 'policy', 'revoked', 'cancelled', 'expired', 'session'] as const) {
  test(`fresh preparation denies ${cause} drift`, () => fixture(f => {
    const stored = f.store.save(f.checkpoint()); const options = f.authorize(stored);
    let replacement: LocalPolicyRuntime | undefined;
    try {
      if (cause === 'source') f.source = sourceB;
      if (cause === 'policy') { f.policy = 'local-v2'; f.runtime.updatePolicyVersion(f.policy); }
      if (cause === 'revoked') f.runtime.revoke(options.binding.parentGrantId);
      if (cause === 'cancelled') f.store.cancel('task');
      if (cause === 'expired') f.now = stored.checkpoint.expiresAt + 1;
      if (cause === 'session') replacement = f.openRuntime();
      assert.throws(() => prepareResume(options));
    } finally { replacement?.close(); }
  }));
  test(`live lease rechecks ${cause}`, () => fixture(f => {
    const stored = f.store.save(f.checkpoint()); const options = f.authorize(stored); const lease = prepareResume(options);
    let replacement: LocalPolicyRuntime | undefined;
    try {
      if (cause === 'source') f.source = sourceB;
      if (cause === 'policy') { f.policy = 'local-v2'; f.runtime.updatePolicyVersion(f.policy); }
      if (cause === 'revoked') f.runtime.revoke(options.binding.parentGrantId);
      if (cause === 'cancelled') f.store.cancel('task');
      if (cause === 'expired') f.now = stored.checkpoint.expiresAt + 1;
      if (cause === 'session') replacement = f.openRuntime();
      assert.throws(() => lease.check());
    } finally { replacement?.close(); }
  }));
}

test('new role instance fences an older lease and cancellation survives reopen', () => fixture(f => {
  const parent = f.store.save(f.checkpoint()); const first = prepareResume(f.authorize(parent));
  const child: ContinuationCheckpoint = { ...structuredClone(parent.checkpoint), parentDigest: parent.digest, createdAt: f.now,
    origin: { instanceId: first.packet.instanceId, role: 'qa' } }; child.budget.used.turns++;
  const next = f.store.save(child); const second = prepareResume(f.authorize(next, f.target({ role: 'reviewer' })));
  assert.ok(second.packet.fence > first.packet.fence); assert.throws(() => first.check(), /fence/);
  second.revoke(); assert.throws(() => second.check());
  f.store.close(); f.store = f.openStore(); assert.equal(f.store.cancelled('task'), true);
  assert.throws(() => f.store.save({ ...child, parentDigest: next.digest, createdAt: f.now + 1 }));
}));

test('pending or indeterminate effects require an owner reconciled new checkpoint; no replay', () => fixture(f => {
  const parent = f.store.save(f.checkpoint({ status: 'indeterminate', pendingEffects: [
    { id: 'effect', description: 'Unknown prior write outcome', status: 'indeterminate', evidenceIds: [] }],
    reconciliation: { status: 'required', evidenceIds: [], invalidatedAssumptions: [] } }));
  assert.throws(() => prepareResume(f.authorize(parent)), /not runnable/);
  f.source = sourceB;
  const child = reconcile(f, parent, { status: 'ready', pendingEffects: [
    { id: 'effect', description: 'Owner verified effect outcome', status: 'reconciled', evidenceIds: ['owner-check'] }] });
  assert.throws(() => f.store.save({ ...child, reconciliation: { status: 'none', evidenceIds: [], invalidatedAssumptions: [] } }));
  assert.throws(() => f.store.save({ ...child, pendingEffects: [] }), /unresolved/);
  const resumed = prepareResume(f.authorize(f.store.save(child))); resumed.check();
  assert.equal(resumed.packet.sourceIdentity, sourceB);
  assert.equal(f.runtime.receipts().filter(r => r.event === 'external.finished').length, 1);
}));

test('reserved preparation survives crash/reopen and cannot be replayed or silently repaired', () => fixture(f => {
  const parent = f.store.save(f.checkpoint());
  f.store.consume(parent.digest, randomUUID()); f.store.close(); f.store = f.openStore();
  assert.throws(() => prepareResume(f.authorize(parent)), /consumed/);
  assert.throws(() => f.store.save({ ...structuredClone(parent.checkpoint), parentDigest: parent.digest, createdAt: f.now }), /reconciliation/);
  const next = f.store.save(reconcile(f, parent)); prepareResume(f.authorize(next)).check();
}));

test('failed continuation ledger settlement revokes the newly issued real child', () => fixture(f => {
  const parent = f.store.save(f.checkpoint()); const options = f.authorize(parent);
  const terminalize = f.store.terminalize.bind(f.store);
  f.store.terminalize = (digest, instance, fence, status) => {
    if (status === 'prepared') throw new Error('injected continuation settlement failure');
    terminalize(digest, instance, fence, status);
  };
  assert.throws(() => prepareResume(options), /settlement failure/);
  const issued = f.runtime.receipts().filter(r => r.event === 'grant.issued').at(-1)?.grantId;
  assert.ok(issued); assert.notEqual(issued, options.binding.parentGrantId);
  assert.equal(f.runtime.grant(issued)?.revoked, true);
  assert.throws(() => prepareResume(f.authorize(parent)), /consumed/);
}));

test('source and policy are fetched again after reservation, before handoff', () => fixture(f => {
  const parent = f.store.save(f.checkpoint()); const options = f.authorize(parent); let reads = 0;
  options.currentPolicy = () => { if (++reads === 4) { f.source = sourceB; throw new Error('dispatch policy changed'); } return f.policy; };
  assert.throws(() => prepareResume(options), /dispatch policy changed/);
  const id = f.runtime.receipts().filter(r => r.event === 'grant.issued').at(-1)?.grantId;
  assert.ok(id); assert.equal(f.runtime.grant(id)?.revoked, true); assert.equal(reads, 4);
}));

test('schema rejects extra keys, unsafe resources, accessors, oversized data and reset counters', () => fixture(f => {
  for (const key of ['providerThread', 'conversation', 'credentials', 'grant', 'policyAccepted']) assert.throws(() => validateCheckpoint({ ...f.checkpoint(), [key]: 'forbidden' }));
  const nested = f.checkpoint(); Object.assign(nested.origin, { thread: 'forbidden' }); assert.throws(() => validateCheckpoint(nested));
  assert.throws(() => validateCheckpoint({ ...f.checkpoint(), objective: 'x'.repeat(262145) }));
  assert.throws(() => validateCheckpoint({ ...f.checkpoint(), evidence: Array.from({ length: 129 }, () => ({})) }));
  const getter = f.checkpoint(); Object.defineProperty(getter, 'objective', { get: () => { throw new Error('must not execute'); } });
  assert.throws(() => validateCheckpoint(getter), error => error instanceof Error && error.message !== 'must not execute');
  for (const resource of [join(f.root, '*'), '../escape', 'work.txt']) assert.throws(() => validateCheckpoint({ ...f.checkpoint(), requestCapabilities: [{ action: 'file.read', resource }] }));
  const negative = f.checkpoint(); negative.budget.used.turns = -1; assert.throws(() => validateCheckpoint(negative));
}));

test('unsafe state location, permissions, links and registrations are denied', () => fixture(f => {
  const open = (stateDirectory: string, projectId = 'project') => new ContinuationStore({ workspaceRoot: f.root, projectId, stateDirectory, source: () => f.source });
  assert.throws(() => open(join(f.root, 'state')));
  const unsafe = join(f.base, 'unsafe'); mkdirSync(unsafe); chmodSync(unsafe, 0o777);
  assert.throws(() => open(join(unsafe, 'state'))); chmodSync(unsafe, 0o700);
  const link = join(f.base, 'linked'); symlinkSync(f.state, link); assert.throws(() => open(link));
  assert.throws(() => open(f.state, 'other'));
  f.store.close(); const database = join(f.state, 'continuation.sqlite'); const alias = join(f.base, 'db-alias');
  linkSync(database, alias); assert.throws(() => open(f.state)); unlinkSync(alias);
  f.store = f.openStore();
}));

test('SQLite records reject mutation and rehash detects changed evidence on read', () => fixture(f => {
  const stored = f.store.save(f.checkpoint()); f.store.close();
  const db = new DatabaseSync(join(f.state, 'continuation.sqlite'));
  try {
    assert.throws(() => db.prepare('UPDATE checkpoints SET json=? WHERE digest=?').run('{}', stored.digest), /immutable/);
    db.exec('DROP TRIGGER immutable_checkpoint_update');
    db.prepare('UPDATE checkpoints SET json=? WHERE digest=?').run(serialize({ ...stored.checkpoint, objective: 'tampered' }), stored.digest);
  } finally { db.close(); }
  f.store = f.openStore(); assert.throws(() => f.store.inspect(stored.digest), /integrity/);
}));

test('strict CLI parser and help have no subprocess or repository requirement', () => {
  assert.equal(parseContinuationArgs(['--help']), 'help');
  let output = ''; assert.equal(continuationMain(['--help'], { stdout: value => { output += value; } }), 0);
  assert.match(output, /save/);
  for (const argv of [[], ['prepare'], ['save', '--ready', 'true'], ['inspect', '--policy-accepted', 'true'],
    ['save', '--workspace', '/repo', '--workspace', '/again']]) assert.throws(() => parseContinuationArgs(argv));
});

test('owner CLI save/inspect/prepare works in process with private inputs and evidence-only output', () => fixture(f => {
  const state = join(f.base, 'cli-state'); const input = join(f.base, 'checkpoint.json'); const policyPath = join(f.base, 'policy.json');
  const checkpoint = f.checkpoint(); writeFileSync(input, JSON.stringify(checkpoint), { mode: 0o600 });
  const common = ['--workspace', f.root, '--project-id', 'project', '--state', state];
  let output = ''; let errors = '';
  const ports = { source: () => f.source, clock: () => f.now, stdout: (value: string) => { output = value; }, stderr: (value: string) => { errors += value; } };
  assert.equal(continuationMain(['save', ...common, '--input', input], ports), 0, errors);
  const saved = JSON.parse(output) as StoredContinuation; const target = f.target();
  const descriptor = { policyVersion: 'local-v1', target, parent: { ...target, role: 'lead', remainingDepth: 1,
    maxActions: 20, maxChildren: 4, expiresAt: checkpoint.expiresAt,
    capabilities: [...checkpoint.requestCapabilities, { action: 'command.run', resource: handoffResource(saved.digest, checkpoint, target) }] } };
  writeFileSync(policyPath, JSON.stringify(descriptor), { mode: 0o600 });
  assert.equal(continuationMain(['inspect', ...common, '--digest', saved.digest, '--policy', policyPath], ports), 0, errors);
  assert.equal((JSON.parse(output) as { evidenceOnly: boolean }).evidenceOnly, true);
  assert.equal(continuationMain(['prepare', ...common, '--digest', saved.digest, '--policy', policyPath], ports), 0, errors);
  const result = JSON.parse(output) as { processLocalAuthorityClosed: boolean; packet: { role: string } };
  assert.equal(result.processLocalAuthorityClosed, true); assert.equal(result.packet.role, 'qa');
  assert.equal(continuationMain(['prepare', ...common, '--digest', saved.digest, '--policy', policyPath], ports), 1);
  chmodSync(input, 0o644); assert.equal(continuationMain(['save', ...common, '--input', input], ports), 1);
}));

const privateMarker = 'PRIVATE-C6-JSON-MESSAGE-STACK';
const safeDenial = '{"status":"denied","error":"invalid-owner-request"}\n';
function assertPrivateDenial(f: Fixture, argv: string[], overrides: ContinuationCliPorts = {}, forbidden: string[] = []): void {
  let stdout = ''; let stderr = '';
  const code = continuationMain(argv, { source: () => f.source, clock: () => f.now, ...overrides,
    stdout: overrides.stdout ?? (value => { stdout += value; }), stderr: value => { stderr += value; } });
  assert.equal(code, 1); assert.equal(stdout, ''); assert.equal(stderr, safeDenial);
  assert.equal(Buffer.byteLength(stderr), 52);
  for (const secret of [privateMarker, f.base, ...forbidden]) assert.equal((stdout + stderr).includes(secret), false);
}

for (const problem of ['malformed checkpoint', 'missing file', 'unsafe permissions'] as const) {
  test(`owner CLI keeps ${problem} details private`, () => fixture(f => {
    const input = join(f.base, `${privateMarker}.json`);
    if (problem !== 'missing file') writeFileSync(input, problem === 'malformed checkpoint' ? `{"${privateMarker}": invalid}` : JSON.stringify(f.checkpoint()), { mode: 0o600 });
    if (problem === 'unsafe permissions') chmodSync(input, 0o644);
    assertPrivateDenial(f, ['save', '--workspace', f.root, '--project-id', 'project', '--state', join(f.base, 'cli-state'), '--input', input], {}, [input]);
  }));
}

for (const command of ['inspect', 'prepare'] as const) {
  test(`owner CLI ${command} keeps malformed private policy JSON private after a valid save`, () => fixture(f => {
    const input = join(f.base, 'checkpoint.json'); const policy = join(f.base, `${privateMarker}-policy.json`);
    const common = ['--workspace', f.root, '--project-id', 'project', '--state', join(f.base, 'cli-state')];
    writeFileSync(input, JSON.stringify(f.checkpoint()), { mode: 0o600 });
    let output = ''; let errors = '';
    assert.equal(continuationMain(['save', ...common, '--input', input], { source: () => f.source, clock: () => f.now,
      stdout: value => { output += value; }, stderr: value => { errors += value; } }), 0);
    assert.equal(errors, ''); const saved = JSON.parse(output) as StoredContinuation;
    writeFileSync(policy, `{"${privateMarker}": invalid}`, { mode: 0o600 });
    assertPrivateDenial(f, [command, ...common, '--digest', saved.digest, '--policy', policy], {}, [input, policy]);
  }));
}

for (const port of ['source', 'clock', 'stdout'] as const) {
  for (const payload of ['error', 'string', 'error getters', 'object traps'] as const) {
    test(`owner CLI hides sensitive ${payload} thrown by ${port} without inspecting it`, () => fixture(f => {
      const input = join(f.base, `${privateMarker}.json`);
      writeFileSync(input, JSON.stringify(f.checkpoint()), { mode: 0o600 });
      let touched = 0; let calls = 0;
      const trap = () => { touched++; throw new Error(`${privateMarker}-getter`); };
      const error = new Error(`${privateMarker}-message`); error.stack = `${privateMarker}-stack`;
      const hostileError = new Error(); hostileError.stack = '';
      for (const key of ['message', 'stack', 'cause']) Object.defineProperty(hostileError, key, { get: trap });
      const hostileObject = Object.defineProperties({}, {
        message: { get: trap }, stack: { get: trap }, cause: { get: trap },
        toString: { get: trap }, toJSON: { get: trap }, [Symbol.toPrimitive]: { get: trap } });
      const thrown: unknown = payload === 'error' ? error : payload === 'string' ? `${privateMarker}-non-error` : payload === 'error getters' ? hostileError : hostileObject;
      const fail = (): never => { calls++; throw thrown; };
      assertPrivateDenial(f, ['save', '--workspace', f.root, '--project-id', 'project', '--state', join(f.base, 'cli-state'), '--input', input], { [port]: fail },
        [input, `${privateMarker}-message`, `${privateMarker}-stack`]);
      assert.equal(calls, 1); assert.equal(touched, 0);
    }));
  }
}
