import type { MemoryHit } from './contracts.js';

export interface EmbeddingIdentity {
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
}
/** Implementations are trusted local-owner adapters. No provider is selected by this module. */
export interface EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  embed(request: Readonly<EmbeddingRequest>): Promise<readonly number[]>;
}
export interface EmbeddingRequest {
  readonly schemaVersion: 1;
  readonly indexVersion: 'project-semantic-v1';
  readonly provider: EmbeddingIdentity;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly purpose: 'query' | 'record';
  readonly text: string;
  /** Query: digest of the current corpus bindings. Record: digest of its full binding. */
  readonly bindingDigest: string;
}
export type RetrievalMode = 'semantic' | 'hybrid';
export interface SemanticHit extends MemoryHit {
  semanticScore: number;
  rankScore: number;
  bindingDigest: string;
}
export interface SemanticPacket {
  schemaVersion: 1;
  indexVersion: 'project-semantic-v1';
  projectId: string;
  workspaceRoot: string;
  query: string;
  mode: RetrievalMode;
  trust: 'evidence-only';
  status: 'ready' | 'provider-needed';
  provider: EmbeddingIdentity | null;
  coverage: { policy: 'complete-or-reject'; eligible: number; embedded: number };
  entries: SemanticHit[];
  digest: string;
}
export const semanticLimits = Object.freeze({
  dimensions: 4096, corpusRecords: 256, recordBytes: 32768,
  corpusBytes: 262144, queryBytes: 2048, results: 10, packetBytes: 24000
});
