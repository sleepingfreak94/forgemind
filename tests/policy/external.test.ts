import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixture.js';

test('external reservation charges once, rechecks revocation and commits denied terminal', t => {
  const f = fixture(t), grant = f.grant({ capabilities: [{ action: 'command.run', resource: 'host:sealed' }], maxActions: 1 });
  const request = f.request({ action: 'command.run', resource: 'host:sealed' });
  delete request.content;
  const reservation = f.runtime.reserveExternal(grant.id, grant.invocationId, request);
  assert.equal(f.runtime.fake.calls.length, 0);
  assert.equal(f.runtime.grant(grant.id)!.usedActions, 1); reservation.check();
  assert.throws(() => f.runtime.reserveExternal(grant.id, grant.invocationId, request));
  f.runtime.revoke(grant.id);
  assert.throws(() => reservation.check(), /revoked/);
  assert.throws(() => reservation.finish('completed'), /revoked/);
  assert.equal(f.runtime.receipts().at(-1)!.outcome, 'denied');
  assert.throws(() => reservation.finish('completed'), /inactive/);
});
test('restart marks unconfirmed external attempts indeterminate and fences old handle', t => {
  const f = fixture(t), grant = f.grant({ capabilities: [{ action: 'command.run', resource: 'host:sealed' }] });
  const request = f.request({ action: 'command.run', resource: 'host:sealed' });
  delete request.content;
  const reservation = f.runtime.reserveExternal(grant.id, grant.invocationId, request);
  f.reopen(); assert.throws(() => reservation.check());
  const recovered = f.runtime.receipts().find(r => r.event === 'external.recovered');
  assert.equal(recovered!.outcome, 'indeterminate'); assert.equal(recovered!.requestId, request.requestId);
  assert.throws(() => f.runtime.reserveExternal(grant.id, grant.invocationId, request), /stale-session/);
});
test('external reservations recheck policy, source, expiry and charge ancestors', t => {
  const f = fixture(t), parent = f.grant({ role: 'lead', capabilities: [{ action: 'command.run', resource: 'host:sealed' }] });
  const child = f.grant({ parentId: parent.id, remainingDepth: 1, maxActions: 2, capabilities: parent.capabilities });
  const raw = f.request({ action: 'command.run', resource: 'host:sealed' }); delete raw.content;
  const reservation = f.runtime.reserveExternal(child.id, child.invocationId, raw);
  assert.equal(f.runtime.grant(parent.id)!.usedActions, 1); assert.equal(f.runtime.grant(child.id)!.usedActions, 1);
  f.setSnapshot('changed'); assert.throws(() => reservation.check(), /stale-source/); f.setSnapshot('sha256:fixture-v1');
  f.runtime.updatePolicyVersion('v2'); assert.throws(() => reservation.check(), /stale-policy/);
  reservation.finish('failed');
});
test('expiry and wrong invocation never authorize an external effect', t => {
  const f = fixture(t), grant = f.grant({ capabilities: [{ action: 'command.run', resource: 'host:sealed' }] });
  const raw = f.request({ action: 'command.run', resource: 'host:sealed' });
  delete raw.content;
  assert.throws(() => f.runtime.reserveExternal(grant.id, 'another-worker', raw), /invocation-mismatch/);
  const reservation = f.runtime.reserveExternal(grant.id, grant.invocationId, raw);
  f.setTime(10000); assert.throws(() => reservation.check(), /expired/); reservation.finish('timed-out');
});
