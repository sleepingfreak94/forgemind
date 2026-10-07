import { dataSnapshot, object, string, positive, digest, serialize } from '../context-engine/validation.js';
import { relativePath } from '../project-workflow/validation.js';
import { displayText } from './documents.js';
import type { Citation, MemoryInput, MemoryPacket } from './contracts.js';

export function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid digest');
}
export function text(value: unknown, max: number): asserts value is string {
  string(value, max); if (!value.trim() || displayText(value) !== value) throw new Error('unsafe memory text');
}
export function citation(raw: Citation): void {
  object(raw, ['path', 'sha256', 'status']); relativePath(raw.path); hash(raw.sha256); text(raw.status, 1024);
}
export function input(raw: MemoryInput): Readonly<MemoryInput> {
  const value = dataSnapshot(raw);
  object(value, ['kind', 'title', 'text', 'sources', 'expiresAt', 'supersedes']);
  if (!['document', 'decision', 'fact', 'lesson', 'fix'].includes(value.kind)) throw new Error('invalid memory kind');
  text(value.title, 1024); text(value.text, 1048576);
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 16) throw new Error('sources required');
  value.sources.forEach(citation);
  if (new Set(value.sources.map(source => source.path)).size !== value.sources.length) throw new Error('duplicate source');
  if (value.expiresAt !== undefined) positive(value.expiresAt);
  if (value.supersedes !== undefined) hash(value.supersedes);
  return value;
}
export function packet(raw: MemoryPacket): Readonly<MemoryPacket> {
  const value = dataSnapshot(raw);
  object(value, ['schemaVersion', 'projectId', 'workspaceRoot', 'query', 'trust', 'entries', 'digest']);
  if (value.schemaVersion !== 1 || value.trust !== 'evidence-only') throw new Error('invalid memory packet');
  text(value.projectId, 1024); text(value.workspaceRoot, 4096); text(value.query, 2048);
  if (!Array.isArray(value.entries) || value.entries.length > 10 || Buffer.byteLength(serialize(value)) > 32768) throw new Error('oversized memory packet');
  for (const entry of value.entries) {
    object(entry, ['id', 'digest', 'kind', 'title', 'excerpt', 'sources', 'expiresAt']);
    hash(entry.id); hash(entry.digest);
    input({ kind: entry.kind, title: entry.title, text: entry.excerpt, sources: entry.sources,
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }) });
    text(entry.excerpt, 4096);
  }
  if (new Set(value.entries.map(entry => entry.id)).size !== value.entries.length) throw new Error('duplicate packet record');
  const { digest: stored, ...body } = value;
  if (stored !== digest(serialize(body))) throw new Error('memory packet digest mismatch');
  return value;
}
