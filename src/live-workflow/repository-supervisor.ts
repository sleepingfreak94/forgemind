import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

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
const windows = process.platform === 'win32';
// Windows looks a bare command up in the current directory (the worktree) before PATH, so a git.exe or gh.exe in the
// repository would run on the host. Resolve it from absolute PATH folders outside the worktree and launch that path.
function windowsCommand(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(';')) {
    const inside = relative(config.cwd, dir);
    const outside = inside === '..' || inside.startsWith('..\\') || isAbsolute(inside);
    if (!/^[A-Za-z]:\\/.test(dir) || !outside) continue;
    const file = join(dir, `${name}.exe`);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  throw new Error(`${name}.exe not found on PATH`);
}
const child = spawn(windows ? windowsCommand(config.executable) : config.executable, config.args, {
  cwd: config.cwd,
  env: process.env,
  // POSIX: own process group, so kill(-pid) reaches every descendant. Windows has no groups (see kill).
  detached: !windows,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let failure = false,
  bytes = 0;
const kill = () => {
  if (child.pid && windows) {
    // shortcut: no process group on Windows. taskkill /T ends the tree while the command runs; a descendant that
    // outlives it is not reaped. Upgrade to the launcher's job-only mode (ADR-0017 "Later").
    if (child.exitCode === null && child.signalCode === null)
      spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
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
