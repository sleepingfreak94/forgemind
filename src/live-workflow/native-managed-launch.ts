import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RunAuthority, privateDirectory } from './authority.js';
import { beginNativeRunCapture } from './native-run-capture.js';
import { validateBudget } from './native-executor-contracts.js';
import type { NativeTask } from './native-executor-contracts.js';
import { sourceIdentity } from './repository.js';
import { sha256 } from './validation.js';

export const MANAGED_TERMINAL_LIMIT = 2 * 1024 * 1024;
const TERMINATE_GRACE_MS = 5000, KILL_SETTLE_MS = 250;
const names = ['native-terminal.log', 'terminal-output.log'] as const;
type StopReason = 'overflow' | 'aborted' | 'deadline' | 'spawn-failed' |
  'capture-create-failed' | 'capture-write-failed' | 'mirror-failed' | 'stream-failed' | 'child-signaled';
export interface ManagedTerminalResult {
  exitCode: number; signal: string | null; directory: string;
  complete: boolean; reason: StopReason | null; childClosed: boolean;
  cleanup: 'not-verified'; termSent: boolean; killSent: boolean;
  copies: { name: string; created: boolean; bytes: number; sha256: string }[];
  identicalCopies: boolean;
}
/** Trusted owner test/IO port, never a model tool, grant, or preflight capability.
 * spawn MUST create one detached owned process group with piped stdout/stderr.
 * Only the owner CLI terminal stream belongs here, never native RPC, stderr,
 * home directories or transcripts. The logs are identical copies, NOT
 * independent witnesses; interleaving follows arrival of script pipe chunks. */
export async function collectManagedTerminal(options: {
  directory: string; runtimeMs: number; spawn: () => ChildProcess;
  mirror: (chunk: Buffer) => void; signal?: AbortSignal;
}): Promise<ManagedTerminalResult> {
  if (!Number.isSafeInteger(options.runtimeMs) || options.runtimeMs < 1 || options.runtimeMs > 2147483647)
    throw new Error('Bounded terminal runtime required');
  const deadline = Date.now() + options.runtimeMs;
  const directory = privateDirectory(options.directory);
  const copies = names.map(name => ({ name, fd: undefined as number | undefined, bytes: 0, hash: createHash('sha256') }));
  let reason: StopReason | null = null, child: ChildProcess | undefined;
  let childClosed = false, exitCode: number | null = null, signal: string | null = null;
  let termSent = false, killSent = false, settled = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined, settleTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  function groupAlive(): boolean {
    if (!child?.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  function groupSignal(value: 'SIGTERM' | 'SIGKILL'): boolean {
    if (!child?.pid) return false;
    try { process.kill(-child.pid, value); return true; } catch { return false; }
  }
  function finish(): void {
    if (settled) return; settled = true;
    clearTimeout(deadlineTimer); clearTimeout(killTimer); clearTimeout(settleTimer);
    options.signal?.removeEventListener('abort', abort);
    child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
    resolveDone();
  }
  function stop(value: StopReason): void {
    if (settled || reason) return;
    reason = value;
    if (!child?.pid) { finish(); return; }
    termSent = groupSignal('SIGTERM');
    // A closed script PID is not proof that native descendants were reaped.
    killTimer = setTimeout(() => {
      killSent = groupSignal('SIGKILL');
      settleTimer = setTimeout(finish, KILL_SETTLE_MS);
      if (childClosed && !groupAlive()) finish();
    }, TERMINATE_GRACE_MS);
  }
  const abort = () => stop('aborted');
  function consume(chunk: Buffer): void {
    if (reason || settled) return;
    if (Date.now() >= deadline) { stop('deadline'); return; }
    // Reject the entire next chunk before either write; never truncate to fit.
    if (copies.some(copy => copy.bytes + chunk.length > MANAGED_TERMINAL_LIMIT)) { stop('overflow'); return; }
    try {
      for (const copy of copies) {
        let offset = 0;
        while (offset < chunk.length) {
          const count = writeSync(copy.fd!, chunk, offset, chunk.length - offset);
          if (count < 1) throw new Error('Terminal write stalled');
          copy.hash.update(chunk.subarray(offset, offset + count));
          copy.bytes += count; offset += count;
        }
      }
    } catch { stop('capture-write-failed'); return; }
    try { options.mirror(chunk); } catch { stop('mirror-failed'); }
  }
  try {
    // Both exclusive private raw copies exist before spawn.
    for (const copy of copies) copy.fd = openSync(join(directory, copy.name), 'wx', 0o600);
  } catch { reason = 'capture-create-failed'; finish(); }
  if (!reason) {
    if (options.signal?.aborted) { reason = 'aborted'; finish(); }
    else {
      try {
        child = options.spawn();
        child.on('error', () => stop('spawn-failed'));
        child.once('close', (code, value) => {
          childClosed = true; exitCode = code; signal = value;
          if (!reason && value) reason = 'child-signaled';
          if (!reason && Date.now() >= deadline) reason = 'deadline';
          if (!reason || !groupAlive()) finish();
          else if (!killTimer) stopAfterSignal();
        });
        function stopAfterSignal(): void {
          const value = reason!; reason = null; stop(value);
        }
        if (!child.stdout || !child.stderr) stop('stream-failed');
        else {
          child.stdout.on('data', consume); child.stderr.on('data', consume);
          child.stdout.on('error', () => stop('stream-failed'));
          child.stderr.on('error', () => stop('stream-failed'));
        }
        options.signal?.addEventListener('abort', abort, { once: true });
        deadlineTimer = setTimeout(() => stop('deadline'), Math.max(1, deadline - Date.now()));
        if (options.signal?.aborted) abort();
      } catch { stop('spawn-failed'); }
    }
  }
  await done;
  for (const copy of copies) if (copy.fd !== undefined) {
    try { fsyncSync(copy.fd); } catch { reason ??= 'capture-write-failed'; }
    try { closeSync(copy.fd); } catch { reason ??= 'capture-write-failed'; }
  }
  const result: ManagedTerminalResult = {
    directory, exitCode: exitCode ?? 2, signal,
    complete: reason === null && childClosed && exitCode !== null && signal === null,
    reason, childClosed, cleanup: 'not-verified', termSent, killSent,
    copies: copies.map(copy => ({ name: copy.name, created: copy.fd !== undefined,
      bytes: copy.bytes, sha256: copy.hash.digest('hex') })), identicalCopies: false,
  };
  // Incomplete launches must never appear successful even if a TERM handler exits 0.
  if (!result.complete && result.exitCode === 0) result.exitCode = 2;
  result.identicalCopies = result.copies.every(copy => copy.created &&
    copy.bytes === result.copies[0]!.bytes && copy.sha256 === result.copies[0]!.sha256);
  if (!result.complete) writeFileSync(join(directory, 'INCOMPLETE.md'),
    '# Incomplete owner CLI terminal capture\n\nReason: ' + result.reason +
    '\n\nOnly the captured prefix is retained. Cleanup not verified; PID/group signaling is not native cleanup evidence. Automatic retries: zero.\n',
    { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'terminal.json'), JSON.stringify({ schema: 'managed-owner-terminal-v1',
    stream: 'owner-cli-structured-terminal', copiesAreIndependentWitnesses: false, ...result }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  return result;
}

/** Latch before calling a terminal writer: thrown settlement is uncertain and
 * must never trigger a second persistence attempt from a catch path. */
export function onceManagedSettlement(receipt: ReturnType<RunAuthority['reserve']>): ReturnType<RunAuthority['reserve']> {
  let attempted=false;
  return {check:()=>{if(attempted)throw new Error('Settlement already attempted');receipt.check();},
    finish:(status,digest)=>{if(attempted)return;attempted=true;receipt.finish(status,digest);}};
}
export interface ManagedNativeWorkerOptions {
  task: NativeTask; runDirectory: string; parentBinding: string; packetDigest: string; packetPath: string;
  connection: string; codexExecutable: string; workerPath: string; signal?: AbortSignal;
}
function absolute(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/.test(path))
    throw new Error('Exact owner-selected absolute paths required');
}
/** Trusted owner only: packet/worker/executable paths are selected by the owner,
 * never a model-supplied command. This parent does not read accounts or invoke
 * a model. Child scope remains exclusively the packet's NativeProject grant. */
export async function runManagedNativeWorker(options: ManagedNativeWorkerOptions):
Promise<{ exitCode: number; signal: string | null; directory: string }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Managed native launch requires the owner terminal');
  const task = structuredClone(options.task), started = Date.now();
  validateBudget(task.budget);
  for (const path of [task.root, options.runDirectory, options.packetPath, options.connection,
    options.codexExecutable, options.workerPath]) absolute(path);
  if (task.root !== realpathSync(task.root) || !/^[a-f0-9]{64}$/.test(task.source) ||
    !/^[a-f0-9]{64}$/.test(options.parentBinding) || !/^[a-f0-9]{64}$/.test(options.packetDigest) || task.budget.runtimeMs > 2147483647)
    throw new Error('Exact managed native source and parent binding required');
  const outside = relative(task.root, options.runDirectory);
  if (!(outside === '..' || outside.startsWith('..' + sep))) throw new Error('Launch state must be outside project');
  if (sourceIdentity(task.root) !== task.source) throw new Error('Stale managed native source');
  const runDirectory = privateDirectory(options.runDirectory), id = randomUUID();
  const directory = join(runDirectory, 'launches', id);
  const authority = new RunAuthority(join(runDirectory, 'launch-authority', id), task.root, task.project, {
    schemaVersion: 1, taskId: 'launch-' + id, objective: 'Bounded private owner CLI launch',
    readPaths: [], writePaths: [], checks: [], model: 'none', effort: 'low', maxModelRequests: 0,
    maxPromptBytes: 1, maxOutputBytes: 2 * MANAGED_TERMINAL_LIMIT,
    maxRuntimeMs: task.budget.runtimeMs + TERMINATE_GRACE_MS + KILL_SETTLE_MS + 30000, draftPr: false,
  }, task.source);
  let capture: ReturnType<typeof beginNativeRunCapture> | undefined, successful = false;
  let launch: ReturnType<RunAuthority['reserve']> | undefined, raw: ReturnType<RunAuthority['reserve']> | undefined;
  let captureFinished = false;
  const args = ['-q', '/dev/null', process.execPath, options.workerPath, '--packet', options.packetPath,
    '--connection', options.connection, '--codex', options.codexExecutable, '--state', runDirectory,
    '--expected-packet-digest', options.packetDigest, '--expected-parent-binding', options.parentBinding];
  try {
    raw = onceManagedSettlement(authority.reserve({ kind: 'artifact', source: task.source,
      detail: { operation: 'native.managed-terminal', directory, names, maxBytesPerCopy: MANAGED_TERMINAL_LIMIT,
        copiesAreIndependentWitnesses: false } }));
    raw.check(); privateDirectory(join(runDirectory, 'launches')); mkdirSync(directory, { mode: 0o700 });
    capture = beginNativeRunCapture(task, runDirectory, options.parentBinding, task.budget.runtimeMs);
    launch = onceManagedSettlement(authority.reserve({ kind: 'command', source: task.source,
      detail: { operation: 'native.managed-launch', executable: '/usr/bin/script', args, cwd: task.root,
        detached: true, stdin: 'inherited-owner-tty', parentBinding: options.parentBinding } }));
    const result = await collectManagedTerminal({
      directory, runtimeMs: Math.max(1, task.budget.runtimeMs - (Date.now() - started)),
      ...(options.signal ? { signal: options.signal } : {}),
      mirror: chunk => { process.stdout.write(chunk); },
      spawn: () => {
        launch!.check(); options.signal?.throwIfAborted();
        if (sourceIdentity(task.root) !== task.source) throw new Error('Stale launch source');
        return spawn('/usr/bin/script', args, { cwd: task.root, detached: true, stdio: ['inherit', 'pipe', 'pipe'] });
      },
    });
    raw.finish(result.complete ? 'completed' : 'indeterminate', sha256(JSON.stringify(result))); raw = undefined;
    launch.finish(result.complete && result.exitCode === 0 ? 'completed' : 'failed',
      sha256(JSON.stringify({ exitCode: result.exitCode, signal: result.signal }))); launch = undefined;
    // Observation only: authorized child edits do not stale the initial parent
    // action, transition its authority, or imply additional child capabilities.
    let observedFinalSource: string | null = null;
    try { observedFinalSource = sourceIdentity(task.root); } catch { /* Explicit unavailable observation below. */ }
    const selected = { schema: 'managed-native-launch-v1', source: task.source, observedFinalSource,
      parentBinding: options.parentBinding, terminal: result };
    const receipt = authority.reserve({ kind: 'artifact', source: task.source,
      detail: { operation: 'native.managed-launch-status', directory } });
    receipt.check();
    writeFileSync(join(directory, 'launch.json'), JSON.stringify(selected, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    receipt.finish('completed', sha256(JSON.stringify(selected)));
    captureFinished = true;
    capture.finish(selected, result.complete && result.exitCode === 0 ? undefined :
      { phase: 'managed-launch', code: result.reason ?? 'worker-exit' });
    successful = result.complete && result.exitCode === 0;
    return { exitCode: result.exitCode, signal: result.signal, directory };
  } catch {
    try { raw?.finish('indeterminate'); } catch { /* Preserve uncertain reservation. */ }
    try { launch?.finish('indeterminate'); } catch { /* Preserve uncertain reservation. */ }
    if (capture && !captureFinished) {
      captureFinished = true;
      try { capture.finish({ source: task.source, phase: 'managed-launch', status: 'incomplete',
        cleanup: 'not-verified', directory }, { phase: 'managed-launch', code: 'capture-unavailable' }); } catch { /* No retry. */ }
    }
    try {
    writeFileSync(join(directory, 'LAUNCH-INCOMPLETE.md'),
      '# Managed launch incomplete\n\nCapture or policy unavailable. Cleanup not verified. Automatic retries: zero.\n',
      { flag: 'wx', mode: 0o600 });
    } catch { /* An unavailable capture directory cannot hold a marker; durable owner receipts remain. */ }
    return { exitCode: 2, signal: null, directory };
  } finally {
    try { capture?.close(); } finally { authority.finish(successful ? 'completed' : 'failed'); authority.close(); }
  }
}
