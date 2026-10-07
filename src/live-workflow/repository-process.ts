import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { pinFile, verifyFile } from '../host-enforcement/manifest.js';

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
export function repositoryProcess(
  executable: 'git' | 'gh',
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Buffer {
  const scope = budget.getStore();
  scope?.signal?.throwIfAborted();
  const commandDeadline = Math.min(Date.now() + 30000, scope?.deadline ?? Infinity);
  if (commandDeadline <= Date.now()) throw new Error('Repository deadline exhausted');
  const runner = pinFile(fileURLToPath(new URL('./repository-supervisor.js', import.meta.url)));
  const runtime = pinFile(process.execPath);
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^(NODE_OPTIONS|NODE_PATH|DYLD_.*|LD_.*)$/.test(key)),
  );
  verifyFile(runner);
  verifyFile(runtime);
  scope?.signal?.throwIfAborted();
  const remaining = commandDeadline - Date.now();
  if (remaining <= 0) throw new Error('Repository deadline exhausted during executable validation');
  const config = { executable, args: [...args], cwd, timeoutMs: remaining, deadline: commandDeadline };
  // Supervisor owns the process group; outer bound is only a cleanup watchdog.
  const result = childProcess.execFileSync(
    runtime.path,
    [runner.path, Buffer.from(JSON.stringify(config)).toString('base64url')],
    {
      cwd,
      env: cleanEnv,
      timeout: remaining + 3000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  verifyFile(runner);
  verifyFile(runtime);
  scope?.signal?.throwIfAborted();
  if (scope && Date.now() >= scope.deadline)
    throw new Error('Repository deadline exhausted after command; outcome indeterminate');
  return result;
}
