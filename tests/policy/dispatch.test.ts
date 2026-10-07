import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './fixture.js';

test('command failures remain reserved and emit an accurate failure receipt', t => {
  const f = fixture(t);
  const grant = f.grant({ capabilities: [{ action: 'command.run', resource: 'test:fail' }] });
  const intent = f.request({ action: 'command.run', resource: 'test:fail' }); delete intent.content;
  const execute = f.runtime.bind(grant.id, 'coder-1').execute;
  assert.equal(execute(intent).status, 'failed');
  assert.equal(f.runtime.receipts().at(-1)?.event, 'execution.failed');
  assert.equal(execute(intent).decision.reason, 'replayed-request');
  assert.equal(f.runtime.fake.calls.length, 1);
});

test('commands and network resources use exact allowlists', t => {
  const f = fixture(t);
  const grant = f.grant({ capabilities: [
    { action: 'command.run', resource: 'test:unit' },
    { action: 'network.request', resource: 'https://example.com/approved' },
  ] });
  for (const [action, resource, allowed] of [
    ['command.run', 'test:unit', true], ['command.run', 'test:all', false],
    ['command.run', 'test:unit;rm -rf /', false],
    ['network.request', 'https://example.com/approved', true],
    ['network.request', 'https://example.com/approved/other', false],
    ['network.request', 'https://evil.example/approved', false],
    ['network.request', 'http://example.com/approved', false],
  ] as const) {
    const intent = f.request({ action, resource }); delete intent.content;
    assert.equal(f.runtime.bind(grant.id, 'coder-1').execute(intent).decision.outcome, allowed ? 'allow' : 'deny');
  }
  assert.equal(f.runtime.fake.calls.length, 2);
});

test('a symlink created after a grant is issued cannot redirect execution', t => {
  const f = fixture(t);
  const grant = f.grant();
  symlinkSync(join(f.base, 'outside.ts'), join(f.workspaceRoot, 'src/example.ts'));
  assert.equal(f.runtime.bind(grant.id, 'coder-1').execute(f.request()).decision.outcome, 'deny');
  assert.equal(f.runtime.fake.calls.length, 0);
});

test('policy rollback cannot revive old grants', t => {
  const f = fixture(t);
  const grant = f.grant();
  f.runtime.updatePolicyVersion('local-v2');
  assert.throws(() => f.runtime.updatePolicyVersion('local-v1'), /cannot be reused/);
  assert.equal(f.runtime.bind(grant.id, 'coder-1').execute(f.request()).decision.reason, 'stale-policy');
});

test('requests are copied and frozen before adapter dispatch', t => {
  const f = fixture(t);
  const grant = f.grant();
  const intent = f.request();
  f.runtime.bind(grant.id, 'coder-1').execute(intent);
  intent.content = 'changed';
  intent.resource = 'src/other.ts';
  const call = f.runtime.fake.calls[0]!;
  assert.equal(Object.isFrozen(call), true);
  assert.equal(call.content, 'export const value = 1;');
  assert.equal(f.runtime.fake.read(join(f.workspaceRoot, 'src/example.ts')), 'export const value = 1;');
});
