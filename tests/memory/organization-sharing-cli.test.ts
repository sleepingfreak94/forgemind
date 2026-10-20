import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.js';

const cli = fileURLToPath(new URL('../../src/local-runtime/organization-cli.js', import.meta.url));
test('actual offline CLI bootstraps, configures, approves, shares, reads and revokes over separate processes', {
  skip: typeof process.getuid === 'function' ? false : "Organization owner storage requires process.getuid and POSIX UID/mode checks; native Windows/ACL enforcement is deferred"
}, () => {
  const f = fixture();
  try {
    const state = join(f.base, 'org'), file = join(f.base, 'grants.json');
    const common = ['--workspace', f.root, '--state-dir', state, '--memory-state-dir', f.directory, '--org', 'team', '--project', f.projectId];
    const run = (mode: string, principal: string, extra: string[] = [], expected = 0) => {
      const child = spawnSync(process.execPath, [cli, mode, ...common, '--principal', principal, ...extra], { encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, expected, child.stderr + child.stdout);
      assert.equal(child.error, undefined);
      return JSON.parse(child.stdout);
    };
    run('bootstrap', 'owner'); run('bootstrap', 'other', [], 2);
    run('member', 'owner', ['--member', 'writer', '--role', 'editor', '--status', 'active']);
    run('member', 'owner', ['--member', 'viewer', '--role', 'reader', '--status', 'active']);
    writeFileSync(file, JSON.stringify([
      { principalId: 'owner', read: true, share: true }, { principalId: 'writer', read: true, share: true },
      { principalId: 'viewer', read: true, share: false }
    ]), { mode: 0o600 });
    run('config', 'owner', ['--enabled', 'true', '--grants-file', file]);
    const id = f.memory.add(f.input()); f.memory.validate(id, id);
    const inspected = run('inspect', 'owner', ['--record-id', id]);
    const approved = run('approve', 'owner', ['--record-id', id, '--record-digest', id, '--binding', inspected.value.recordBinding]);
    const copied = run('share', 'writer', ['--approval-id', approved.value.approvalId]);
    const read = run('read', 'viewer', ['--share-id', copied.value.shareId]);
    assert.equal(read.value.record.text, f.input().text);
    assert.equal(read.value.trust, 'evidence-only');
    run('revoke', 'owner', ['--share-id', copied.value.shareId]);
    run('read', 'viewer', ['--share-id', copied.value.shareId], 2);
    run('promote', 'owner', [], 2);
    const receipts = run('status', 'owner');
    assert.equal(receipts.value.copies[0].revoked, true);
    run('member', 'owner', ['--member', 'viewer', '--role', 'reader', '--status', 'revoked']);
    run('read', 'viewer', ['--share-id', copied.value.shareId], 2);
    chmodSync(file, 0o644);
    const unsafe = spawnSync(process.execPath, [cli, 'config', ...common, '--principal', 'owner', '--enabled', 'true', '--grants-file', file], { encoding: 'utf8' });
    assert.equal(unsafe.status, 2);
    assert.ok(!unsafe.stderr.includes(file));
    assert.match(unsafe.stderr, /Organization command failed/);
  } finally { f.dispose(); }
});
test('CLI rejects duplicate/unknown flags and sanitizes errors rather than echoing input', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /asserted labels/);
  for (const args of [['bootstrap', '--secret', 'private-value'], ['bootstrap', '--workspace', 'private-value', '--workspace', 'private-value']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes('private-value'));
    assert.match(result.stderr, /Organization command failed/);
  }
});
