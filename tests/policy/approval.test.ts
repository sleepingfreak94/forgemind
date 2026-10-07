import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fixture.js';

test('merge requires exact single-use owner approval, without broadening authority', t => {
  const f = fixture(t);
  const grant = f.grant({ role: 'lead', capabilities: [{ action: 'git.merge', resource: 'repo:fixture:ticket-1' }] });
  const intent = f.request({ action: 'git.merge', resource: 'repo:fixture:ticket-1' });
  delete intent.content;
  const execute = f.runtime.bind(grant.id, 'coder-1').execute;
  assert.equal(execute(intent).decision.outcome, 'approval-required');
  assert.equal(f.runtime.fake.calls.length, 0);
  f.runtime.approve(grant.id, 'coder-1', intent);
  assert.equal(execute(intent).status, 'succeeded');
  assert.equal(execute(intent).decision.reason, 'replayed-request');
  assert.equal(execute({ ...intent, requestId: 'another-request' }).decision.outcome, 'approval-required');
  assert.throws(() => f.runtime.approve(grant.id, 'coder-1', { ...intent, resource: 'repo:other:main' }), /outside-grant/);
  assert.equal(f.runtime.receipts().at(-1)?.event, 'approval.denied');
  assert.equal(f.runtime.fake.calls.length, 1);
});

test('approval cannot transfer invocation, grant, source, or policy', t => {
  const f = fixture(t);
  const grant = f.grant({ role: 'lead', capabilities: [{ action: 'release', resource: 'repo:fixture:v1' }] });
  const intent = f.request({ action: 'release', resource: 'repo:fixture:v1' });
  delete intent.content;
  f.runtime.approve(grant.id, 'coder-1', intent);
  assert.equal(f.runtime.bind(grant.id, 'other').execute(intent).decision.reason, 'invocation-mismatch');
  const other = f.grant({ role: 'lead', capabilities: grant.capabilities });
  assert.equal(f.runtime.bind(other.id, 'coder-1').execute(intent).decision.outcome, 'approval-required');
  f.setSnapshot('sha256:new-source');
  assert.equal(f.runtime.bind(grant.id, 'coder-1').execute(intent).decision.reason, 'stale-source');
  assert.equal(f.runtime.bind(grant.id, 'coder-1').execute({ ...intent, sourceSnapshot: 'sha256:new-source' }).decision.outcome, 'approval-required');
  f.runtime.updatePolicyVersion('local-v2');
  assert.equal(f.runtime.bind(grant.id, 'coder-1').execute(intent).decision.reason, 'stale-policy');
  assert.equal(f.runtime.fake.calls.length, 0);
});

test('expired approvals and revoked grants cannot execute', t => {
  const f = fixture(t);
  const grant = f.grant({ role: 'lead', expiresAt: 1000000, capabilities: [{ action: 'release', resource: 'repo:fixture:v1' }] });
  const intent = f.request({ action: 'release', resource: 'repo:fixture:v1' });
  delete intent.content;
  f.runtime.approve(grant.id, 'coder-1', intent);
  f.setTime(301000);
  assert.equal(f.runtime.bind(grant.id, 'coder-1').execute(intent).decision.outcome, 'approval-required');
  f.runtime.revoke(grant.id);
  assert.throws(() => f.runtime.approve(grant.id, 'coder-1', intent), /revoked-grant/);
  assert.equal(f.runtime.bind(grant.id, 'coder-1').execute(intent).decision.reason, 'revoked-grant');
});

test('task-scoped commit, branch push and draft PR need explicit lead capabilities', t => {
  const f = fixture(t);
  const capabilities = (['git.commit', 'git.push', 'pr.draft'] as const).map(action => ({ action, resource: 'repo:fixture:ticket-1' }));
  assert.throws(() => f.grant({ capabilities }), /lead role/);
  const grant = f.grant({ role: 'lead', capabilities });
  for (const cap of capabilities) {
    const intent = f.request(cap);
    delete intent.content;
    assert.equal(f.runtime.bind(grant.id, 'coder-1').execute(intent).status, 'succeeded');
    assert.equal(f.runtime.bind(grant.id, 'coder-1').execute({ ...intent, resource: 'repo:fixture:main' }).decision.outcome, 'deny');
  }
});
