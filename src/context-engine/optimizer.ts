import { CompressionUnavailable, ContextBoundaryError } from './contracts.js';
import type { AgentContextView, ContextEvidence, ContextOptimizer, ContextScope, EvidenceAuthority, EvidenceView, OptimizationInput, OptimizationResult, TokenCounter } from './contracts.js';
import type { HeadroomCompressor } from './headroom.js';
import { MemoryOriginalStore } from './originals.js';
import { bytes, digest, freeze, serialize, snapshot, string, validateScope } from './validation.js';

export interface OptimizerOptions {
  authority: EvidenceAuthority;
  originals: MemoryOriginalStore;
  compressor?: HeadroomCompressor;
  tokenCounter?: TokenCounter;
  clock?: () => number;
}
/** Host-only assembly service. An agent-specific view never changes canonical authority. */
export class PacketContextOptimizer implements ContextOptimizer {
  readonly #options: OptimizerOptions;
  readonly #clock: () => number;
  constructor(options: OptimizerOptions) {
    if (!options.authority || typeof options.authority.authorize !== 'function' || !(options.originals instanceof MemoryOriginalStore)) {
      throw new ContextBoundaryError('invalid-input');
    }
    this.#options = { ...options };
    this.#clock = options.clock ?? Date.now;
  }
  #live(expiresAt: number, signal?: AbortSignal): void {
    if (signal?.aborted) throw new ContextBoundaryError('cancelled');
    if (expiresAt <= this.#clock()) throw new ContextBoundaryError('expired');
  }
  async #authorize(phase: 'read' | 'compress' | 'pack' | 'recover', scope: ContextScope, evidence: readonly ContextEvidence[], signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new ContextBoundaryError('cancelled');
    let result;
    try {
      result = await this.#options.authority.authorize(freeze({ phase, scope,
        evidence: evidence.map(e => ({ id: e.id, contentDigest: e.contentDigest,
          sourceUri: e.sourceUri, sourceVersion: e.sourceVersion, compressible: e.compressible })) }), signal);
    } catch {
      throw new ContextBoundaryError(signal?.aborted ? 'cancelled' : 'denied');
    }
    if (signal?.aborted) throw new ContextBoundaryError('cancelled');
    if (result.allowed !== true) throw new ContextBoundaryError('denied');
    string(result.receiptId, 256);
    return result.receiptId;
  }
  #budget(view: AgentContextView, input: OptimizationInput): number {
    const encoded = serialize(view);
    const size = bytes(encoded);
    if (size > input.budget.maxBytes) throw new ContextBoundaryError('budget-exceeded');
    if (input.budget.maxTokens !== undefined) {
      const counter = this.#options.tokenCounter;
      if (!counter) throw new ContextBoundaryError('invalid-input');
      string(counter.id, 128);
      const tokens = counter.count(encoded);
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new ContextBoundaryError('invalid-input');
      if (tokens > input.budget.maxTokens) throw new ContextBoundaryError('budget-exceeded');
    }
    return size;
  }
  async optimize(raw: OptimizationInput, signal?: AbortSignal): Promise<OptimizationResult> {
    const input = snapshot(raw);
    this.#live(input.expiresAt, signal);
    if (input.budget.maxTokens !== undefined && !this.#options.tokenCounter) throw new ContextBoundaryError('invalid-input');
    const canonicalPacketDigest = digest(serialize(input));
    const authorizationReceipts = [await this.#authorize('read', input.scope, input.evidence, signal)];
    this.#live(input.expiresAt, signal);
    const evidence: EvidenceView[] = input.evidence.map(e => ({ id: e.id, sourceUri: e.sourceUri, sourceVersion: e.sourceVersion,
      originalDigest: e.contentDigest, contentDigest: e.contentDigest, content: e.content,
      originalReference: this.#options.originals.reference(input.scope, e), mode: 'original' }));
    const view: AgentContextView = { schemaVersion: 1, scope: structuredClone(input.scope),
      protected: structuredClone(input.protected), evidence, canonicalPacketDigest };
    const beforeBytes = bytes(serialize(view));
    const warnings: string[] = [];
    // Protected content and metadata cannot be shrunk to force a packet into budget.
    this.#budget({ ...view, evidence: evidence.map(e => ({ ...e, content: '' })) }, input);
    if (this.#options.compressor) {
      for (let index = 0; index < input.evidence.length; index++) {
        const original = input.evidence[index]!;
        if (!original.compressible || !original.content.length) continue;
        authorizationReceipts.push(await this.#authorize('compress', input.scope, [original], signal));
        this.#live(input.expiresAt, signal);
        try {
          const result = await this.#options.compressor.compress(input.scope, original, signal);
          this.#live(input.expiresAt, signal);
          authorizationReceipts.push(result.receiptId);
          if (bytes(result.content) < bytes(original.content)) {
            evidence[index] = { ...evidence[index]!, content: result.content, contentDigest: digest(result.content), mode: 'compressed' };
          }
        } catch (error) {
          if (!(error instanceof CompressionUnavailable)) throw error;
          this.#live(input.expiresAt, signal);
          evidence[index]!.mode = 'fallback';
          warnings.push(`compression-unavailable:${original.id}`);
        }
      }
    }
    this.#live(input.expiresAt, signal);
    const afterBytes = this.#budget(view, input);
    authorizationReceipts.push(await this.#authorize('pack', input.scope, input.evidence, signal));
    this.#live(input.expiresAt, signal);
    // Store only after all authority/budget checks; never expose an unavailable recovery reference.
    input.evidence.forEach(e => this.#options.originals.put(input.scope, e, input.expiresAt));
    input.evidence.forEach((e, i) => this.#options.originals.get(input.scope, evidence[i]!.originalReference));
    this.#live(input.expiresAt, signal);
    return freeze({ view, viewDigest: digest(serialize(view)),
      optimizerId: this.#options.compressor?.id ?? 'pass-through-v1', beforeBytes, afterBytes,
      authorizationReceipts, warnings });
  }
  async recover(rawScope: ContextScope, reference: string, signal?: AbortSignal): Promise<ContextEvidence> {
    const scope = validateScope(rawScope); string(reference, 64);
    if (signal?.aborted) throw new ContextBoundaryError('cancelled');
    const original = this.#options.originals.get(scope, reference);
    await this.#authorize('recover', scope, [original], signal);
    // Recheck TTL/deletion after awaiting authorization. Authorization handles live grant/source checks.
    return freeze(this.#options.originals.get(scope, reference));
  }
}

/** The default mode: identical protected sections/evidence with provenance and budget gates. */
export class PassThroughContextOptimizer extends PacketContextOptimizer {
  constructor(options: Omit<OptimizerOptions, 'compressor'>) {
    super({ authority: options.authority, originals: options.originals,
      ...(options.tokenCounter ? { tokenCounter: options.tokenCounter } : {}),
      ...(options.clock ? { clock: options.clock } : {}) });
  }
}
