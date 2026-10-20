import assert from 'node:assert/strict';
import test from 'node:test';
import { teamsHelp, teamsMain, parseTeamsArgs } from '../../src/local-runtime/teams-delivery-cli.js';
import { TeamsDelivery } from '../../src/memory/teams-delivery.js';
import { fixture } from './fixture.js';

const due = Date.UTC(2026, 9, 18, 4, 30), hash = 'a'.repeat(64);
test('strict CLI refuses URL/token/send/adapter flags and destination without explicit binding/consent', () => {
  const base = ['config', '--workspace', '/project', '--state-dir', '/private/state', '--enable', 'true'];
  for (const suffix of [['--webhook-url', 'https://private.invalid/secret'], ['--token', 'private-token'],
    ['--adapter', '/private/adapter.js'], ['--recipient', 'a@example.invalid'], ['--destination-id', 'team'],
    ['--endpoint-binding', hash], ['--consent', 'true'], ['--enable', 'false'], ['--max-bytes', '24577']]) {
    assert.throws(() => parseTeamsArgs([...base, ...suffix]));
  }
  assert.throws(() => parseTeamsArgs(['send', ...base.slice(1)]));
  assert.throws(() => parseTeamsArgs(['status', ...base.slice(1)]));
  assert.throws(() => parseTeamsArgs(['outbox', '--workspace', '/project', '--state-dir', '/private/state', '--limit', '101']));
  assert.equal(parseTeamsArgs([...base, '--destination-id', 'team', '--endpoint-binding', hash, '--consent', 'true']).command, 'config');
  assert.equal(parseTeamsArgs(['--help']).command, 'help'); assert.match(teamsHelp, /CLI never sends/);
});
test('compiled main config/status/preview/tick/outbox preserve schedule and recover interrupted stdout', () => {
  const f = fixture(); let now = due - 1, stdout = '', stderr = '';
  const io = { stdout: (s: string) => { stdout = s; }, stderr: (s: string) => { stderr = s; } };
  const paths = ['--workspace', f.root, '--state-dir', f.directory];
  const call = (...args: string[]) => { assert.equal(teamsMain([args[0]!, ...paths, ...args.slice(1)], io, () => now), 0); return JSON.parse(stdout); };
  try {
    assert.equal(call('status').status, 'disabled');
    call('config', '--enable', 'true', '--destination-id', 'team', '--endpoint-binding', hash, '--consent', 'true');
    assert.equal(call('status').schedule.enabled, false);
    const d = new TeamsDelivery(f.directory, f.root, () => now); d.schedule.configure(); d.close(); now = due;
    assert.equal(teamsMain(['tick', ...paths], { stdout() { throw Error('stdout fixture'); }, stderr: io.stderr }, () => now), 2);
    assert.equal(call('tick').delivery.status, 'existing'); assert.equal(call('outbox').length, 1);
    assert.equal(call('preview').status, 'ready'); assert.match(call('preview').payload.text, /ForgeMind weekly summary/);
    assert.equal(call('outbox')[0].attempts, 0);
    call('config', '--enable', 'false');
    assert.equal(call('status').schedule.enabled, true); assert.equal(call('outbox').length, 1);
    assert.match(stderr, /Teams command failed/);
  } finally { f.dispose(); }
});
test('errors never echo secret arguments or invalid owner paths', () => {
  let stdout = '', stderr = '';
  const io = { stdout: (s: string) => { stdout += s; }, stderr: (s: string) => { stderr += s; } };
  const secret = 'https://workflow.invalid/private-secret-token';
  assert.equal(teamsMain(['send', '--url', secret], io), 2);
  assert.equal(stdout, ''); assert.ok(!stderr.includes(secret)); assert.ok(!stderr.includes('private-secret-token'));
});
