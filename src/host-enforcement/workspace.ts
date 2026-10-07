import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { dataSnapshot, serialize, string } from '../context-engine/validation.js';
import { pinFile, verifyFile } from './manifest.js';

/** Owner-selected files only. Returns an immutable read manifest in private staging.
 * Host retains cleanup ownership. Never include secrets or policy state in this list.
 */
export function snapshotWorkspace(sourceRoot: string, stagingRoot: string, selected: string[]): {
  workspaceRoot: string; readFiles: string[]; sourceSnapshot: string;
} {
  const files = dataSnapshot(selected);
  const source = realpathSync(sourceRoot), staging = realpathSync(stagingRoot), stat = lstatSync(staging);
  if (!Array.isArray(files) || files.length > 512 || staging !== stagingRoot || stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw new Error('unsafe staging');
  if (!relative(source, staging).startsWith(`..${sep}`)) throw new Error('staging must be outside source workspace');
  const root = realpathSync(mkdtempSync(join(staging, 'workspace-')));
  const readFiles: string[] = [];
  try {
  for (const file of [...new Set(files)].sort()) {
    string(file, 4096);
    if (isAbsolute(file) || file.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) throw new Error('invalid selected path');
    const from = join(source, file);
    if (realpathSync(from) !== from) throw new Error('source symlinks are forbidden');
    const before = pinFile(from), to = join(root, file);
    mkdirSync(join(to, '..'), { recursive: true, mode: 0o700 });
    copyFileSync(from, to); chmodSync(to, 0o400); verifyFile(before);
    if (pinFile(to).digest !== before.digest) throw new Error('source changed during snapshot');
    readFiles.push(to);
  }
  const sourceSnapshot = createHash('sha256').update(serialize(readFiles.map(path => ({ path: relative(root, path), digest: pinFile(path).digest })))).digest('hex');
  return { workspaceRoot: root, readFiles, sourceSnapshot };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
