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
  bytes = 0;
const kill = () => {
  if (child.pid)
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
};
const stop = () => {
  failure = true;
  kill();
};
const timer = setTimeout(stop, remaining);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('error', () => {
  failure = true;
});
for (const [input, output] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
] as const) {
  input.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 64 * 1024 * 1024) {
      stop();
      return;
    }
    if (!output.write(chunk)) {
      input.pause();
      output.once('drain', () => input.resume());
    }
  });
}
child.on('exit', kill);
child.on('close', (code) => {
  clearTimeout(timer);
  kill();
  if (failure) {
    process.stderr.write('Repository command timed out or exceeded its output bound\n');
    process.exitCode = 124;
  } else process.exitCode = code ?? 1;
});
