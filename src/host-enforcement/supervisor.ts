import { spawn } from 'node:child_process';

// Trusted standalone supervisor. Its IPC is never inherited by the sandboxed worker.
const config = JSON.parse(Buffer.from(process.argv[2]!, 'base64url').toString()) as {
  driver: 'codex' | 'cursor'; executable: string; args: string[]; cwd: string; profile: string;
  scratch: string; deadline: number; maxOutputBytes: number;
};
let stopping = false, started = false, total = 0;
let child: ReturnType<typeof spawn> | undefined;
let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
const stop = () => {
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    shutdownTimer ??= setTimeout(() => { process.send?.({ type: 'unreaped' }); process.exit(2); }, 2000);
  } else if (!child) process.exit(0);
};
process.on('disconnect', stop); // Parent crash also closes IPC.
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('uncaughtException', stop);
const deadline = setTimeout(stop, Math.max(1, config.deadline - Date.now()));
process.on('message', message => {
  if (message === 'stop') { stop(); return; }
  if (message !== 'start' || started || stopping || Date.now() >= config.deadline || !process.connected) { stop(); return; }
  started = true;
  child = spawn('/usr/bin/sandbox-exec', ['-p', config.profile, config.executable, ...config.args], {
    cwd: config.cwd, env: { HOME: config.scratch, ...(config.driver === 'cursor' ? { XDG_CACHE_HOME: `${config.scratch}/cache` } : { CODEX_HOME: `${config.scratch}/codex` }), TMPDIR: `${config.scratch}/tmp`, LANG: 'C', LC_ALL: 'C', OPENSSL_CONF: '/dev/null' },
    shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('spawn', () => process.send?.({ type: 'started', workerPid: child!.pid })); // PID is diagnostic only.
  child.on('error', () => { process.send?.({ type: 'spawn-failed' }); stop(); });
  const forward = (stream: NodeJS.ReadableStream, output: NodeJS.WritableStream) => stream.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > config.maxOutputBytes) { process.send?.({ type: 'output-limit' }); stop(); return; }
    if (!output.write(chunk)) { stream.pause(); output.once('drain', () => stream.resume()); }
  });
  forward(child.stdout!, process.stdout); forward(child.stderr!, process.stderr);
  process.stdin.pipe(child.stdin!); child.stdin!.on('error', stop);
  process.stdout.on('error', stop); process.stderr.on('error', stop);
  child.on('close', (code, signal) => {
    clearTimeout(deadline); if (shutdownTimer) clearTimeout(shutdownTimer);
    if (!process.connected) process.exit(0);
    process.send?.({ type: 'reaped', code, signal }, () => process.exit(0));
  });
});
