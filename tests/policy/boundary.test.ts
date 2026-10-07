import assert from 'node:assert/strict';
import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './fixture.js';

test('allowed fake write records a receipt without changing real workspace files', t => {
  const f = fixture(t);
  const grant = f.grant();
  const result = f.runtime.bind(grant.id, 'coder-1').execute(f.request());
  assert.equal(result.decision.outcome, 'allow');
  assert.equal(result.status, 'succeeded');
  assert.equal(f.runtime.fake.calls.length, 1);
  assert.equal(f.runtime.fake.read(join(f.workspaceRoot, 'src/example.ts')), 'export const value = 1;');
  assert.equal(existsSync(join(f.workspaceRoot, 'src/example.ts')), false);
  assert.equal(f.runtime.receipts().at(-1)?.event, 'execution.succeeded');
});

test('unknown grant and wrong invocation cannot execute', t => {
  const f = fixture(t);
  const grant = f.grant();
  for (const [id, invocation] of [['unknown', 'coder-1'], [grant.id, 'imposter']]) {
    const result = f.runtime.bind(id!, invocation!).execute(f.request());
    assert.equal(result.decision.outcome, 'deny');
  }
  assert.equal(f.runtime.fake.calls.length, 0);
});

test('outside scope, traversal, prefix sibling, and symlink requests have zero calls', t => {
  const f = fixture(t);
  const grant = f.grant();
  symlinkSync(f.base, join(f.workspaceRoot, 'escape'));
  const execute = f.runtime.bind(grant.id, 'coder-1').execute;
  for (const resource of ['src/other.ts', '../outside.ts',
    `${f.workspaceRoot}-other/file.ts`, 'escape/outside.ts', 'src/../src/example.ts']) {
    assert.equal(execute(f.request({ resource })).decision.outcome, 'deny', resource);
  }
  assert.equal(f.runtime.fake.calls.length, 0);
});

test('malformed input and forged authority fields fail closed', t => {
  const f = fixture(t);
  const grant = f.grant();
  const execute = f.runtime.bind(grant.id, 'coder-1').execute;
  for (const raw of [null, [], {}, { ...f.request(), action: 'shell.exec' },
    { ...f.request(), owner: f.runtime.principal.id }, { ...f.request(), approved: true },
    { ...f.request(), content: 'a'.repeat(65537) }]) {
    assert.equal(execute(raw).decision.outcome, 'deny');
  }
  assert.equal(f.runtime.fake.calls.length, 0);
});

test('source snapshot, expiry boundary and policy changes invalidate authority', t => {
  const f = fixture(t);
  const grant = f.grant();
  const execute = f.runtime.bind(grant.id, 'coder-1').execute;
  const stale = f.request();
  f.setSnapshot('sha256:changed');
  assert.equal(execute(stale).decision.reason, 'stale-source');
  f.setTime(10000);
  assert.equal(execute(f.request()).decision.reason, 'expired-grant');
  f.setTime(1000);
  f.runtime.updatePolicyVersion('local-v2');
  assert.equal(execute(f.request()).decision.reason, 'stale-policy');
  assert.equal(f.runtime.fake.calls.length, 0);
});

test('research and review profiles cannot receive write capabilities', t => {
  const f = fixture(t);
  for (const role of ['researcher', 'reviewer', 'architect'] as const) {
    assert.throws(() => f.grant({ role }), /role/);
    const read = f.grant({ role, invocationId: role,
      capabilities: [{ action: 'file.read', resource: 'src/example.ts' }] });
    const request = f.request({ action: 'file.read' });
    delete request.content;
    assert.equal(f.runtime.bind(read.id, role).execute(request).decision.outcome, 'allow');
  }
});

test('request IDs cannot replay a successful side effect', t => {
  const f = fixture(t);
  const grant = f.grant();
  const execute = f.runtime.bind(grant.id, 'coder-1').execute;
  const request = f.request();
  assert.equal(execute(request).status, 'succeeded');
  assert.equal(execute(request).decision.reason, 'replayed-request');
  assert.equal(f.runtime.fake.calls.length, 1);
});
