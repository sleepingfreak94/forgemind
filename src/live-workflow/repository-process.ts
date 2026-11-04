import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { pinFile, verifyFile, type PinnedFile } from '../host-enforcement/manifest.js';

export interface RepositoryBudget {
  deadline: number;
  signal?: AbortSignal;
}
const budget = new AsyncLocalStorage<RepositoryBudget>();
/** Trusted owner scope; asynchronous callers retain the same absolute deadline. */
export function withRepositoryBudget<T>(scope: RepositoryBudget, operation: () => T): T {
  if (!Number.isFinite(scope.deadline)) throw new Error('Invalid repository deadline');
  scope.signal?.throwIfAborted();
  return budget.run(scope, operation);
}
// Hashing node (~90 MB) before and after every git command cost seconds per command on Windows. Each file is hashed
// and trust-checked once per identity; around every command its identity (dev, ino, size, mode, mtime, ctime) is
// re-checked, as the supervisors' drift polls do, and a changed identity is pinned afresh.
const pins = new Map<string, PinnedFile>();
function pinned(path: string): PinnedFile {
  const known = pins.get(path);
  if (known) try { verifyFile(known, false); return known; } catch { pins.delete(path); }
  const file = pinFile(path);
  pins.set(path, file);
  return file;
}
function prepareRepositoryProcess(
  executable: 'git' | 'gh',
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const commandArgs = [...args];
  const scope = budget.getStore();
  scope?.signal?.throwIfAborted();
  const commandDeadline = Math.min(Date.now() + 30000, scope?.deadline ?? Infinity);
  if (commandDeadline <= Date.now()) throw new Error('Repository deadline exhausted');
  const runner = pinned(fileURLToPath(new URL('./repository-supervisor.js', import.meta.url)));
  const runtime = pinned(process.execPath);
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^(NODE_OPTIONS|NODE_PATH|DYLD_.*|LD_.*)$/.test(key)),
  );
  verifyFile(runner, false);
  verifyFile(runtime, false);
  const launch = (onDispatch?: () => void): Buffer => {
    scope?.signal?.throwIfAborted();
    const remaining = commandDeadline - Date.now();
    if (remaining <= 0) throw new Error('Repository deadline exhausted during executable validation');
    const config = { executable, args: commandArgs, cwd, timeoutMs: remaining, deadline: commandDeadline };
    // Supervisor owns the process group; outer bound is only a cleanup watchdog.
    const argv = [runner.path, Buffer.from(JSON.stringify(config)).toString('base64url')];
    onDispatch?.();
    const result = childProcess.execFileSync(
      runtime.path,
      argv,
      {
        cwd,
        env: cleanEnv,
        timeout: remaining + 3000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    verifyFile(runner, false);
    verifyFile(runtime, false);
    scope?.signal?.throwIfAborted();
    if (scope && Date.now() >= scope.deadline)
      throw new Error('Repository deadline exhausted after command; outcome indeterminate');
    return result;
  };
  return launch;
}

/** Read-only or separately authorized legacy commands retain a synchronous runner. */
export function repositoryProcess(executable: 'git' | 'gh', args: readonly string[], cwd: string,
  env: NodeJS.ProcessEnv): Buffer {
  return prepareRepositoryProcess(executable, args, cwd, env)();
}
/** Protected publication checks authority after runtime pinning. Async decisions are
 * awaited; the absolute command budget is checked again after the decision. */
export async function authorizedRepositoryProcess(executable: 'git' | 'gh', args: readonly string[], cwd: string,
  env: NodeJS.ProcessEnv, check: () => void | Promise<void>, onDispatch: () => void): Promise<Buffer> {
  const launch = prepareRepositoryProcess(executable, args, cwd, env);
  await check();
  return launch(onDispatch);
}
