import { ContextBoundaryError } from './contracts.js';
import type { ContextEvidence, ContextScope } from './contracts.js';
import { bytes, digest, positive, serialize } from './validation.js';

/** Temporary host-owned originals; no disk, cross-process or durable memory authority. */
export class MemoryOriginalStore {
  readonly #entries = new Map<string, { scope: string; evidence: ContextEvidence; expiresAt: number; size: number }>();
  readonly #clock: () => number;
  readonly #ttlMs: number;
  readonly #maxBytes: number;
  #size = 0;
  constructor(options: { ttlMs: number; maxBytes: number; clock?: () => number }) {
    positive(options.ttlMs, 86400000); positive(options.maxBytes, 16 * 1024 * 1024);
    this.#clock = options.clock ?? Date.now;
    this.#ttlMs = options.ttlMs;
    this.#maxBytes = options.maxBytes;
  }
  #prune(): void {
    for (const [key, entry] of this.#entries) if (entry.expiresAt <= this.#clock()) this.#remove(key);
  }
  #remove(key: string): void {
    const entry = this.#entries.get(key);
    if (entry) { this.#size -= entry.size; this.#entries.delete(key); }
  }
  put(scope: ContextScope, evidence: ContextEvidence, expiresAt: number): string {
    this.#prune();
    const namespace = serialize(scope);
    const key = this.reference(scope, evidence);
    const size = bytes(JSON.stringify(evidence));
    if (size > this.#maxBytes) throw new ContextBoundaryError('original-unavailable');
    this.#remove(key);
    while (this.#size + size > this.#maxBytes) this.#remove(this.#entries.keys().next().value!);
    this.#entries.set(key, { scope: namespace, evidence: structuredClone(evidence), size,
      expiresAt: Math.min(expiresAt, this.#clock() + this.#ttlMs) });
    this.#size += size;
    return key;
  }
  get(scope: ContextScope, reference: string): ContextEvidence {
    this.#prune();
    const entry = this.#entries.get(reference);
    if (!entry || entry.scope !== serialize(scope)) throw new ContextBoundaryError('original-unavailable');
    return structuredClone(entry.evidence);
  }
  deleteScope(scope: ContextScope): void {
    for (const [key, entry] of this.#entries) if (entry.scope === serialize(scope)) this.#remove(key);
  }
  reference(scope: ContextScope, evidence: ContextEvidence): string {
    return digest(serialize({ scope, id: evidence.id, contentDigest: evidence.contentDigest, sourceUri: evidence.sourceUri, sourceVersion: evidence.sourceVersion }));
  }
  deleteReference(reference: string): void { this.#remove(reference); }
  clear(): void { this.#entries.clear(); this.#size = 0; }
}
