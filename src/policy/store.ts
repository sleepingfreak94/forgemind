import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdirSync, openSync, closeSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Approval, ExternalAttempt, Receipt, TaskGrant } from './contracts.js';

/** Trusted host only. Never expose this object or its state directory to an agent. */
export class PolicyStore {
  readonly #db: DatabaseSync;
  constructor(directory: string, uid: number) {
    if (!isAbsolute(directory)) throw new Error('state directory must be absolute');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || realpathSync(directory) !== directory || dir.uid !== uid || (dir.mode & 0o077)) {
      throw new Error('state directory must be private, canonical and owner-controlled');
    }
    const path = join(directory, 'policy.sqlite');
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1 || file.uid !== uid || (file.mode & 0o077)) throw new Error('unsafe policy database');
    this.#db = new DatabaseSync(path, { timeout: 1000, enableForeignKeyConstraints: true });
    this.#db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
    const version = this.#db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 0 && version !== 1 && version !== 2) { this.#db.close(); throw new Error('unsupported policy schema'); }
    this.transaction(() => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, parent_id TEXT, body TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS approvals (digest TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS attempts (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS receipts (sequence INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS external_attempts (request_id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
        PRAGMA user_version = 2;
      `);
    });
  }
  transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  meta(key: string): string | undefined {
    return this.#db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value as string | undefined;
  }
  setMeta(key: string, value: string): void {
    this.#db.prepare('INSERT INTO metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  grant(id: string): TaskGrant | undefined {
    const row = this.#db.prepare('SELECT body FROM grants WHERE id = ?').get(id);
    return row ? JSON.parse(row.body as string) as TaskGrant : undefined;
  }
  insertGrant(grant: TaskGrant): void {
    this.#db.prepare('INSERT INTO grants VALUES (?, ?, ?)').run(grant.id, grant.parentId ?? null, JSON.stringify(grant));
  }
  saveGrant(grant: TaskGrant): void {
    this.#db.prepare('UPDATE grants SET body = ? WHERE id = ?').run(JSON.stringify(grant), grant.id);
  }
  childCount(id: string): number {
    return Number(this.#db.prepare('SELECT count(*) AS n FROM grants WHERE parent_id = ?').get(id)?.n);
  }
  approval(digest: string): Approval | undefined {
    const row = this.#db.prepare('SELECT body FROM approvals WHERE digest = ?').get(digest);
    return row ? JSON.parse(row.body as string) as Approval : undefined;
  }
  saveApproval(value: Approval): void {
    this.#db.prepare('INSERT INTO approvals VALUES (?, ?) ON CONFLICT(digest) DO UPDATE SET body = excluded.body')
      .run(value.digest, JSON.stringify(value));
  }
  attempted(requestId: string): boolean {
    return !!this.#db.prepare('SELECT 1 FROM attempts WHERE request_id = ?').get(requestId);
  }
  reserve(requestId: string, digest: string): void {
    this.#db.prepare('INSERT INTO attempts VALUES (?, ?)').run(requestId, digest);
  }
  append(receipt: Receipt): void {
    this.#db.prepare('INSERT INTO receipts(id, body) VALUES (?, ?)').run(receipt.id, JSON.stringify(receipt));
  }
  receipts(): Receipt[] {
    return this.#db.prepare('SELECT body FROM receipts ORDER BY sequence').all().map(r => JSON.parse(r.body as string) as Receipt);
  }
  external(requestId: string): ExternalAttempt | undefined {
    const row = this.#db.prepare('SELECT body FROM external_attempts WHERE request_id = ?').get(requestId);
    return row ? JSON.parse(row.body as string) as ExternalAttempt : undefined;
  }
  saveExternal(attempt: ExternalAttempt): void {
    this.#db.prepare('INSERT INTO external_attempts VALUES (?, ?) ON CONFLICT(request_id) DO UPDATE SET body = excluded.body')
      .run(attempt.intent.requestId, JSON.stringify(attempt));
  }
  pendingExternal(): ExternalAttempt[] {
    return this.#db.prepare('SELECT body FROM external_attempts').all().map(r => JSON.parse(r.body as string) as ExternalAttempt).filter(a => a.status === 'reserved');
  }
  close(): void { if (this.#db.isOpen) this.#db.close(); }
}
