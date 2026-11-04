import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { hashFile } from './manifest.js';

/** Owner-built launcher (src/host-enforcement/windows/sandbox-launcher.cs, ADR-0017), pinned by the digest its build printed. */
export interface WindowsLauncher { path: string; digest: string }
export interface ContainedCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Readable trees. Every entry under them is readable except `denyPaths`, which are never granted. */
  readPaths: string[];
  writePaths: string[];
  denyPaths: string[];
  timeoutMs: number;
  /** 1 also forbids creating any child process, like the macOS check profile. */
  activeProcessLimit: number;
  maxOutputBytes: number;
}
export type ContainedStatus = 'reaped' | 'deadline' | 'error' | 'cleanup-uncertain' | 'output-limit';
export interface ContainedResult { status: ContainedStatus; exitCode: number | null; stdout: string; stderr: string; message: string }

// The launcher enforces timeoutMs itself from the moment the command starts. This backup only catches a hung launcher, so
// it also covers profile creation (about 5 s in a 2-vCPU VM) and ACL propagation over the granted trees.
// shortcut: fixed 60 s, enough for a source tree with no node_modules; scale it with tree size when node-project checks land.
const GRACE_MS = 60000;

function canonical(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes('\0') || realpathSync.native(path) !== path) throw new Error(`Canonical ${label} required`);
  return path;
}
const inside = (path: string, parent: string) => { const rest = relative(parent, path); return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest)); };

export function pinWindowsLauncher(path: string, digest: string): WindowsLauncher {
  if (process.platform !== 'win32') throw new Error('The Windows sandbox requires Windows');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Launcher digest must be a SHA-256 hex string');
  const stat = lstatSync(canonical(path, 'launcher'));
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Launcher must be a regular file with one link');
  if (hashFile(path) !== digest) throw new Error('Launcher digest mismatch');
  return Object.freeze({ path, digest });
}

/** Paths a check must never read, matching the macOS profile: .git, .codex and .env or .env.* at any depth. Links are not followed. */
export function protectedPaths(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (/^(\.git|\.codex|\.env|\.env\..*)$/i.test(entry.name)) found.push(path);
      else if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
    }
  };
  visit(root);
  return found.sort();
}

/** A hardlink shares one ACL across all its names, so granting a tree would also grant a denied or outside file. */
export function assertNoHardlinks(paths: string[]): void {
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
    else if (stat.isFile() && stat.nlink > 1) throw new Error('Granted trees must not contain hardlinked files');
  };
  paths.forEach(visit);
}

/** Runs one command in a fresh AppContainer inside a kill-on-close job. Never falls back to an uncontained run. */
export async function runContained(launcher: WindowsLauncher, command: ContainedCommand, stateRoot: string, signal?: AbortSignal): Promise<ContainedResult> {
  if (process.platform !== 'win32') throw new Error('The Windows sandbox requires Windows');
  signal?.throwIfAborted();
  if (hashFile(launcher.path) !== launcher.digest) throw new Error('Launcher digest mismatch');
  canonical(stateRoot, 'state root');
  for (const path of [command.executable, command.cwd, ...command.readPaths, ...command.writePaths]) {
    canonical(path, 'policy path');
    // The report must be unreachable from inside, or the child could forge its own result.
    if (inside(stateRoot, path) || inside(path, stateRoot)) throw new Error('State root must be separate from every granted path');
  }
  if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 3600000) throw new Error('Invalid timeout');
  if (!Number.isInteger(command.maxOutputBytes) || command.maxOutputBytes < 1) throw new Error('Invalid output limit');
  assertNoHardlinks([...command.readPaths, ...command.writePaths]);
  const id = randomUUID(), reportPath = join(stateRoot, `${id}.report`), journalPath = join(stateRoot, `${id}.journal`);
  const policy = { executable: command.executable, args: command.args, cwd: command.cwd, env: command.env, readPaths: command.readPaths,
    writePaths: command.writePaths, denyPaths: command.denyPaths, timeoutMs: command.timeoutMs, activeProcessLimit: command.activeProcessLimit,
    reportPath, journalPath };
  const encoded = Buffer.from(JSON.stringify(policy)).toString('base64url');
  const child = spawn(launcher.path, ['run', encoded], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {} });
  const output: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
  let total = 0, overLimit = false;
  // Killing the launcher closes its job handle, and the kernel then ends every contained process.
  const timer = setTimeout(() => child.kill(), command.timeoutMs + GRACE_MS), abort = () => child.kill();
  // Aborting kills the launcher too: no report, so the result is cleanup-uncertain and the caller sweeps.
  signal?.addEventListener('abort', abort, { once: true });
  for (const name of ['stdout', 'stderr'] as const)
    child[name].on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > command.maxOutputBytes) { overLimit = true; child.kill(); return; }
      output[name].push(chunk);
    });
  const launcherExit = await new Promise<number | null>(resolve => { child.on('close', code => resolve(code)); child.on('error', () => resolve(null)); });
  clearTimeout(timer);
  signal?.removeEventListener('abort', abort);
  let report: { status?: unknown; exitCode?: unknown; message?: unknown } = {};
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* a killed launcher leaves no report */ }
  rmSync(reportPath, { force: true });
  // The launcher exits 0 only after a clean reap and 3 after any other written result. A report that disagrees, or no
  // report (the launcher was killed and its journal stays for sweepWindowsSandbox), is never trusted.
  const agrees = (report.status === 'reaped' && launcherExit === 0) ||
    (['deadline', 'error', 'cleanup-uncertain'].includes(report.status as string) && launcherExit === 3);
  let status: ContainedStatus = agrees ? report.status as ContainedStatus : 'cleanup-uncertain';
  // Over the limit the launcher was killed, so there is no report; the caller sweeps as for cleanup-uncertain.
  if (overLimit) status = 'output-limit';
  return { status, exitCode: agrees && typeof report.exitCode === 'number' ? report.exitCode : null,
    message: agrees && typeof report.message === 'string' ? report.message : '',
    stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') };
}

/** Removes grants and AppContainer profiles left behind by a launcher that was killed. Returns the number it could not remove. */
export async function sweepWindowsSandbox(launcher: WindowsLauncher, stateRoot: string): Promise<number> {
  if (hashFile(launcher.path) !== launcher.digest) throw new Error('Launcher digest mismatch');
  canonical(stateRoot, 'state root');
  const child = spawn(launcher.path, ['sweep', stateRoot], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>(resolve => child.on('close', () => resolve()));
  const failures = (JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { failures?: unknown }).failures;
  if (typeof failures !== 'number') throw new Error('Sweep result unavailable');
  return failures;
}
