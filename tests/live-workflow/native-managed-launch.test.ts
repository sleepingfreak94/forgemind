import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectManagedTerminal, onceManagedSettlement, MANAGED_TERMINAL_LIMIT, runManagedNativeWorker } from '../../src/live-workflow/native-managed-launch.js';
import type { ManagedTerminalResult } from '../../src/live-workflow/native-managed-launch.js';
import type { NativeTask } from '../../src/live-workflow/native-executor-contracts.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-managed-terminal-')));
  const directory = join(root, 'launch'); mkdirSync(directory, { mode: 0o700 });
  return { root, directory, close: () => rmSync(root, { recursive: true, force: true }) };
}
function child(code: string) {
  // Offline owner fixture only, no provider executable/account/model invocation.
  return spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', LANG: 'C' } });
}
function verify(result: ManagedTerminalResult, mirror?: Buffer[]) {
  const terminal = JSON.parse(readFileSync(join(result.directory, 'terminal.json'), 'utf8'));
  assert.equal(terminal.copiesAreIndependentWitnesses, false);
  assert.equal(terminal.stream, 'owner-cli-structured-terminal');
  assert.equal(terminal.cleanup, 'not-verified');
  assert.equal(lstatSync(result.directory).mode & 0o777, 0o700);
  for (const copy of result.copies) if (copy.created) {
    const path = join(result.directory, copy.name), bytes = readFileSync(path);
    assert.equal(bytes.length, copy.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), copy.sha256);
    assert.ok(bytes.length <= MANAGED_TERMINAL_LIMIT);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
  }
  if (result.identicalCopies) {
    const first = readFileSync(join(result.directory, 'native-terminal.log'));
    assert.deepEqual(first, readFileSync(join(result.directory, 'terminal-output.log')));
    if (mirror) assert.deepEqual(first, Buffer.concat(mirror));
  }
  assert.equal(existsSync(join(result.directory, 'INCOMPLETE.md')), !result.complete);
  if (!result.complete) assert.match(readFileSync(join(result.directory, 'INCOMPLETE.md'), 'utf8'),
    /captured prefix[\s\S]*Cleanup not verified[\s\S]*retries: zero/);
  assert.equal(lstatSync(join(result.directory, 'terminal.json')).mode & 0o777, 0o600);
}

test('raw copies exist privately before offline spawn, tee merged bytes exactly, including binary output', async () => {
  const f = fixture(), mirror: Buffer[] = []; let starts = 0;
  try {
    const result = await collectManagedTerminal({ directory: f.directory, runtimeMs: 5000,
      mirror: chunk => { mirror.push(Buffer.from(chunk)); },
      spawn: () => {
        starts++;
        for (const name of ['native-terminal.log', 'terminal-output.log']) {
          assert.equal(lstatSync(join(f.directory, name)).mode & 0o777, 0o600);
          assert.equal(readFileSync(join(f.directory, name)).length, 0);
        }
        return child('process.stdout.write(Buffer.from([0,255,65])); process.stderr.write("owner-status");');
      } });
    assert.equal(starts, 1); assert.equal(result.exitCode, 0); assert.equal(result.signal, null);
    assert.equal(result.complete, true); assert.equal(result.reason, null);
    assert.equal(result.identicalCopies, true); verify(result, mirror);
    const raw = readFileSync(join(f.directory, 'native-terminal.log'));
    assert.ok(raw.includes(Buffer.from([0,255,65]))); assert.ok(raw.includes(Buffer.from('owner-status')));
  } finally { f.close(); }
});

test('worker exit 2 is retained as exit 2 with a complete capture, never native PASS', async () => {
  const f = fixture();
  try {
    const result = await collectManagedTerminal({ directory: f.directory, runtimeMs: 5000, mirror: () => {},
      spawn: () => child('process.stderr.write(JSON.stringify({status:"blocked",code:"offline"})); process.exitCode=2;') });
    assert.equal(result.exitCode, 2); assert.equal(result.complete, true);
    assert.equal(result.cleanup, 'not-verified'); verify(result);
    assert.equal(readFileSync(join(f.directory, 'terminal.json'), 'utf8').includes('PASS'), false);
  } finally { f.close(); }
});

test('exactly 2 MiB fits without truncation', async () => {
  const f = fixture();
  try {
    const result = await collectManagedTerminal({ directory: f.directory, runtimeMs: 5000, mirror: () => {},
      spawn: () => child('process.stdout.write(Buffer.alloc(2*1024*1024,65));') });
    assert.equal(result.complete, true); assert.equal(result.copies[0]!.bytes, MANAGED_TERMINAL_LIMIT);
    assert.equal(result.identicalCopies, true); verify(result);
  } finally { f.close(); }
});

test('overflow checks before writing either copy and preserves the exact mirrored prefix with zero retries', async () => {
  const f = fixture(), mirror: Buffer[] = []; let starts = 0;
  try {
    const result = await collectManagedTerminal({ directory: f.directory, runtimeMs: 10000,
      mirror: chunk => { mirror.push(Buffer.from(chunk)); },
      spawn: () => { starts++; return child('process.stdout.write("prefix\\n"); setTimeout(()=>process.stdout.write(Buffer.alloc(3*1024*1024,66)),50); setInterval(()=>{},1000);'); } });
    assert.equal(starts, 1); assert.equal(result.complete, false); assert.equal(result.reason, 'overflow');
    assert.notEqual(result.exitCode, 0); assert.equal(result.termSent, true);
    assert.ok(result.copies[0]!.bytes >= 7); assert.ok(result.copies[0]!.bytes <= MANAGED_TERMINAL_LIMIT);
    assert.ok(readFileSync(join(f.directory, 'native-terminal.log')).subarray(0,7).equals(Buffer.from('prefix\n')));
    verify(result, mirror);
  } finally { f.close(); }
});

test('owner cancellation stops only the owned group, marks incomplete even when TERM exits 0', async () => {
  const f = fixture(), controller = new AbortController(); let starts = 0;
  const unrelated = child('setInterval(()=>{},1000);');
  try {
    const result = await collectManagedTerminal({ directory: f.directory, runtimeMs: 10000, signal: controller.signal,
      mirror: () => controller.abort(),
      spawn: () => { starts++; return child('process.on("SIGTERM",()=>process.exit(0)); process.stdout.write("ready"); setInterval(()=>{},1000);'); } });
    assert.equal(starts, 1); assert.equal(result.complete, false); assert.equal(result.reason, 'aborted');
    assert.equal(result.exitCode, 2); assert.equal(result.termSent, true); verify(result);
    assert.equal(process.kill(unrelated.pid!, 0), true);
  } finally {
    const closed = new Promise<void>(resolve => unrelated.once('close', () => resolve()));
    process.kill(-unrelated.pid!, 'SIGKILL'); await closed; f.close();
  }
});

test('pre-aborted capture creates private empty copies and never starts a child', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(); let starts = 0;
  try {
    const result = await collectManagedTerminal({ directory: f.directory, runtimeMs: 1000, signal: controller.signal,
      mirror: () => {}, spawn: () => { starts++; return child('process.exit(0)'); } });
    assert.equal(starts, 0); assert.equal(result.reason, 'aborted'); assert.equal(result.exitCode, 2);
    assert.equal(result.copies[0]!.bytes, 0); verify(result);
  } finally { f.close(); }
});

test('deadline is incomplete and reports child termination without claiming native cleanup', async () => {
  const f = fixture();
  try {
    const result = await collectManagedTerminal({ directory: f.directory, runtimeMs: 150,
      mirror: () => {}, spawn: () => child('process.stdout.write("waiting"); setInterval(()=>{},1000);') });
    assert.equal(result.complete, false); assert.equal(result.reason, 'deadline');
    assert.equal(result.termSent, true); assert.equal(result.cleanup, 'not-verified'); verify(result);
  } finally { f.close(); }
});

test('SIGTERM-resistant child is SIGKILL bounded after five seconds with cleanup explicitly unverified',
  { timeout: 10000 }, async () => {
  const f = fixture(), controller = new AbortController(); const start = Date.now();
  try {
    const result = await collectManagedTerminal({ directory: f.directory, runtimeMs: 9000, signal: controller.signal,
      mirror: () => controller.abort(), spawn: () => child('process.on("SIGTERM",()=>{}); process.stdout.write("ready"); setInterval(()=>{},1000);') });
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 4900 && elapsed < 8500, String(elapsed));
    assert.equal(result.reason, 'aborted'); assert.equal(result.killSent, true);
    assert.equal(result.complete, false); assert.equal(result.cleanup, 'not-verified'); verify(result);
  } finally { f.close(); }
});

test('second-copy creation failure preserves existing bytes and prevents all spawning', async () => {
  const f = fixture(); let starts = 0;
  writeFileSync(join(f.directory, 'terminal-output.log'), 'existing-private', { mode: 0o600, flag: 'wx' });
  try {
    const result = await collectManagedTerminal({ directory: f.directory, runtimeMs: 1000,
      mirror: () => {}, spawn: () => { starts++; return child('process.exit(0)'); } });
    assert.equal(starts, 0); assert.equal(result.reason, 'capture-create-failed'); assert.equal(result.complete, false);
    assert.equal(result.identicalCopies, false); assert.equal(result.copies[1]!.created, false);
    assert.equal(readFileSync(join(f.directory, 'terminal-output.log'), 'utf8'), 'existing-private'); verify(result);
  } finally { f.close(); }
});

test('asynchronous spawn error and synchronous spawn throw each fail once and retain evidence', async () => {
  for (const mode of ['async', 'sync'] as const) {
    const f = fixture(); let starts = 0;
    try {
      const result = await collectManagedTerminal({ directory: f.directory, runtimeMs: 2000, mirror: () => {},
        spawn: () => {
          starts++;
          if (mode === 'sync') throw new Error('untrusted error text must not be persisted');
          return spawn(join(f.root, 'missing-node'), [], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } });
      assert.equal(starts, 1); assert.equal(result.reason, 'spawn-failed'); assert.equal(result.exitCode, 2); verify(result);
      assert.equal(readFileSync(join(f.directory, 'terminal.json'), 'utf8').includes('untrusted error'), false);
    } finally { f.close(); }
  }
});

test('mirror error stops capture and records bounded metadata without raw error text', async () => {
  const f = fixture();
  try {
    const result = await collectManagedTerminal({ directory: f.directory, runtimeMs: 5000,
      mirror: () => { throw new Error('do not persist exception text'); },
      spawn: () => child('process.stdout.write("owner-only"); setInterval(()=>{},1000);') });
    assert.equal(result.reason, 'mirror-failed'); assert.equal(result.complete, false); verify(result);
    assert.equal(readFileSync(join(f.directory, 'terminal.json'), 'utf8').includes('exception text'), false);
  } finally { f.close(); }
});

test('managed production API refuses non-TTY before creating state or reading an account', async t => {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  t.after(() => { if (original) Object.defineProperty(process.stdin, 'isTTY', original); else Reflect.deleteProperty(process.stdin, 'isTTY'); });
  await assert.rejects(runManagedNativeWorker({ task: {} as NativeTask, runDirectory: '/never-created',
    parentBinding: 'a'.repeat(64), packetDigest: 'b'.repeat(64), packetPath: '/no-packet', connection: '/no-account',
    codexExecutable: '/no-provider', workerPath: '/no-worker' }), /requires the owner terminal/);
});

test('terminal settlement is attempted once when persistence throws before or after durable terminal',()=>{
 for(const persistFirst of [false,true]){
  let attempts=0,durable=0;
  const receipt=onceManagedSettlement({check:()=>{},finish:()=>{attempts++;if(persistFirst)durable++;throw new Error('settlement unavailable');}});
  assert.throws(()=>receipt.finish('completed'));
  receipt.finish('indeterminate');
  assert.equal(attempts,1);assert.equal(durable,persistFirst?1:0);
  assert.throws(()=>receipt.check());
 }
});
