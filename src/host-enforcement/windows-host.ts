import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinFile, type PinnedFile } from './manifest.js';
import { isPrivate, isTrusted, useWindowsAclLauncher } from './owner-acl.js';
import { pinWindowsLauncher, sweepWindowsSandbox, type WindowsLauncher } from './windows-sandbox.js';

/** The reviewed launcher source in this checkout (dist/src/host-enforcement -> src/host-enforcement/windows). */
export const LAUNCHER_SOURCE = fileURLToPath(new URL('../../../src/host-enforcement/windows/', import.meta.url));

/** One digest over every launcher source file and the Cursor stdio shim, so changing either forces a fresh windows:setup. */
export function launcherSourceDigest(directory = LAUNCHER_SOURCE): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(directory).filter(file => file.endsWith('.cs') || file.endsWith('.cjs')).sort())
    hash.update(name + '\0').update(createHash('sha256').update(readFileSync(join(directory, name))).digest('hex') + '\n');
  return hash.digest('hex');
}

/** The only loopback ports the provider containers can reach (setup installs the WFP lock): proxy and MCP endpoints. */
export const WINDOWS_LOOPBACK_PORTS = Object.freeze({ first: 47810, last: 47841 });

export interface WindowsHost {
  folder: string; launcher: WindowsLauncher; node: PinnedFile; claude?: PinnedFile; stateRoot: string;
  /** Setup's private copy of the Cursor CLI version directory and the stdio shim it preloads (`--cursor`). */
  cursorDirectory?: string; cursorShim?: PinnedFile;
}
let current: WindowsHost | undefined;

/** The host loaded by loadWindowsHost. Every Windows run needs it; there is no uncontained fallback. */
export function windowsHost(): WindowsHost {
  if (!current) throw new Error('Windows runs need the owner setup: run npm run windows:setup, then load it with loadWindowsHost');
  return current;
}

const inside = (path: string, folder: string) => path.startsWith(folder + '\\') && realpathSync.native(path) === path;

/** Pins the launcher and node.exe that `npm run windows:setup` built into an owner-only folder, then removes leftovers
 * of killed runs. The trust root is the owner-supplied folder: setup made it owner-only, and that is checked here. */
export async function loadWindowsHost(folder: string): Promise<WindowsHost> {
  if (process.platform !== 'win32') throw new Error('The Windows sandbox requires Windows');
  if (!isAbsolute(folder) || realpathSync.native(folder) !== folder) throw new Error('Canonical Windows host folder required');
  const file = join(folder, 'windows-host.json'), stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error('Invalid windows-host.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const launcherEntry = raw.launcher as { path?: unknown; sha256?: unknown } | undefined,
    nodeEntry = raw.node as { path?: unknown; sha256?: unknown } | undefined,
    claudeEntry = raw.claude as { path?: unknown; sha256?: unknown } | undefined,
    cursorEntry = raw.cursor as { directory?: unknown; shim?: { path?: unknown; sha256?: unknown } } | undefined;
  if (raw.version !== 1 || typeof launcherEntry?.path !== 'string' || typeof launcherEntry.sha256 !== 'string' ||
      typeof nodeEntry?.path !== 'string' || typeof nodeEntry.sha256 !== 'string' || typeof raw.stateRoot !== 'string' ||
      typeof raw.sourceSha256 !== 'string' ||
      (claudeEntry !== undefined && (typeof claudeEntry.path !== 'string' || typeof claudeEntry.sha256 !== 'string')) ||
      (cursorEntry !== undefined && (typeof cursorEntry.directory !== 'string' || typeof cursorEntry.shim?.path !== 'string' ||
        typeof cursorEntry.shim.sha256 !== 'string'))) throw new Error('Invalid windows-host.json');
  for (const path of [launcherEntry.path, nodeEntry.path, raw.stateRoot, ...(claudeEntry ? [claudeEntry.path as string] : []),
    ...(cursorEntry ? [cursorEntry.directory as string, cursorEntry.shim!.path as string] : [])])
    if (!inside(path, folder)) throw new Error('windows-host.json paths must stay inside the host folder');
  if (raw.sourceSha256 !== launcherSourceDigest()) throw new Error('The launcher source changed since setup; run npm run windows:setup again');
  const launcher = pinWindowsLauncher(launcherEntry.path, launcherEntry.sha256);
  useWindowsAclLauncher(launcher);
  // runtime\ is readable by every contained run (setup's capability grant), so it must only be unwritable by others.
  for (const path of [folder, file, raw.stateRoot, dirname(launcher.path), launcher.path]) if (!isPrivate(path, lstatSync(path))) throw new Error('The Windows host folder must be owner-only');
  if (!isTrusted(dirname(nodeEntry.path), lstatSync(dirname(nodeEntry.path)))) throw new Error('The Windows host runtime folder must be owner-controlled');
  const node = pinFile(nodeEntry.path);
  if (node.digest !== nodeEntry.sha256) throw new Error('node.exe is not the copy setup pinned');
  const claude = claudeEntry ? pinFile(claudeEntry.path as string) : undefined;
  if (claude && claude.digest !== claudeEntry!.sha256) throw new Error('claude.exe is not the copy setup pinned');
  // The Cursor copy itself is pinned by manifest when a session opens (pinCursorCli); the shim is pinned here.
  const cursorShim = cursorEntry ? pinFile(cursorEntry.shim!.path as string) : undefined;
  if (cursorShim && cursorShim.digest !== cursorEntry!.shim!.sha256) throw new Error('The Cursor stdio shim is not the copy setup pinned');
  if (await sweepWindowsSandbox(launcher, raw.stateRoot) !== 0) throw new Error('Leftover sandbox grants could not be removed');
  current = Object.freeze({ folder, launcher, node, ...(claude ? { claude } : {}), stateRoot: raw.stateRoot,
    ...(cursorEntry && cursorShim ? { cursorDirectory: cursorEntry.directory as string, cursorShim } : {}) });
  return current;
}
