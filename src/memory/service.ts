import { digest, freeze, serialize } from '../context-engine/validation.js';
import { readProject } from '../project-workflow/project.js';
import { MemoryDatabase } from './database.js';
import { canonicalWorkspace, scanDocuments } from './documents.js';
import * as validate from './validation.js';
import type { DocumentSource, MemoryHit, MemoryInput, MemoryPacket, MemoryRecord, MemoryState, MemorySummary } from './contracts.js';

/** Trusted local-owner API. Agents receive bounded packets, never this mutable service. */
export class ProjectMemory {
  readonly #storage: MemoryDatabase;
  readonly #clock: () => number;
  readonly projectId: string;
  readonly workspaceRoot: string;
  constructor(directory: string, workspaceRoot: string, clock = Date.now) {
    this.workspaceRoot = canonicalWorkspace(workspaceRoot);
    this.projectId = readProject(workspaceRoot).projectId;
    this.#clock = clock;
    this.#storage = new MemoryDatabase(directory, workspaceRoot, this.projectId);
  }
  close(): void { this.#storage.close(); }
  #audit(action: string, id: string): void {
    this.#storage.db.prepare('INSERT INTO audit(action, record_id, at) VALUES (?, ?, ?)').run(action, id, this.#clock());
  }
  #records(): MemoryRecord[] {
    return this.#storage.db.prepare('SELECT body, state FROM records WHERE body IS NOT NULL ORDER BY id').all().map(row => ({
      ...JSON.parse(row.body as string) as MemoryRecord, state: row.state as MemoryState
    }));
  }
  #state(id: string): MemoryState | undefined {
    return this.#storage.db.prepare('SELECT state FROM records WHERE id = ?').get(id)?.state as MemoryState | undefined;
  }
  #current(record: MemoryInput, documents: DocumentSource[]): boolean {
    return record.sources.every(source => documents.some(doc => doc.path === source.path && doc.sha256 === source.sha256 && doc.status === source.status) &&
      !this.#storage.db.prepare('SELECT 1 FROM deleted_sources WHERE path = ? AND sha256 = ?').get(source.path, source.sha256));
  }
  #retire(id: string, state: MemoryState, redact = false): void {
    this.#storage.db.prepare('DELETE FROM memory_fts WHERE record_id = ?').run(id);
    this.#storage.db.prepare(`UPDATE records SET state = ?${redact ? ', body = NULL' : ''} WHERE id = ?`).run(state, id);
    this.#audit(state, id);
  }
  #expire(): void {
    const ids = this.#storage.db.prepare('SELECT id FROM records WHERE body IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ?').all(this.#clock());
    if (ids.length) this.#storage.transaction(() => { for (const row of ids) this.#retire(row.id as string, 'expired', true); });
  }
  #insert(raw: MemoryInput, documents: DocumentSource[]): string {
    const value = validate.input(raw);
    if (!this.#current(value, documents) || value.expiresAt !== undefined && value.expiresAt <= this.#clock()) throw new Error('memory source missing, deleted, changed or expired');
    const identity = { projectId: this.projectId, workspaceRoot: this.workspaceRoot, ...value };
    const id = digest(serialize(identity));
    if (this.#state(id)) return id; // Tombstones and superseded versions never resurrect automatically.
    const record: MemoryRecord = { ...identity, id, digest: id, createdAt: this.#clock(), state: 'candidate' };
    this.#storage.db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?)').run(id, record.digest, record.kind, record.state, record.expiresAt ?? null, JSON.stringify(record));
    this.#audit('candidate', id); return id;
  }
  /** Atomic scan/import. Draft/Accepted source labels are not owner validation. */
  ingest(): { imported: string[]; documents: number } {
    const documents = scanDocuments(this.workspaceRoot, this.projectId); this.#expire();
    return this.#storage.transaction(() => {
      for (const record of this.#records()) {
        const removed = record.sources.some(source => !documents.some(doc => doc.path === source.path));
        if (removed) this.#retire(record.id, 'deleted', true);
        else if (['candidate', 'validated'].includes(record.state) && !this.#current(record, documents)) this.#retire(record.id, 'superseded');
      }
      const imported: string[] = [];
      for (const doc of documents) {
        if (this.#storage.db.prepare('SELECT 1 FROM deleted_sources WHERE path = ? AND sha256 = ?').get(doc.path, doc.sha256)) continue;
        const value: MemoryInput = { kind: 'document', title: doc.title, text: doc.text.trim() || '(Empty document)',
          sources: [{ path: doc.path, sha256: doc.sha256, status: doc.status }] };
        imported.push(this.#insert(value, documents));
      }
      return { imported, documents: documents.length };
    });
  }
  add(raw: MemoryInput): string {
    const value = validate.input(raw);
    if (value.kind === 'document') throw new Error('documents must use ingestion');
    const documents = scanDocuments(this.workspaceRoot, this.projectId); this.#expire();
    if (value.supersedes) {
      const old = this.#records().find(record => record.id === value.supersedes);
      if (!old || old.state !== 'validated') throw new Error('superseded target must be a validated project record');
    }
    return this.#storage.transaction(() => this.#insert(value, documents));
  }
  list(): MemorySummary[] {
    const documents = scanDocuments(this.workspaceRoot, this.projectId); this.#expire();
    return freeze(this.#records().map(record => ({ id: record.id, digest: record.digest, kind: record.kind, state: record.state,
      title: record.title, current: this.#current(record, documents), sources: record.sources,
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }) })));
  }
  /** Owner review includes exact content and source qualification; ordinary retrieval excludes candidates. */
  inspect(id: string): Readonly<MemoryRecord> | undefined {
    validate.hash(id); const documents = scanDocuments(this.workspaceRoot, this.projectId); this.#expire();
    const record = this.#records().find(item => item.id === id);
    return record && ['candidate', 'validated'].includes(record.state) && this.#current(record, documents) ? freeze(record) : undefined;
  }
  validate(id: string, expectedDigest: string): void {
    validate.hash(id); validate.hash(expectedDigest);
    const documents = scanDocuments(this.workspaceRoot, this.projectId); this.#expire();
    this.#storage.transaction(() => {
      const record = this.#records().find(item => item.id === id);
      if (!record || record.digest !== expectedDigest || record.state !== 'candidate' || !this.#current(record, documents)) throw new Error('candidate validation mismatch');
      if (record.supersedes) {
        if (this.#state(record.supersedes) !== 'validated') throw new Error('superseded target changed');
        this.#retire(record.supersedes, 'superseded');
      }
      this.#storage.db.prepare('UPDATE records SET state = ? WHERE id = ?').run('validated', id);
      this.#storage.db.prepare('INSERT INTO memory_fts(record_id, title, text) VALUES (?, ?, ?)').run(id, record.title, record.text);
      this.#audit('validated-by-local-owner', id);
    });
  }
  remove(id: string, expectedDigest: string): void {
    validate.hash(id); validate.hash(expectedDigest);
    // Verify profile identity even for deletion, without requiring deleted source files to exist.
    if (readProject(this.workspaceRoot).projectId !== this.projectId) throw new Error('project identity changed');
    this.#storage.transaction(() => {
      const record = this.#records().find(item => item.id === id);
      if (!record || record.digest !== expectedDigest) throw new Error('deletion target mismatch');
      if (record.kind === 'document') {
        for (const source of record.sources) this.#storage.db.prepare('INSERT OR IGNORE INTO deleted_sources VALUES (?, ?)').run(source.path, source.sha256);
        for (const dependent of this.#records()) if (dependent.sources.some(source => record.sources.some(old => old.path === source.path && old.sha256 === source.sha256))) this.#retire(dependent.id, 'deleted', true);
      } else this.#retire(id, 'deleted', true);
    });
  }
  get(id: string): Readonly<MemoryRecord> | undefined {
    const record = this.inspect(id); return record?.state === 'validated' ? record : undefined;
  }
  search(query: string, limit = 10): MemoryHit[] {
    validate.text(query, 2048);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('invalid result limit');
    const documents = scanDocuments(this.workspaceRoot, this.projectId); this.#expire();
    const eligible = this.#records().filter(record => record.state === 'validated' && this.#current(record, documents));
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 32);
    if (!terms.length || !eligible.length) return [];
    const expression = terms.map(term => `"${term}"`).join(' OR ');
    // Each database is project/workspace-bound. Membership and validity are checked before matching.
    const matching = this.#storage.db.prepare('SELECT record_id FROM memory_fts WHERE memory_fts MATCH ? AND record_id = ?');
    const records = eligible.filter(record => !!matching.get(expression, record.id));
    const score = (record: MemoryRecord) => terms.reduce((n, term) => n + (record.title.toLowerCase().includes(term) ? 3 : 0) + (record.text.toLowerCase().includes(term) ? 1 : 0), 0);
    records.sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return freeze(records.slice(0, limit).map(record => {
      const lower = record.text.toLowerCase(), positions = terms.map(term => lower.indexOf(term)).filter(n => n >= 0);
      const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 120);
      // Slice by code points, then enforce byte budget for multibyte document text.
      let excerpt = record.text.slice(start, start + 1000);
      while (Buffer.byteLength(excerpt) > 3000) excerpt = excerpt.slice(0, -1);
      return { id: record.id, digest: record.digest, kind: record.kind, title: record.title, excerpt,
        sources: record.sources, ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }) };
    }));
  }
  packet(query: string): Readonly<MemoryPacket> {
    const entries: MemoryHit[] = [];
    const body = { schemaVersion: 1 as const, projectId: this.projectId, workspaceRoot: this.workspaceRoot, query, trust: 'evidence-only' as const, entries };
    for (const hit of this.search(query)) {
      entries.push(hit);
      if (Buffer.byteLength(serialize(body)) > 24000) { entries.pop(); break; }
    }
    return validate.packet({ ...body, digest: digest(serialize(body)) });
  }
  assertCurrent(packet: MemoryPacket): void {
    const checked = validate.packet(packet);
    if (checked.projectId !== this.projectId || checked.workspaceRoot !== this.workspaceRoot || checked.digest !== this.packet(checked.query).digest) throw new Error('memory context changed; prepare and review again');
  }
  rebuildIndex(): void {
    const documents = scanDocuments(this.workspaceRoot, this.projectId); this.#expire();
    this.#storage.transaction(() => {
      this.#storage.db.exec('DELETE FROM memory_fts');
      for (const record of this.#records()) if (record.state === 'validated' && this.#current(record, documents)) {
        this.#storage.db.prepare('INSERT INTO memory_fts(record_id, title, text) VALUES (?, ?, ?)').run(record.id, record.title, record.text);
      }
      this.#audit('rebuild-index', this.projectId);
    });
  }
  audit(): ReadonlyArray<{ action: string; recordId: string; at: number }> {
    if (readProject(this.workspaceRoot).projectId !== this.projectId) throw new Error('project identity changed');
    return freeze(this.#storage.db.prepare('SELECT action, record_id, at FROM audit ORDER BY sequence').all().map(row => ({ action: row.action as string, recordId: row.record_id as string, at: row.at as number })));
  }
}
