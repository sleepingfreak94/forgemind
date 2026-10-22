import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** Owner-selected runtime for ADR-0015 node-project checks; never read from a task or model. */
export interface CheckRuntime {
  readonly node: string;
  readonly nodeModules: string;
  readonly lockSha256: string;
  readonly identity: string;
}
const runtimes = new WeakSet<CheckRuntime>();
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const identity = (path: string) => { const s = lstatSync(path); return `${s.dev}:${s.ino}:${s.uid}:${s.mode}`; };

/** Pin a canonical owner-installed node_modules directory and the lockfile beside it. */
export function nodeProjectRuntime(nodeModules: string): CheckRuntime {
  if (!isAbsolute(nodeModules) || realpathSync(nodeModules) !== nodeModules || basename(nodeModules) !== 'node_modules')
    throw new Error('Canonical node_modules directory required');
  const stat = lstatSync(nodeModules);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022)
    throw new Error('node_modules must be an owner directory without group or world write');
  const lock = join(dirname(nodeModules), 'package-lock.json'), lockStat = lstatSync(lock);
  if (!lockStat.isFile() || lockStat.nlink !== 1) throw new Error('node_modules requires a package-lock.json beside it');
  const runtime = Object.freeze({ node: realpathSync(process.execPath), nodeModules, lockSha256: digest(lock), identity: identity(nodeModules) });
  runtimes.add(runtime);
  return runtime;
}

/** The pin is genuine, unchanged since selection, and matches the checked tree's lockfile. */
export function assertCheckRuntime(runtime: unknown, root: string): asserts runtime is CheckRuntime {
  if (!runtime || typeof runtime !== 'object' || !runtimes.has(runtime as CheckRuntime)) throw new Error('Untrusted check runtime');
  const r = runtime as CheckRuntime;
  if (identity(r.nodeModules) !== r.identity || digest(join(dirname(r.nodeModules), 'package-lock.json')) !== r.lockSha256)
    throw new Error('Selected node_modules changed since the run started');
  const lock = join(root, 'package-lock.json');
  let local: string;
  try { local = lstatSync(lock).isFile() ? digest(lock) : ''; } catch { local = ''; }
  if (local !== r.lockSha256) throw new Error('Task package-lock.json does not match the selected node_modules');
}
