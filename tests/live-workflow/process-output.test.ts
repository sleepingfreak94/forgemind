import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { supervised } from '../../src/live-workflow/process.js';
import { outputRun, workerTree, assertGone } from './process-output-fixture.js';
const host = { skip: process.platform !== 'darwin', timeout: 15000 };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const output = (stderr: number, exit = 0) => `process.stdout.write(Buffer.alloc(600000,120));process.stderr.write(Buffer.alloc(${stderr},121));process.exitCode=${exit};`;
const terminal = (r: Awaited<ReturnType<typeof outputRun>>) => r.messages.find(m => m.type === 'reaped');

test('LOG-A1 fixed sample retains exact bytes and digests under slow-parent backpressure', host, async () => {
  // Eight fixed cases, matching the retained private baseline/candidate probe.
  for (let i = 0; i < 8; i++) {
    const errBytes = i % 2 ? 300007 : 0;
    const r = await outputRun(output(errBytes), { slow: true });
    for (const [actual, expected] of [[r.stdout, Buffer.alloc(600000, 120)],
      [r.stderr, Buffer.alloc(errBytes, 121)]] as const) {
      assert.equal(actual.length, expected.length, `sample ${i}`);
      assert.equal(sha(actual), sha(expected), `sample ${i}`);
    }
    assert.equal(r.code, 0); assert.equal(r.signal, null);
    assert.deepEqual(terminal(r), { type: 'reaped', code: 0, signal: null, stopping: false });
    assert.deepEqual(r.events, ['reaped', 'exit', 'close']);
  }
});

test('nonzero child exit keeps complete mixed streams and the original exit code', host, async () => {
  const r = await outputRun(output(300007, 7), { slow: true });
  assert.ok(r.stdout.equals(Buffer.alloc(600000, 120)));
  assert.ok(r.stderr.equals(Buffer.alloc(300007, 121)));
  assert.equal(terminal(r)?.code, 7); assert.equal(terminal(r)?.stopping, false);
});

test('combined output limit remains enforced across both streams', host, async () => {
  const r = await outputRun(output(300007), { maxOutputBytes: 700000 });
  assert.ok(r.stdout.length + r.stderr.length <= 700000);
  assert.ok(r.messages.some(m => m.type === 'stopping' && m.reason === 'output-limit'));
  assert.equal(terminal(r)?.stopping, true);
});

for (const mode of ['cancel', 'deadline', 'disconnect', 'SIGTERM', 'SIGINT'] as const) {
  test(`${mode} reaps child and descendant before supervisor termination`, host, async () => {
    const r = await outputRun(workerTree, {
      manualDisconnect: mode === 'disconnect',
      timeoutMs: mode === 'deadline' ? 250 : 5000,
      ready: p => { if (mode === 'cancel') p.send('stop'); if (mode === 'disconnect') p.disconnect(); if (mode === 'SIGTERM' || mode === 'SIGINT') p.kill(mode); },
    });
    const pids = r.stdout.toString().trim().split(',').map(Number);
    assert.equal(pids.length, 2); assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 1));
    for (const pid of pids) await assertGone(pid);
    assert.equal(r.code, 0); assert.equal(r.signal, null);
    if (mode !== 'disconnect') {
      assert.equal(terminal(r)?.stopping, true);
      assert.ok(r.messages.some(m => m.type === 'stopping' && m.reason === (mode === 'deadline' ? 'deadline' : 'cancelled')));
    }
  });
}

test('a parent that never reads cannot hold supervisor cleanup open', host, async () => {
  const r = await outputRun('process.stdout.write(Buffer.alloc(200000,120))', { stalled: true });
  assert.ok(r.messages.some(m => m.type === 'stopping' && m.reason === 'output-drain-timeout'));
  assert.equal(r.code, 2); assert.equal(r.signal, null);
  assert.equal(terminal(r), undefined);
  assert.ok(r.elapsedMs < 4500, `cleanup took ${r.elapsedMs} ms`);
});

test('public supervised result collects full streams at terminal handoff', host, async () => {
  const r = await supervised({ executable: process.execPath, args: ['-e', output(300007)],
    cwd: process.cwd(), env: { LANG: 'C', LC_ALL: 'C' }, profile: '(version 1)(allow default)',
    timeoutMs: 5000, maxOutputBytes: 1048576 });
  assert.equal(r.code, 0);
  assert.equal(Buffer.byteLength(r.stdout), 600000);
  assert.equal(sha(Buffer.from(r.stdout)), sha(Buffer.alloc(600000, 120)));
  assert.equal(Buffer.byteLength(r.stderr), 300007);
  assert.equal(sha(Buffer.from(r.stderr)), sha(Buffer.alloc(300007, 121)));
});

test('public supervised rejects output limit, timeout, and cancellation', host, async () => {
  const request = { executable: process.execPath, cwd: process.cwd(), env: { LANG: 'C', LC_ALL: 'C' },
    profile: '(version 1)(allow default)', timeoutMs: 5000, maxOutputBytes: 1048576 };
  await assert.rejects(supervised({ ...request, args: ['-e', output(300007)], maxOutputBytes: 700000 }), /output.limit/i);
  await assert.rejects(supervised({ ...request, args: ['-e', 'setInterval(()=>{},100)'], timeoutMs: 150 }), /deadline/i);
  await assert.rejects(supervised({ ...request, args: ['-e', 'setInterval(()=>{},100)'], signal: AbortSignal.timeout(250) }), /cancel/i);
});

// Terminal IPC is private and trusted. Inject only callback starvation here.
test('terminal IPC callback starvation is bounded by the drain watchdog', host, async () => {
  const r = await outputRun('process.stdout.write(process.pid+"\\n")', {
    preload: new URL('./process-output-ipc-fixture.js', import.meta.url).pathname,
  });
  assert.ok(terminal(r), 'terminal message reached the parent');
  assert.equal(r.code, 2); assert.equal(r.signal, null);
  assert.ok(r.elapsedMs >= 1800 && r.elapsedMs < 4500, String(r.elapsedMs));
  await assertGone(Number(r.stdout.toString().trim()));
});

test('both streams retain complete output when stderr carries the 600000-byte tail', host, async () => {
  const r = await outputRun('process.stdout.write(Buffer.alloc(300007,120));process.stderr.write(Buffer.alloc(600000,121));', { slow: true });
  assert.ok(r.stdout.equals(Buffer.alloc(300007, 120)));
  assert.ok(r.stderr.equals(Buffer.alloc(600000, 121)));
  assert.equal(terminal(r)?.code, 0); assert.equal(terminal(r)?.stopping, false);
});
