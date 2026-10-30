import { pinFile, verifyFile } from '../host-enforcement/manifest.js';
import { windowsHost } from '../host-enforcement/windows-host.js';
import { runContained, sweepWindowsSandbox } from '../host-enforcement/windows-sandbox.js';
import type { ProcessRequest } from './process.js';

/** supervised() on Windows: the pinned launcher is the supervisor (AppContainer plus kill-on-close job, ADR-0017).
 * Same contract as macOS: pins are re-checked while it runs, and anything but a clean reap rejects. */
export async function supervisedWindows(request: ProcessRequest): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const host = windowsHost();
  if (!request.containment) throw new Error('Windows runs need a containment policy');
  // shortcut: stdin is not passed into the container yet; provider CLIs (phase 2a) need it.
  if (request.input) throw new Error('Contained stdin is not supported yet');
  request.signal?.throwIfAborted();
  const executable = pinFile(request.executable);
  if (request.executableSha256 !== undefined && executable.digest !== request.executableSha256)
    throw new Error('Executable is not the reviewed build');
  const files = [executable, ...(request.dependencies ?? []).map((path) => pinFile(path))];
  files.forEach((file) => verifyFile(file));
  request.check?.();
  const controller = new AbortController();
  let failure: Error | undefined;
  const stop = (reason: string) => { failure ??= new Error(reason); controller.abort(); };
  const cancel = () => stop('cancelled');
  request.signal?.addEventListener('abort', cancel, { once: true });
  const poll = setInterval(() => {
    try { files.forEach((file) => verifyFile(file, false)); request.check?.(); }
    catch (error) { stop(`Authority or executable drift (${error instanceof Error ? error.message : 'unknown'})`); }
  }, 50);
  let result;
  try {
    result = await runContained(host.launcher, { executable: executable.path, args: request.args, cwd: request.cwd, env: request.env,
      ...request.containment, timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes }, host.stateRoot, controller.signal);
  } finally {
    clearInterval(poll);
    request.signal?.removeEventListener('abort', cancel);
  }
  // A killed launcher leaves its journal; the kernel already ended the job, and sweep revokes the grants.
  if ((result.status === 'cleanup-uncertain' || result.status === 'output-limit') && await sweepWindowsSandbox(host.launcher, host.stateRoot) !== 0)
    throw new Error('Supervisor cleanup uncertain');
  if (failure) throw failure;
  if (result.status === 'deadline') throw new Error('deadline');
  if (result.status === 'output-limit') throw new Error('output-limit');
  if (result.status !== 'reaped') throw new Error(result.status === 'error' ? `Launch failed: ${result.message}` : 'Supervisor cleanup uncertain');
  files.forEach((file) => verifyFile(file));
  request.check?.();
  return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
}
