import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { LocalPolicyRuntime } from '../../src/policy/runtime.js';
import { fixture } from './fixture.js';

test('principal, grants, approvals, revocations and receipts survive restart; sessions do not', t => {
  const f = fixture(t);
  const owner = f.runtime.principal.id;
  const parent = f.grant();
  const child = f.grant({ parentId: parent.id, remainingDepth: 0 });
  f.runtime.revoke(parent.id);
  const lead = f.grant({ role: 'lead', capabilities: [{ action: 'release', resource: 'repo:fixture:v1' }] });
  const intent = f.request({ action: 'release', resource: 'repo:fixture:v1' }); delete intent.content;
  f.runtime.approve(lead.id, 'coder-1', intent);
  const before = f.runtime.receipts();
  f.reopen();
  assert.equal(f.runtime.principal.id, owner);
  assert.equal(f.runtime.grant(parent.id)?.revoked, true);
  assert.deepEqual(f.runtime.receipts().slice(0, before.length), before);
  assert.equal(f.runtime.bind(child.id, 'coder-1').execute(f.request()).decision.reason, 'stale-session');
  assert.equal(f.runtime.bind(lead.id, 'coder-1').execute(intent).decision.reason, 'stale-session');
  assert.equal(f.runtime.fake.calls.length, 0);
});

test('a new host launch fences an older host immediately', t => {
  const f = fixture(t);
  const grant = f.grant();
  const another = LocalPolicyRuntime.open(f.options);
  t.after(() => another.close());
  assert.equal(f.runtime.bind(grant.id, 'coder-1').execute(f.request()).decision.reason, 'stale-session');
  assert.throws(() => f.grant(), /stale-session/);
  assert.equal(f.runtime.fake.calls.length, 0);
});

test('state is private, outside the workspace, and bound to its registration', t => {
  const f = fixture(t);
  assert.equal(statSync(f.options.stateDirectory).mode & 0o077, 0);
  assert.equal(statSync(join(f.options.stateDirectory, 'policy.sqlite')).mode & 0o077, 0);
  assert.throws(() => LocalPolicyRuntime.open({ ...f.options, stateDirectory: join(f.workspaceRoot, 'state') }), /outside/);
  assert.throws(() => LocalPolicyRuntime.open({ ...f.options, repositoryId: 'other' }), /another workspace/);
  const insecure = join(f.base, 'insecure'); mkdirSync(insecure); chmodSync(insecure, 0o755);
  assert.throws(() => LocalPolicyRuntime.open({ ...f.options, stateDirectory: insecure }), /private/);
});

test('symlinked state or database is rejected', t => {
  const f = fixture(t);
  const alias = join(f.base, 'alias'); symlinkSync(f.options.stateDirectory, alias);
  assert.throws(() => LocalPolicyRuntime.open({ ...f.options, stateDirectory: alias }), /canonical/);
  const dir = join(f.base, 'state-other'); mkdirSync(dir, { mode: 0o700 });
  symlinkSync(join(f.options.stateDirectory, 'policy.sqlite'), join(dir, 'policy.sqlite'));
  assert.throws(() => LocalPolicyRuntime.open({ ...f.options, stateDirectory: dir }), /unsafe policy database/);
});

test('receipt insertion failure prevents dispatch and budget consumption', t => {
  const f = fixture(t);
  const grant = f.grant();
  const db = new DatabaseSync(join(f.options.stateDirectory, 'policy.sqlite'));
  t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  assert.throws(() => f.runtime.bind(grant.id, 'coder-1').execute(f.request()), /audit unavailable/);
  assert.equal(f.runtime.fake.calls.length, 0);
  assert.equal(f.runtime.grant(grant.id)?.usedActions, 0);
});

test('completion receipt failure leaves a durable non-replayable reservation', t => {
  const f = fixture(t);
  const grant = f.grant();
  const db = new DatabaseSync(join(f.options.stateDirectory, 'policy.sqlite'));
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER fail_completion BEFORE INSERT ON receipts
    WHEN json_extract(NEW.body, '$.event') = 'execution.succeeded'
    BEGIN SELECT RAISE(ABORT, 'completion unavailable'); END`);
  const intent = f.request();
  const execute = f.runtime.bind(grant.id, 'coder-1').execute;
  assert.throws(() => execute(intent), /completion unavailable/);
  assert.equal(f.runtime.fake.calls.length, 1);
  db.exec('DROP TRIGGER fail_completion');
  assert.equal(execute(intent).decision.reason, 'replayed-request');
  assert.equal(f.runtime.fake.calls.length, 1);
  assert.equal(f.runtime.grant(grant.id)?.usedActions, 1);
});

test('authority is rechecked after reservation and before dispatch', t => {
  const f = fixture(t);
  const grant = f.grant();
  const db = new DatabaseSync(join(f.options.stateDirectory, 'policy.sqlite'));
  t.after(() => db.close());
  // Simulate a revocation becoming visible as the reservation is persisted.
  db.exec(`CREATE TRIGGER revoke_on_reservation AFTER UPDATE ON grants
    WHEN json_extract(NEW.body, '$.usedActions') = 1
    BEGIN UPDATE grants SET body = json_set(body, '$.revoked', json('true')) WHERE id = NEW.id; END`);
  const result = f.runtime.bind(grant.id, 'coder-1').execute(f.request());
  assert.equal(result.decision.reason, 'revoked-grant');
  assert.equal(result.status, 'blocked');
  assert.equal(f.runtime.fake.calls.length, 0);
  assert.equal(f.runtime.receipts().at(-1)?.event, 'execution.blocked');
});

test('unknown schema versions fail closed', t => {
  const f = fixture(t);
  f.runtime.close();
  const db = new DatabaseSync(join(f.options.stateDirectory, 'policy.sqlite'));
  db.exec('PRAGMA user_version = 99'); db.close();
  assert.throws(() => LocalPolicyRuntime.open(f.options), /unsupported policy schema/);
});

test('SQLite write contention fails closed without invoking the adapter', t => {
  const f = fixture(t);
  const grant = f.grant();
  const db = new DatabaseSync(join(f.options.stateDirectory, 'policy.sqlite'));
  t.after(() => db.close());
  db.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => f.runtime.bind(grant.id, 'coder-1').execute(f.request()), /locked/); }
  finally { db.exec('ROLLBACK'); }
  assert.equal(f.runtime.fake.calls.length, 0);
});

test('SQL-looking identifiers are values and raw content never enters audit receipts', t => {
  const f = fixture(t);
  const grant = f.grant({ taskId: "ticket'); DROP TABLE grants; --" });
  const intent = f.request({ content: 'private payload sentinel' });
  assert.equal(f.runtime.bind(grant.id, 'coder-1').execute(intent).status, 'succeeded');
  assert.equal(f.runtime.grant(grant.id)?.taskId, grant.taskId);
  const receipts = JSON.stringify(f.runtime.receipts());
  assert.equal(receipts.includes('private payload sentinel'), false);
  assert.equal(f.runtime.receipts().at(-1)?.requestDigest?.length, 64);
});
