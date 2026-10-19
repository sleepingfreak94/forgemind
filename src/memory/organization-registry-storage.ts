import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { digest, serialize } from '../context-engine/validation.js';
import { canonicalWorkspace } from './documents.js';
import { initialState, validateState } from './organization-registry-contracts.js';
import type { LocalOrganizationState, LocalReceipt } from './organization-registry-contracts.js';

const stateDDL = 'CREATE TABLE org_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), organization_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1), digest TEXT NOT NULL, body TEXT NOT NULL) STRICT';
const receiptDDL = 'CREATE TABLE org_receipts (sequence INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL) STRICT';
const normalize = (sql: string): string => sql.replace(/\s+/g, '').toLowerCase();
function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      typeof process.getuid !== 'function' || stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) throw new Error('unsafe organization owner storage');
}
export function organizationDatabasePath(directory: string): string { return join(directory, 'organization-v1', 'organization.sqlite'); }
/** One local organization per explicit canonical owner state directory; not a remote authority. */
export class OrganizationRegistryStorage {
  readonly #db: DatabaseSync;
  readonly #directory: string;
  readonly #home: string;
  readonly #path: string;
  readonly #device: number;
  readonly #inode: number;
  readonly #organizationId: string;
  constructor(directory: string, workspaceRoot: string, organizationId: string) {
    canonicalWorkspace(workspaceRoot); this.#organizationId = organizationId;
    const offset = relative(workspaceRoot, directory);
    if (!isAbsolute(directory) || !offset || offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)) throw new Error('organization state must be external');
    this.#directory = directory; this.#home = join(directory, 'organization-v1'); this.#path = organizationDatabasePath(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw new Error('canonical organization state required');
    privatePath(directory, true);
    mkdirSync(this.#home, { mode: 0o700, recursive: true }); privatePath(this.#home, true);
    if (realpathSync(this.#home) !== this.#home) throw new Error('canonical organization home required');
    try { closeSync(openSync(this.#path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    privatePath(this.#path, false);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { privatePath(this.#path + suffix, false); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const fd = openSync(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let stat;
    try { stat = fstatSync(fd); } finally { closeSync(fd); }
    this.#device = stat.dev; this.#inode = stat.ino;
    this.#db = new DatabaseSync(this.#path, { timeout: 1000, enableForeignKeyConstraints: true });
    try {
      this.assertPaths();
      this.#db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON');
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const version = this.#db.prepare('PRAGMA user_version').get()?.user_version;
        if (version !== 0 && version !== 1) throw new Error('unsupported organization schema');
        if (version === 0) {
          if (this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()) throw new Error('nonempty organization state');
          this.#db.exec(stateDDL); this.#db.exec(receiptDDL);
          const body = serialize(initialState(organizationId));
          this.#db.prepare('INSERT INTO org_state VALUES (1, ?, 1, ?, ?)').run(organizationId, digest(body), body);
          this.#db.exec('PRAGMA user_version = 1');
        }
        this.schema();
        if (this.#db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('organization database corrupt');
        const row = this.#db.prepare('SELECT organization_id FROM org_state').get();
        if (row?.organization_id !== organizationId) throw new Error('organization identity mismatch');
        this.#db.exec('COMMIT');
      } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.#db.close(); throw error; }
  }
  // Factory keeps the initialization cleanup path explicit.
  static open(directory: string, workspaceRoot: string, organizationId: string): OrganizationRegistryStorage {
    return new OrganizationRegistryStorage(directory, workspaceRoot, organizationId);
  }
  assertPaths(): void {
    if (realpathSync(this.#directory) !== this.#directory || realpathSync(this.#home) !== this.#home) throw new Error('organization storage drift');
    privatePath(this.#directory, true); privatePath(this.#home, true); privatePath(this.#path, false);
    const stat = lstatSync(this.#path);
    if (stat.dev !== this.#device || stat.ino !== this.#inode) throw new Error('organization database replaced');
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { privatePath(this.#path + suffix, false); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  transaction<T>(work: (state: LocalOrganizationState, revision: number) => { value: T; receipt: (revision: number, stateDigest: string) => LocalReceipt }): T {
    this.assertPaths(); this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.schema();
      const row = this.#db.prepare('SELECT * FROM org_state').get();
      if (!row || row.organization_id !== this.#organizationId || typeof row.body !== 'string' || Buffer.byteLength(row.body) > 1048576 ||
          row.digest !== digest(row.body) || !Number.isSafeInteger(row.revision)) throw new Error('organization state corrupt');
      const state = validateState(JSON.parse(row.body), this.#organizationId);
      const result = work(state, row.revision as number);
      const checked = validateState(state, this.#organizationId), body = serialize(checked);
      const revision = (row.revision as number) + (body === row.body ? 0 : 1);
      this.#db.prepare('UPDATE org_state SET revision = ?, digest = ?, body = ? WHERE singleton = 1').run(revision, digest(body), body);
      const receipt = result.receipt(revision, digest(body));
      this.#db.prepare('INSERT INTO org_receipts(body) VALUES (?)').run(JSON.stringify(receipt));
      this.#db.exec('DELETE FROM org_receipts WHERE sequence <= (SELECT COALESCE(MAX(sequence), 0) - 1000 FROM org_receipts)');
      this.assertPaths(); this.#db.exec('COMMIT'); return result.value;
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  schema(): void {
    const rows = this.#db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (rows.length !== 2 || rows.some(row => row.type !== 'table') ||
        rows[0]?.name !== 'org_receipts' || rows[1]?.name !== 'org_state' ||
        normalize(rows[0].sql as string) !== normalize(receiptDDL) || normalize(rows[1].sql as string) !== normalize(stateDDL)) throw new Error('organization schema mismatch');
  }
  close(): void { if (this.#db.isOpen) this.#db.close(); }
}
