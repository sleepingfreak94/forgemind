import { spawn } from 'node:child_process';

const raw = process.argv[2];
if (!raw) throw new Error('Missing repository command');
const config = JSON.parse(Buffer.from(raw, 'base64url').toString()) as {
  executable: 'git' | 'gh';
  args: string[];
  cwd: string;
  timeoutMs: number;
  deadline: number;
};
if (
  !['git', 'gh'].includes(config.executable) ||
  !Array.isArray(config.args) ||
  config.args.some((a) => typeof a !== 'string') ||
  !Number.isFinite(config.timeoutMs) ||
  config.timeoutMs <= 0 ||
  config.timeoutMs > 30000
)
  throw new Error('Invalid repository command');
const remaining = Math.min(config.timeoutMs, config.deadline - Date.now());
if (!Number.isFinite(remaining) || remaining <= 0)
  throw new Error('Repository deadline exhausted before launch');
const child = spawn(config.executable, config.args, {
  cwd: config.cwd,
  env: process.env,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let failure = false,
  bytes = 0,
  childExited = false;
let reason: 'deadline' | 'output-limit' | 'interrupted' | 'spawn' | undefined;
const kill = () => {
  if (child.pid)
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
};
const stop = (cause: 'deadline' | 'output-limit' | 'interrupted') => {
  failure = true;
  reason ??= cause;
  kill();
  // An inherited pipe may outlive the child's process group. On failure,
  // stop waiting for EOF; partial output must still have a failing status.
  child.stdout.destroy();
  child.stderr.destroy();
};
const timer = setTimeout(() => stop('deadline'), remaining);
process.on('SIGTERM', () => stop('interrupted'));
process.on('SIGINT', () => stop('interrupted'));
child.on('error', () => {
  failure = true;
  reason ??= 'spawn';
});
for (const [input, output] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
] as const) {
  input.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 64 * 1024 * 1024) {
      stop('output-limit');
      return;
    }
    if (!output.write(chunk)) {
      input.pause();
      output.once('drain', () => input.resume());
    }
  });
}
child.on('exit', () => { childExited = true; kill(); });
child.on('close', (code) => {
  clearTimeout(timer);
  kill();
  if (failure) {
    process.stderr.write('Repository command timed out or exceeded its output bound\n');
    process.stderr.write('Repository diagnostic: ' + JSON.stringify({ reason: reason ?? 'spawn', childExited, outputBytes: bytes }) + '\n');
    process.exitCode = 124;
  } else process.exitCode = code ?? 1;
});
