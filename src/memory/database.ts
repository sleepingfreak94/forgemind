import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { digest, serialize } from '../context-engine/validation.js';
import { canonicalWorkspace } from './documents.js';

function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error('unsafe memory storage');
  if (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o077))) throw new Error('memory storage must be private to the owner');
}
export function databasePath(directory: string, root: string, projectId: string): string {
  return join(directory, digest(serialize({ root, projectId })), 'memory.sqlite');
}
/** Owner-only persistence. Do not expose this connection or its directory to an agent. */
export class MemoryDatabase {
  readonly db: DatabaseSync;
  readonly path: string;
  constructor(directory: string, root: string, projectId: string) {
    canonicalWorkspace(root);
    const offset = relative(root, directory);
    if (!isAbsolute(directory) || !offset || !offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset)) throw new Error('memory storage must be outside the project');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw new Error('memory storage must be canonical');
    privatePath(directory, true);
    const home = join(directory, digest(serialize({ root, projectId })));
    mkdirSync(home, { mode: 0o700, recursive: true }); privatePath(home, true);
    this.path = databasePath(directory, root, projectId);
    try { closeSync(openSync(this.path, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    privatePath(this.path, false);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { privatePath(this.path + suffix, false); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.db = new DatabaseSync(this.path, { timeout: 1000, enableForeignKeyConstraints: true });
    try {
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error('unsupported memory schema');
      this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;');
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), project_id TEXT NOT NULL, workspace TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, digest TEXT NOT NULL, kind TEXT NOT NULL,
            state TEXT NOT NULL, expires_at INTEGER, body TEXT) STRICT;
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(record_id UNINDEXED, title, text, tokenize='unicode61');
          CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY, action TEXT NOT NULL, record_id TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS deleted_sources (path TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(path, sha256)) STRICT;
          INSERT INTO memory_fts(memory_fts, rank) VALUES ('secure-delete', 1);
          PRAGMA user_version = 1;
        `);
        const identity = this.db.prepare('SELECT * FROM identity').get();
        if (!identity) this.db.prepare('INSERT INTO identity VALUES (1, ?, ?)').run(projectId, root);
        else if (identity.project_id !== projectId || identity.workspace !== root) throw new Error('memory database identity mismatch');
      });
    } catch (error) { this.db.close(); throw error; }
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { if (this.db.isOpen) this.db.close(); }
}
