import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { sourceIdentity } from './repository.js';
import { safePath, sha256 } from './validation.js';
import { readPublicNpmConfig } from './npm-config.js';
import type { ActionAuthority, CodingResult } from './contracts.js';
import type { NativeProjectBoundary } from './native-executor-contracts.js';

interface Entry { mode: string; content: Buffer }
function identity(entries: Map<string, Entry>): string {
  const hash = createHash('sha256');
  const frame = (bytes: Buffer) => { hash.update(`${bytes.length}:`); hash.update(bytes); };
  for (const path of [...entries.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const file = entries.get(path)!;
    frame(Buffer.from(path)); frame(Buffer.from(file.mode)); frame(file.content);
  }
  return hash.digest('hex');
}
function inventory(root: string): { source: string; entries: Map<string, Entry> } {
  const source = sourceIdentity(root);
  const paths = execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 8 * 1024 * 1024,
  }).toString('utf8').split('\0').filter(Boolean);
  const entries = new Map<string, Entry>();
  for (const path of paths) {
    const file = safePath(root, path, true);
    if (!existsSync(file)) continue;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe source inventory');
    const content = path.split('/').at(-1) === '.npmrc' ? readPublicNpmConfig(file) : readFileSync(file);
    entries.set(path, { mode: stat.mode & 0o111 ? '100755' : '100644', content });
  }
  if (identity(entries) !== source || sourceIdentity(root) !== source) throw new Error('Source changed during inventory');
  return { source, entries };
}

/** Owner inventory and transition ledger. Observation never silently advances authority. */
export class NativeProject implements NativeProjectBoundary {
  #before: { source: string; entries: Map<string, Entry> } | null = null;
  constructor(readonly root: string, readonly authority: ActionAuthority,
    readonly phase: (name: string, source: string, data: unknown) => void,
    readonly active: () => void) {}
  source(): string { return sourceIdentity(this.root); }
  assertCurrent(expected: string): void {
    this.active();
    const observed = inventory(this.root);
    if (observed.source !== expected) throw new Error('Stale native project source');
    this.#before = observed;
  }
  commitAppliedSource(before: string, applied: CodingResult): { source: string; transitionReceiptId: string | null } {
    this.active();
    const snapshot = this.#before;
    if (!snapshot || snapshot.source !== before) throw new Error('Missing preimage inventory');
    const expected = new Map(snapshot.entries);
    for (const edit of applied.edits) {
      const original = expected.get(edit.path);
      if ((original ? sha256(original.content) : null) !== edit.beforeSha256) throw new Error('Transition preimage mismatch');
      if (edit.content === null) expected.delete(edit.path);
      else expected.set(edit.path, { mode: original?.mode ?? '100644', content: Buffer.from(edit.content) });
    }
    const source = identity(expected);
    const actual = inventory(this.root);
    if (actual.source !== source) throw new Error('Unrelated source drift during native edit');
    if (source === before) {
      // The completed files.apply receipt already records this idempotent write.
      // A source transition must describe a real change, never a fabricated phase.
      this.active();
      if (this.source() !== source) throw new Error('Source drift before no-op confirmation');
      this.#before = null;
      return { source, transitionReceiptId: null };
    }
    const transitionReceiptId = randomUUID();
    const receipt = this.authority.reserve({ kind: 'artifact', source: before,
      detail: { operation: 'native.source-transition', transitionReceiptId, before, source,
        edits: applied.edits.map(edit => ({ path: edit.path, before: edit.beforeSha256,
          after: edit.content === null ? null : sha256(edit.content) })) } });
    try {
      receipt.check(); this.active();
      if (this.source() !== source) throw new Error('Source drift before transition commit');
      receipt.finish('completed', source);
      this.phase('native.source-transition', source, { transitionReceiptId, before, source });
      this.#before = null;
      return { source, transitionReceiptId };
    } catch (error) {
      // The completed file operation remains pending in NativeState if either
      // ledger advance fails; owner reconciliation is required before resumption.
      throw error;
    }
  }
}
