import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryMain, parseDeliveryArgs } from '../../src/local-runtime/weekly-delivery-cli.js';
import { WeeklyDelivery } from '../../src/memory/weekly-delivery.js';
import { fixture } from './fixture.js';

const due = Date.UTC(2026, 9, 18, 4, 30);

test('strict CLI parsing rejects duplicate, unknown, inapplicable and unsafe flags', () => {
  const base = ['--workspace', '/canonical/project', '--state-dir', '/private/state'];
  assert.deepEqual(parseDeliveryArgs(['--help']), { command: 'help' });
  for (const args of [
    ['send', ...base], ['tick', ...base, '--enable', 'true'], ['config', ...base],
    ['config', ...base, '--enable', 'yes'], ['config', ...base, '--enable', 'true', '--recipient', 'a@example.invalid'],
    ['config', ...base, '--enable', 'true', '--consent', 'true'],
    ['config', ...base, '--enable', 'true', '--recipient', 'a@example.invalid\r\nInjected: true', '--consent', 'true'],
    ['tick', ...base, '--workspace', '/another'], ['status', '--workspace', '../x', '--state-dir', '/private/state'],
    ['status', '--workspace', '/tmp/../x', '--state-dir', '/private/state'], ['tick', ...base, '--adapter', 'service'],
    ['outbox', ...base, '--limit', '01'], ['outbox', ...base, '--limit', '0'], ['outbox', ...base, '--after', 'bad']
  ]) assert.throws(() => parseDeliveryArgs(args));
  let touched = false;
  const args = Object.defineProperty(['status', ...base], '0', { get() { touched = true; return 'status'; } });
  assert.throws(() => parseDeliveryArgs(args)); assert.equal(touched, false);
  assert.throws(() => parseDeliveryArgs(new Proxy(['status', ...base], {})));
});

test('pure compiled main exercises config/status/tick/outbox and stdout failure recovery', () => {
  const f = fixture(); let now = due - 1, output = '', error = '';
  const io = { stdout(text: string) { output = text; }, stderr(text: string) { error = text; } };
  const base = ['--workspace', f.root, '--state-dir', f.directory];
  const invoke = (command: string, extra: string[] = []) => deliveryMain([command, ...base, ...extra], io, () => now);
  try {
    assert.equal(invoke('status'), 0); assert.equal(JSON.parse(output).status, 'disabled');
    assert.equal(invoke('config', ['--enable', 'true']), 0); assert.equal(JSON.parse(output).status, 'pending-configuration');
    now = due; assert.equal(invoke('tick'), 0);
    assert.equal(JSON.parse(output).delivery.status, 'pending-configuration');
    assert.equal(invoke('config', ['--enable', 'true', '--recipient', 'owner@example.invalid', '--consent', 'true']), 0);
    const privateError = Object.defineProperty({}, 'message', { get() { throw new Error('must not inspect thrown object'); } });
    const broken = { stdout() { throw privateError; }, stderr: io.stderr };
    assert.equal(deliveryMain(['tick', ...base], broken, () => now), 2);
    assert.equal(error, 'Weekly delivery command failed: invalid owner input. Use --help.\n');
    assert.equal(invoke('outbox'), 0); const persisted = output;
    assert.equal(JSON.parse(output).length, 1); assert.equal(JSON.parse(output)[0].status, 'pending');
    assert.equal(invoke('tick'), 0); assert.equal(JSON.parse(output).delivery.status, 'existing');
    assert.equal(invoke('outbox'), 0); assert.equal(output, persisted);
    assert.equal(invoke('config', ['--enable', 'false']), 0);
    now += 7 * 86400000; assert.equal(invoke('tick'), 0); assert.equal(JSON.parse(output).delivery.status, 'disabled');
    assert.equal(invoke('outbox'), 0); assert.equal(output, persisted);
    const d = new WeeklyDelivery(f.directory, f.root, () => now);
    try { assert.equal(d.schedule.result().dueAt, due); } finally { d.close(); }
  } finally { f.dispose(); }
});

test('public CLI errors are generic and do not expose owner paths/input', () => {
  let out = '', error = '';
  const code = deliveryMain(['secret-invalid-command'], { stdout: s => { out += s; }, stderr: s => { error += s; } });
  assert.equal(code, 2); assert.equal(out, '');
  assert.equal(error, 'Weekly delivery command failed: invalid owner input. Use --help.\n');
});
