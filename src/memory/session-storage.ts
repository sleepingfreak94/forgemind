import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { digest, serialize } from '../context-engine/validation.js';
import { readProject } from '../project-workflow/project.js';
import { canonicalWorkspace } from './documents.js';
import { sessionTime } from './session-contracts.js';

const identityDDL = `CREATE TABLE session_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  project_id TEXT NOT NULL, workspace TEXT NOT NULL, high_water INTEGER NOT NULL CHECK(high_water >= 1)
) STRICT`;
const recordsDDL = `CREATE TABLE session_records (
  id TEXT PRIMARY KEY, digest TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
  state TEXT NOT NULL CHECK(state IN ('active', 'deleted', 'expired')),
  expires_at INTEGER NOT NULL, body TEXT,
  CHECK((state = 'active' AND body IS NOT NULL) OR (state != 'active' AND body IS NULL))
) STRICT`;
const normalized = (value: string): string => value.replace(/\s+/g, '').toLowerCase();
function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      typeof process.getuid === 'function' &&
      ((stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || stat.uid !== process.getuid())) throw new Error('unsafe private session storage');
}
function sidecars(path: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { privatePath(path + suffix, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function sessionDatabasePath(directory: string, root: string, projectId: string): string {
  return join(directory, digest(serialize({ root, projectId, store: 'sessions-v1' })), 'sessions.sqlite');
}
/** Separate schema and file; never opens or migrates MemoryDatabase. Trusted local owner only. */
export class SessionStorage {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly #directory: string;
  readonly #home: string;
  readonly #root: string;
  readonly #projectId: string;
  constructor(directory: string, root: string, projectId: string, now: number) {
    sessionTime(now); canonicalWorkspace(root);
    if (readProject(root).projectId !== projectId) throw new Error('session project identity mismatch');
    const offset = relative(root, directory);
    if (!isAbsolute(directory) || !offset || offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)) throw new Error('session storage must be outside workspace');
    this.#directory = directory; this.#root = root; this.#projectId = projectId;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw new Error('session directory must be canonical');
    privatePath(directory, true);
    this.path = sessionDatabasePath(directory, root, projectId);
    this.#home = join(this.path, '..');
    mkdirSync(this.#home, { recursive: true, mode: 0o700 });
    privatePath(this.#home, true);
    if (realpathSync(this.#home) !== this.#home) throw new Error('session home must be canonical');
    try { closeSync(openSync(this.path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    privatePath(this.path, false); sidecars(this.path);
    const fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let before;
    try { before = fstatSync(fd); } finally { closeSync(fd); }
    this.db = new DatabaseSync(this.path, { timeout: 1000, enableForeignKeyConstraints: true });
    try {
      const after = lstatSync(this.path);
      if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('session database replaced during open');
      this.#paths();
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error('unsupported session schema');
      if (version === 0 && this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()) throw new Error('nonempty unversioned session schema');
      this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;');
      this.transaction(() => {
        if (version === 0) {
          this.db.exec(identityDDL); this.db.exec(recordsDDL);
          this.db.prepare('INSERT INTO session_identity VALUES (1, ?, ?, ?)').run(projectId, root, now);
          this.db.exec('PRAGMA user_version = 1');
        }
        this.#schema(); this.#identity(); this.#validateRows();
      });
      this.tick(now);
    } catch (error) { this.db.close(); throw error; }
  }
  #paths(): void {
    if (realpathSync(this.#directory) !== this.#directory || realpathSync(this.#home) !== this.#home) throw new Error('session storage path drift');
    privatePath(this.#directory, true); privatePath(this.#home, true); privatePath(this.path, false); sidecars(this.path);
  }
  #schema(): void {
    const rows = this.db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (rows.length !== 2 || rows.some(row => row.type !== 'table') ||
        rows[0]?.name !== 'session_identity' || rows[1]?.name !== 'session_records' ||
        typeof rows[0].sql !== 'string' || normalized(rows[0].sql) !== normalized(identityDDL) ||
        typeof rows[1].sql !== 'string' || normalized(rows[1].sql) !== normalized(recordsDDL)) throw new Error('invalid session schema');
    if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('corrupt session database');
  }
  #identity(): number {
    const rows = this.db.prepare('SELECT * FROM session_identity').all();
    const row = rows[0];
    if (rows.length !== 1 || !row || row.singleton !== 1 || row.project_id !== this.#projectId || row.workspace !== this.#root) throw new Error('session database identity mismatch');
    sessionTime(row.high_water); return row.high_water;
  }
  #validateRows(): void {
    const rows = this.db.prepare('SELECT id, digest, revision, state, expires_at, body FROM session_records LIMIT 10001').all();
    if (rows.length > 10000 || rows.filter(row => row.state === 'active').length > 256) throw new Error('session row budget exceeded');
    for (const row of rows) {
      if (typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.id) ||
          typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest) ||
          !Number.isSafeInteger(row.revision) || (row.revision as number) < 1 || (row.revision as number) >= Number.MAX_SAFE_INTEGER ||
          !Number.isSafeInteger(row.expires_at) || (row.expires_at as number) < 1 ||
          !['active', 'deleted', 'expired'].includes(row.state as string) ||
          (row.state === 'active' ? typeof row.body !== 'string' || Buffer.byteLength(row.body) > 16000 : row.body !== null)) throw new Error('malformed session row');
    }
  }
  assertScope(): void {
    if (!this.db.isOpen) throw new Error('session store closed');
    canonicalWorkspace(this.#root);
    if (readProject(this.#root).projectId !== this.#projectId) throw new Error('session project identity changed');
    this.#paths(); this.#identity();
  }
  /** Expiry and high-water writes commit independently of a later rejected checkpoint. */
  tick(now: number): number {
    sessionTime(now); this.assertScope();
    return this.transaction(() => {
      const at = Math.max(now, this.#identity());
      this.db.prepare('UPDATE session_identity SET high_water = ? WHERE singleton = 1').run(at);
      this.db.prepare("UPDATE session_records SET body = NULL, state = 'expired', revision = revision + 1 WHERE state = 'active' AND expires_at <= ?").run(at);
      return at;
    });
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Cleanup remains available after profile drift. */
  close(): void { if (this.db.isOpen) this.db.close(); }
}
