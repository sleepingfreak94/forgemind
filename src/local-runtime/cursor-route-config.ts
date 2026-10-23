import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Owner file listing the workspaces a personal Cursor plan may run on (docs/cursor-route-plan.md).
 * It sits outside the Cursor profile, so the sandboxed CLI cannot change it. Absent means none. */
export function cursorPersonalWorkspaces(path = join(realpathSync(homedir()), '.forgemind', 'cursor-route.json')): string[] {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 65536)
    throw new Error('Cursor route config must be an owner-only regular file');
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const value = raw as { schemaVersion?: unknown; personalWorkspaces?: unknown };
  if (!raw || typeof raw !== 'object' || Object.keys(raw).sort().join() !== 'personalWorkspaces,schemaVersion' || value.schemaVersion !== 1
    || !Array.isArray(value.personalWorkspaces) || value.personalWorkspaces.length > 64)
    throw new Error('Invalid Cursor route config');
  return value.personalWorkspaces.map(entry => {
    if (typeof entry !== 'string' || !isAbsolute(entry) || realpathSync(entry) !== entry) throw new Error('Cursor route config needs canonical workspace paths');
    return entry;
  });
}
