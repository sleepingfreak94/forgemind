import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, type Stats } from 'node:fs';
import type { WindowsLauncher } from './windows-sandbox.js';

// POSIX ownership checks (owner uid, no group or world bits). Node cannot read Windows ACLs, so on Windows the pinned
// sandbox launcher answers (`acl private|trusted`, sandbox-acl.cs). Without it every check fails closed.
let launcher: WindowsLauncher | undefined;
let user: string | undefined;

/** Called by loadWindowsHost once the launcher is pinned. */
export function useWindowsAclLauncher(pinned: WindowsLauncher): void { launcher = pinned; user = undefined; answers.clear(); }

function windowsAcl(args: string[]): { user: string; ok?: boolean; reason?: string } {
  if (!launcher) throw new Error('Windows ownership checks need the pinned sandbox launcher; run npm run windows:setup');
  if (createHash('sha256').update(readFileSync(launcher.path)).digest('hex') !== launcher.digest) throw new Error('Launcher digest mismatch');
  const output = execFileSync(launcher.path, ['acl', ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 65536,
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {} });
  const result = JSON.parse(output) as { user?: unknown; ok?: unknown; reason?: unknown };
  if (typeof result.user !== 'string') throw new Error('Ownership check unavailable');
  return { user: result.user, ...(typeof result.ok === 'boolean' ? { ok: result.ok } : {}),
    ...(typeof result.reason === 'string' ? { reason: result.reason } : {}) };
}

/** The local owner: the uid on POSIX, the user SID on Windows. */
export function ownerIdentity(): number | string {
  if (process.platform === 'win32') return user ??= windowsAcl(['user']).user;
  if (!process.getuid) throw new Error('local owner mode requires a POSIX user identity or Windows');
  return process.getuid();
}

// Each launcher check costs a process start (~1 s), and a run checks the same files many times. Any ACL edit on NTFS,
// inherited ones included, changes the object's change time, so an answer is reused only for the identical object.
const answers = new Map<string, { identity: string; ok: boolean }>();
function cachedAcl(mode: 'private' | 'trusted', path: string): boolean {
  const identity = (() => { const s = lstatSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.ctimeNs}:${s.mtimeNs}`; })();
  const key = `${mode}\0${path}`, known = answers.get(key);
  if (known?.identity === identity) return known.ok;
  const ok = windowsAcl([mode, path]).ok === true;
  answers.set(key, { identity, ok });
  return ok;
}

/** Owner state: only the owner (plus SYSTEM and Administrators on Windows) can reach it. */
export function isPrivate(path: string, stat: Stats): boolean {
  if (process.platform === 'win32') return cachedAcl('private', path);
  return stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
}

/** An executable or runtime file that nobody but the owner, root or the system can change. */
export function isTrusted(path: string, stat: Stats): boolean {
  if (process.platform === 'win32') return cachedAcl('trusted', path);
  return (stat.mode & 0o6022) === 0 && [0, process.getuid?.()].includes(stat.uid);
}
