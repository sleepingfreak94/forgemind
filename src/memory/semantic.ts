import { dataSnapshot, digest, freeze, object, positive, serialize } from '../context-engine/validation.js';
import type { MemoryRecord } from './contracts.js';
import type { ProjectMemory } from './service.js';
import type { EmbeddingIdentity, EmbeddingProvider, EmbeddingRequest, RetrievalMode, SemanticHit, SemanticPacket } from './semantic-contracts.js';
import { semanticLimits as limits } from './semantic-contracts.js';
import { hash, text } from './validation.js';

const indexVersion = 'project-semantic-v1' as const;
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function identity(provider: EmbeddingProvider): Readonly<EmbeddingIdentity> {
  const value = dataSnapshot(provider.identity);
  object(value, ['model', 'version', 'dimensions']);
  text(value.model, 256); text(value.version, 256); positive(value.dimensions, limits.dimensions);
  return value;
}
/** Reject overflow rather than accepting an accidentally zero/NaN normalization. */
export function normalizeVector(raw: readonly number[], dimensions: number): readonly number[] {
  positive(dimensions, limits.dimensions);
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length !== dimensions ||
      Object.getOwnPropertySymbols(raw).length || Object.keys(raw).length !== dimensions) throw new Error('embedding dimension mismatch');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const vector: number[] = []; let squared = 0;
  for (let i = 0; i < dimensions; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable || typeof descriptor.value !== 'number' ||
        !Number.isFinite(descriptor.value)) throw new Error('invalid embedding vector');
    const value = descriptor.value as number;
    squared += value * value; vector.push(value);
    if (!Number.isFinite(squared)) throw new Error('embedding norm overflow');
  }
  if (!(squared > 0)) throw new Error('zero or underflowing embedding vector');
  const norm = Math.sqrt(squared);
  return Object.freeze(vector.map(value => value / norm));
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  const left = normalizeVector(a, a.length), right = normalizeVector(b, a.length);
  const score = left.reduce((sum, value, i) => sum + value * right[i]!, 0);
  if (!Number.isFinite(score)) throw new Error('invalid cosine');
  return Math.max(-1, Math.min(1, score));
}
interface BoundRecord { record: Readonly<MemoryRecord>; bindingDigest: string }
/** Trusted LOCAL OWNER only. A provider is code with access to the validated text passed to it. */
export class SemanticMemory {
  readonly #memory: ProjectMemory;
  readonly #provider: EmbeddingProvider | undefined;
  readonly #identity: Readonly<EmbeddingIdentity> | null;
  constructor(memory: ProjectMemory, provider?: EmbeddingProvider) {
    this.#memory = memory; this.#provider = provider;
    this.#identity = provider === undefined ? null : identity(provider);
    text(memory.projectId, 1024); text(memory.workspaceRoot, 4096);
  }
  status(): Readonly<{ status: 'ready' | 'provider-needed'; provider: EmbeddingIdentity | null; indexVersion: typeof indexVersion }> {
    this.#assertProvider();
    return freeze({ status: this.#provider ? 'ready' : 'provider-needed', provider: this.#identity, indexVersion });
  }
  #assertProvider(): void {
    if (this.#provider && serialize(identity(this.#provider)) !== serialize(this.#identity)) throw new Error('embedding provider identity drift');
  }
  #eligible(record: Readonly<MemoryRecord> | undefined): record is Readonly<MemoryRecord> {
    return !!record && record.state === 'validated' && record.projectId === this.#memory.projectId && record.workspaceRoot === this.#memory.workspaceRoot;
  }
  #bind(record: Readonly<MemoryRecord>): BoundRecord {
    hash(record.id); hash(record.digest);
    const bindingDigest = digest(serialize({ indexVersion, provider: this.#identity, projectId: record.projectId,
      workspaceRoot: record.workspaceRoot, recordDigest: record.digest, sources: record.sources, record: digest(serialize(record)) }));
    return { record, bindingDigest };
  }
  #current(bound: BoundRecord): boolean {
    const record = this.#memory.get(bound.record.id);
    return this.#eligible(record) && this.#bind(record).bindingDigest === bound.bindingDigest;
  }
  async #embed(purpose: EmbeddingRequest['purpose'], value: string, bindingDigest: string): Promise<readonly number[]> {
    this.#assertProvider();
    if (!this.#provider || !this.#identity) throw new Error('embedding provider needed');
    const request: EmbeddingRequest = freeze({ schemaVersion: 1, indexVersion, provider: this.#identity,
      projectId: this.#memory.projectId, workspaceRoot: this.#memory.workspaceRoot, purpose, text: value, bindingDigest });
    const raw = await this.#provider.embed(request);
    this.#assertProvider();
    return normalizeVector(raw, this.#identity.dimensions);
  }
  async search(query: string, mode: RetrievalMode = 'hybrid', limit = 10): Promise<Readonly<SemanticPacket>> {
    text(query, limits.queryBytes);
    if (!['semantic', 'hybrid'].includes(mode)) throw new Error('invalid retrieval mode');
    positive(limit, limits.results); this.#assertProvider();
    const entries: SemanticHit[] = [];
    const body = { schemaVersion: 1 as const, indexVersion, projectId: this.#memory.projectId, workspaceRoot: this.#memory.workspaceRoot,
      query, mode, trust: 'evidence-only' as const, status: this.#provider ? 'ready' as const : 'provider-needed' as const,
      provider: this.#identity, coverage: { policy: 'complete-or-reject' as const, eligible: 0, embedded: 0 }, entries };
    const packet = (): Readonly<SemanticPacket> => {
      const value = { ...body, digest: digest(serialize(body)) };
      if (Buffer.byteLength(serialize(value)) > limits.packetBytes) throw new Error('semantic packet budget exceeded');
      return freeze(value);
    };
    if (!this.#provider) return packet();
    const summaries = this.#memory.list().filter(item => item.current && item.state === 'validated').sort((a, b) => order(a.id, b.id));
    if (summaries.length > limits.corpusRecords) throw new Error('semantic corpus record budget exceeded');
    const corpus: BoundRecord[] = []; let bytes = 0;
    for (const summary of summaries) {
      const record = this.#memory.get(summary.id);
      if (!this.#eligible(record)) continue;
      const input = `${record.title}\n${record.text}`;
      text(input, limits.recordBytes); bytes += Buffer.byteLength(input);
      if (bytes > limits.corpusBytes) throw new Error('semantic corpus byte budget exceeded');
      corpus.push(this.#bind(record));
    }
    body.coverage.eligible = corpus.length;
    if (!corpus.length) return packet();
    const queryVector = await this.#embed('query', query, digest(serialize(corpus.map(item => item.bindingDigest))));
    // No raw text or vectors survive this invocation. Recheck after every asynchronous boundary.
    const ranked: Array<{ bound: BoundRecord; score: number; rank: number }> = [];
    for (const bound of corpus) {
      if (!this.#current(bound)) continue;
      const vector = await this.#embed('record', `${bound.record.title}\n${bound.record.text}`, bound.bindingDigest);
      if (!this.#current(bound)) continue;
      ranked.push({ bound, score: cosine(queryVector, vector), rank: 0 });
    }
    body.coverage.embedded = ranked.length;
    const current = ranked.filter(item => this.#current(item.bound));
    current.sort((a, b) => b.score - a.score || order(a.bound.record.id, b.bound.record.id));
    const lexical = mode === 'hybrid' ? this.#memory.search(query, 10) : [];
    const lexicalRanks = new Map(lexical.map((hit, i) => [hit.id, { rank: i + 1, digest: hit.digest }]));
    current.forEach((item, i) => {
      const lex = lexicalRanks.get(item.bound.record.id);
      item.rank = mode === 'semantic' ? item.score : 1 / (60 + i + 1) +
        (lex?.digest === item.bound.record.digest ? 1 / (60 + lex.rank) : 0);
    });
    current.sort((a, b) => b.rank - a.rank || order(a.bound.record.id, b.bound.record.id));
    for (const item of current) {
      if (entries.length >= limit) break;
      if (!this.#current(item.bound)) continue;
      const record = item.bound.record;
      let excerpt = record.text.slice(0, 1000);
      while (Buffer.byteLength(excerpt) > 2000) excerpt = excerpt.slice(0, -1);
      entries.push({ id: record.id, digest: record.digest, kind: record.kind, title: record.title, excerpt,
        sources: record.sources, semanticScore: item.score, rankScore: item.rank, bindingDigest: item.bound.bindingDigest,
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }) });
      if (Buffer.byteLength(serialize({ ...body, digest: '0'.repeat(64) })) > limits.packetBytes) { entries.pop(); break; }
    }
    // Last boundary: deletion, deregistration, expiry, supersession and mutations fail closed.
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      const bound = corpus.find(item => item.record.id === entry.id);
      if (!bound || !this.#current(bound)) entries.splice(i, 1);
    }
    this.#assertProvider(); return packet();
  }
}
