import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fixture.js';
import type { GrantInput } from '../../src/policy/contracts.js';

test('child can narrow authority and cannot add resources, limits, task or lifetime', t => {
  const f = fixture(t);
  const parent = f.grant();
  const child: Partial<GrantInput> = { parentId: parent.id, invocationId: 'child', remainingDepth: 1,
    maxActions: 5, maxChildren: 1, expiresAt: 9000 };
  for (const escalation of [
    { capabilities: [{ action: 'file.write', resource: 'src/other.ts' }] },
    { capabilities: [{ action: 'network.request', resource: 'https://example.com/' }] },
    { capabilities: [{ action: 'command.run', resource: 'test:all' }] },
    { maxActions: 11 }, { maxChildren: 5 }, { remainingDepth: 2 },
    { expiresAt: 10001 }, { taskId: 'ticket-2' },
  ] as Partial<GrantInput>[]) {
    assert.throws(() => f.grant({ ...child, ...escalation }), /escalation/);
  }
  const allowed = f.grant(child);
  assert.equal(f.runtime.bind(allowed.id, 'child').execute(f.request()).status, 'succeeded');
});

test('unknown fields cannot introduce spend, concurrency, tools, or namespace rights', t => {
  const f = fixture(t);
  for (const extra of [{ spend: 20 }, { concurrency: 8 }, { tools: ['shell'] }, { namespaces: ['*'] }]) {
    assert.throws(() => f.grant(extra as Partial<GrantInput>), /invalid fields/);
  }
  assert.equal(f.runtime.fake.calls.length, 0);
});

test('parent revocation and expiry invalidate all descendants', t => {
  const f = fixture(t);
  const parent = f.grant();
  const child = f.grant({ parentId: parent.id, invocationId: 'child', remainingDepth: 1 });
  const grandchild = f.grant({ parentId: child.id, invocationId: 'grandchild', remainingDepth: 0 });
  f.setTime(10000);
  assert.equal(f.runtime.bind(grandchild.id, 'grandchild').execute(f.request()).decision.reason, 'expired-grant');
  f.setTime(1000);
  f.runtime.revoke(parent.id);
  assert.equal(f.runtime.bind(grandchild.id, 'grandchild').execute(f.request()).decision.reason, 'revoked-grant');
  assert.throws(() => f.grant({ parentId: child.id, remainingDepth: 0 }), /inactive parent/);
  assert.equal(f.runtime.fake.calls.length, 0);
});

test('siblings share the parent action budget', t => {
  const f = fixture(t);
  const parent = f.grant({ maxActions: 2 });
  const a = f.grant({ parentId: parent.id, invocationId: 'a', remainingDepth: 0, maxActions: 2 });
  const b = f.grant({ parentId: parent.id, invocationId: 'b', remainingDepth: 0, maxActions: 2 });
  assert.equal(f.runtime.bind(a.id, 'a').execute(f.request()).status, 'succeeded');
  assert.equal(f.runtime.bind(b.id, 'b').execute(f.request()).status, 'succeeded');
  assert.equal(f.runtime.bind(a.id, 'a').execute(f.request()).decision.reason, 'action-budget-exhausted');
  assert.equal(f.runtime.grant(parent.id)?.usedActions, 2);
  assert.equal(f.runtime.fake.calls.length, 2);
});

test('delegation depth and child count cannot be recycled by revocation', t => {
  const f = fixture(t);
  const parent = f.grant({ maxChildren: 1, remainingDepth: 1 });
  const child = f.grant({ parentId: parent.id, remainingDepth: 0, maxChildren: 1 });
  assert.throws(() => f.grant({ parentId: child.id, remainingDepth: 0, maxChildren: 0 }), /escalation/);
  f.runtime.revoke(child.id);
  assert.throws(() => f.grant({ parentId: parent.id, remainingDepth: 0, maxChildren: 0 }), /escalation/);
});

test('mutating returned grants does not mutate durable authority', t => {
  const f = fixture(t);
  const grant = f.grant();
  grant.capabilities.push({ action: 'file.write', resource: 'src/other.ts' });
  grant.maxActions = 100;
  const stored = f.runtime.grant(grant.id)!;
  stored.capabilities.push({ action: 'file.write', resource: 'src/other.ts' });
  assert.equal(f.runtime.bind(grant.id, 'coder-1').execute(f.request({ resource: 'src/other.ts' })).decision.outcome, 'deny');
  assert.equal(f.runtime.grant(grant.id)?.maxActions, 10);
});
