import { digest, freeze, positive, serialize } from '../context-engine/validation.js';
import { readProject } from '../project-workflow/project.js';
import { canonicalWorkspace } from './documents.js';
import { SessionStorage } from './session-storage.js';
import { sessionExpectation, sessionFields, sessionId, sessionLimits, sessionPacket, sessionRecord, sessionTime } from './session-contracts.js';
import type { SessionExpectation, SessionFields, SessionPacket, SessionRecord } from './session-contracts.js';
import { text } from './validation.js';

/** Trusted local owner only; packets are inert continuation evidence, never grants. */
export class SessionMemory {
  readonly workspaceRoot: string;
  readonly projectId: string;
  readonly #storage: SessionStorage;
  readonly #clock: () => number;
  constructor(directory: string, root: string, clock: () => number = Date.now) {
    this.workspaceRoot = canonicalWorkspace(root); this.projectId = readProject(root).projectId;
    text(this.workspaceRoot, 4096); text(this.projectId, 1024);
    this.#clock = clock;
    const now = clock(); sessionTime(now);
    this.#storage = new SessionStorage(directory, root, this.projectId, now);
    try { this.#all(now); } catch (error) { this.#storage.close(); throw error; }
  }
  close(): void { this.#storage.close(); }
  #time(): number { const now = this.#clock(); sessionTime(now); return this.#storage.tick(now); }
  #read(id: string, at: number): Readonly<SessionRecord> | undefined {
    const row = this.#storage.db.prepare('SELECT * FROM session_records WHERE id = ?').get(id);
    if (!row || row.state !== 'active') return undefined;
    if (typeof row.body !== 'string' || Buffer.byteLength(row.body) > sessionLimits.packetBytes) throw new Error('malformed session body');
    const record = sessionRecord(JSON.parse(row.body) as SessionRecord);
    if (record.sessionId !== row.id || record.digest !== row.digest || record.revision !== row.revision || record.expiresAt !== row.expires_at ||
        record.projectId !== this.projectId || record.workspaceRoot !== this.workspaceRoot) throw new Error('session record scope or metadata mismatch');
    if (record.expiresAt <= at) throw new Error('unredacted expired session');
    return record;
  }
  #all(at: number): Readonly<SessionRecord>[] {
    const rows = this.#storage.db.prepare("SELECT id FROM session_records WHERE state = 'active' ORDER BY id LIMIT 257").all();
    if (rows.length > sessionLimits.records) throw new Error('session record budget exceeded');
    return rows.map(row => {
      if (typeof row.id !== 'string') throw new Error('invalid stored session ID');
      const record = this.#read(row.id, at);
      if (!record) throw new Error('session record disappeared');
      return record;
    });
  }
  #build(fields: Readonly<SessionFields>, createdAt: number, updatedAt: number, expiresAt: number, revision: number): Readonly<SessionRecord> {
    const body = { ...fields, schemaVersion: 1 as const, projectId: this.projectId, workspaceRoot: this.workspaceRoot,
      revision, createdAt, updatedAt, expiresAt };
    const record = sessionRecord({ ...body, digest: digest(serialize(body)) });
    sessionPacket(record); return record;
  }
  /** Explicit integer seconds; no inferred/default TTL. IDs are permanently reserved, including tombstones. */
  put(raw: SessionFields, ttlSeconds: number): Readonly<SessionPacket> {
    const fields = sessionFields(raw); positive(ttlSeconds, sessionLimits.ttlSeconds);
    const at = this.#time();
    return this.#storage.transaction(() => {
      const highWater = this.#storage.db.prepare('SELECT high_water FROM session_identity WHERE singleton = 1').get()?.high_water;
      sessionTime(highWater);
      const effectiveAt = Math.max(at, highWater);
      if (!Number.isSafeInteger(effectiveAt + ttlSeconds * 1000)) throw new Error('unsafe session expiry');
      if (this.#storage.db.prepare('SELECT 1 FROM session_records WHERE id = ?').get(fields.sessionId)) throw new Error('session ID already used');
      const count = this.#storage.db.prepare("SELECT count(*) AS total, sum(state = 'active') AS active FROM session_records").get();
      if (!count || (count.total as number) >= sessionLimits.ids || (count.active as number) >= sessionLimits.records) throw new Error('session capacity exceeded');
      const record = this.#build(fields, effectiveAt, effectiveAt, effectiveAt + ttlSeconds * 1000, 1);
      this.#storage.db.prepare("INSERT INTO session_records VALUES (?, ?, ?, 'active', ?, ?)").run(record.sessionId, record.digest, record.revision, record.expiresAt, JSON.stringify(record));
      return sessionPacket(record);
    });
  }
  /** Lifetime and task identity cannot be extended/reassigned by a checkpoint. */
  checkpoint(raw: SessionFields, expected: SessionExpectation): Readonly<SessionPacket> {
    const fields = sessionFields(raw), match = sessionExpectation(expected), at = this.#time();
    return this.#storage.transaction(() => {
      const old = this.#read(fields.sessionId, at);
      if (!old || old.digest !== match.expectedDigest || old.revision !== match.expectedRevision || old.taskId !== fields.taskId) throw new Error('session checkpoint mismatch or unavailable');
      const record = this.#build(fields, old.createdAt, Math.max(at, old.updatedAt), old.expiresAt, old.revision + 1);
      const result = this.#storage.db.prepare("UPDATE session_records SET digest = ?, revision = ?, body = ? WHERE id = ? AND state = 'active' AND digest = ? AND revision = ?")
        .run(record.digest, record.revision, JSON.stringify(record), record.sessionId, match.expectedDigest, match.expectedRevision);
      if (result.changes !== 1) throw new Error('session checkpoint conflict');
      return sessionPacket(record);
    });
  }
  get(id: string): Readonly<SessionPacket> | undefined {
    sessionId(id); const at = this.#time();
    return this.#storage.transaction(() => { const record = this.#read(id, at); return record ? sessionPacket(record) : undefined; });
  }
  /** Deterministic bounded page; pass the last session ID as after for the next page. */
  list(limit = 50, after?: string): ReadonlyArray<Readonly<SessionPacket>> {
    positive(limit, sessionLimits.list); if (after !== undefined) sessionId(after);
    const at = this.#time();
    return this.#storage.transaction(() => freeze(this.#all(at).filter(record => after === undefined || record.sessionId > after)
      .slice(0, limit).map(sessionPacket)));
  }
  /** Redacts body durably; a content-free ID/hash/revision tombstone prevents replay. */
  remove(id: string, expected: SessionExpectation): void {
    sessionId(id); const match = sessionExpectation(expected), at = this.#time();
    this.#storage.transaction(() => {
      const old = this.#read(id, at);
      if (!old || old.digest !== match.expectedDigest || old.revision !== match.expectedRevision) throw new Error('session deletion mismatch or unavailable');
      this.#storage.db.prepare("UPDATE session_records SET body = NULL, state = 'deleted', revision = revision + 1 WHERE id = ?").run(id);
    });
  }
}
