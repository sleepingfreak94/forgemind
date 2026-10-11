import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { supervised } from '../../src/live-workflow/process.js';

// Real IPC fd failure with a bounded send cap. Only the fork transport is a fixture;
// the production supervised stop/error/deadline/close code runs unchanged.
for (const trigger of ['cancel', 'error'] as const) test('broken supervisor IPC stops once on ' + trigger + ' and leaves cleanup uncertain', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'fm-stop-'))), path = join(directory, 'child.mjs');
  writeFileSync(path, "import{closeSync}from'node:fs';process.on('error',()=>{});process.on('message',m=>{if(m==='start')process.send({type:'fixture-ready'},()=>closeSync(3));});setInterval(()=>{},1000);");
  const originalFork = childProcess.fork, controller = new AbortController();
  let sends = 0, errors = 0, stale = false, heartbeat = false, child: childProcess.ChildProcess | undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  t.mock.method(childProcess, 'fork', () => {
    child = originalFork(path, [], { execArgv: [], stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    const p = child, send = p.send;
    t.mock.method(p, 'send', (message: unknown, ...rest: unknown[]) => {
      if (message === 'stop' && ++sends >= 1000) { p.disconnect(); p.kill('SIGKILL'); return false; }
      return Reflect.apply(send, p, [message, ...rest]) as boolean;
    });
    p.on('error', () => { errors++; });
    p.on('message', message => {
      if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'fixture-ready') return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      assert.equal(p.connected, true, 'descriptor closes while disconnect IO is still pending');
      stale = true;
      if (trigger === 'cancel') controller.abort(); else p.emit('error', new Error('Fixture supervisor error'));
      timers.push(setTimeout(() => { heartbeat = true; }, 80));
      timers.push(setTimeout(() => p.kill('SIGKILL'), 200));
    });
    return p;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(supervised({ executable: realpathSync(process.execPath), args: [], cwd: directory,
      env: {}, profile: 'trusted-host-test-fork-fixture', timeoutMs: 1000, maxOutputBytes: 128,
      signal: controller.signal, check: () => { if (stale) throw new Error('Expired authority'); } }), /Supervisor cleanup uncertain/);
    assert.equal(sends, 1, 'terminal cancellation must not resend stop on IPC errors or subsequent polls');
    assert.equal(errors, trigger === 'error' ? 1 : 0, 'send callback consumes IPC EPIPE rather than recursively emitting process errors');
    assert.equal(heartbeat, true, 'IO/timers remain responsive after the failed stop send');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    child?.kill('SIGKILL'); t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true });
  }
});
