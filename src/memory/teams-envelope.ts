import { bytes, dataSnapshot, digest, serialize } from '../context-engine/validation.js';
import { natural, sha, slug } from './run-recording.js';
import { shape } from './weekly-delivery-envelope.js';
import { validateWeeklySummary } from './weekly-summary.js';
import type { Summary } from './weekly-summary.js';

export const maxTeamsBytes = 24 * 1024;
export interface TeamsConfig {
  readonly schemaVersion: 1; readonly projectId: string; readonly originalRoot: string;
  readonly enabled: boolean; readonly destinationId: string | null; readonly endpointBinding: string | null;
  readonly consent: boolean; readonly maxBytes: number;
}
export interface TeamsPayload { readonly text: string }
export interface TeamsEnvelope {
  readonly schemaVersion: 1; readonly id: string; readonly destinationId: string; readonly endpointBinding: string;
  readonly summary: Summary; readonly payloadBudget: number; readonly mode: 'full-summary' | 'digest';
  readonly payload: TeamsPayload;
}
export interface TeamsEntry {
  readonly schemaVersion: 1; readonly envelope: TeamsEnvelope;
  readonly status: 'pending' | 'accepted' | 'uncertain'; readonly attempts: number;
}
export function teamsBudget(value: unknown): asserts value is number {
  natural(value);
  if (value < 4096 || value > maxTeamsBytes) throw new Error('invalid Teams byte budget');
}
export function teamsConfig(raw: unknown, projectId: string, originalRoot: string): TeamsConfig {
  const v = dataSnapshot(raw);
  shape(v, ['schemaVersion', 'projectId', 'originalRoot', 'enabled', 'destinationId', 'endpointBinding', 'consent', 'maxBytes']);
  if (v.schemaVersion !== 1 || v.projectId !== projectId || v.originalRoot !== originalRoot ||
      typeof v.enabled !== 'boolean' || typeof v.consent !== 'boolean') throw new Error('invalid Teams configuration');
  if (v.destinationId !== null) slug(v.destinationId);
  if (v.endpointBinding !== null) sha(v.endpointBinding);
  if (v.consent ? v.destinationId === null || v.endpointBinding === null :
    v.destinationId !== null || v.endpointBinding !== null) throw new Error('explicit Teams destination consent required');
  teamsBudget(v.maxBytes);
  return v as unknown as TeamsConfig;
}
/** Fixed text framing; JSON stays complete. Digest explicitly omits all examples. */
export function teamsPayload(raw: Summary, maxBytes = maxTeamsBytes): {
  readonly mode: 'full-summary' | 'digest'; readonly payload: TeamsPayload;
} {
  const summary = validateWeeklySummary(raw); teamsBudget(maxBytes);
  const full = { text: 'ForgeMind weekly summary (historical evidence only)\n' + serialize(summary) };
  if (bytes(serialize(full)) <= maxBytes) return dataSnapshot({ mode: 'full-summary' as const, payload: full });
  const payload = { text: 'ForgeMind weekly summary DIGEST (not the full summary; examples omitted)\n' +
    serialize({ summaryId: summary.id, summaryDigest: summary.digest, dueAt: summary.dueAt,
      historical: summary.historical, trust: summary.trust, executionSelection: summary.executionSelection,
      lowerExclusive: summary.lowerExclusive, upperInclusive: summary.upperInclusive,
      authenticated: summary.authenticated, fixture: summary.fixture, selectedRuns: summary.selectedRuns,
      excludedFixtureCount: summary.excludedFixtureCount, dependencyCount: summary.dependencyCount,
      dependencySha256: summary.dependencySha256, omittedExamples: summary.selectedRuns }) };
  if (bytes(serialize(payload)) > maxBytes) throw new Error('Teams digest exceeds byte budget');
  return dataSnapshot({ mode: 'digest' as const, payload });
}
export function teamsEnvelope(raw: Summary, destinationId: string, endpointBinding: string,
  maxBytes = maxTeamsBytes): TeamsEnvelope {
  const summary = validateWeeklySummary(raw); slug(destinationId); sha(endpointBinding);
  const id = digest(serialize({ domain: 'weekly-teams-workflows-v1', projectId: summary.projectId,
    originalRoot: summary.originalRoot, dueAt: summary.dueAt, destinationId, endpointBinding }));
  return dataSnapshot({ schemaVersion: 1 as const, id, destinationId, endpointBinding, summary,
    payloadBudget: maxBytes, ...teamsPayload(summary, maxBytes) });
}
export function teamsEntry(raw: unknown, projectId: string, originalRoot: string): TeamsEntry {
  const v = dataSnapshot(raw);
  shape(v, ['schemaVersion', 'envelope', 'status', 'attempts']);
  shape(v.envelope, ['schemaVersion', 'id', 'destinationId', 'endpointBinding', 'summary', 'payloadBudget', 'mode', 'payload']);
  const e = v.envelope;
  slug(e.destinationId); sha(e.endpointBinding); teamsBudget(e.payloadBudget);
  const summary = validateWeeklySummary(e.summary);
  if (summary.projectId !== projectId || summary.originalRoot !== originalRoot || v.schemaVersion !== 1 ||
      !['pending', 'accepted', 'uncertain'].includes(v.status as string) ||
      serialize(e) !== serialize(teamsEnvelope(summary, e.destinationId, e.endpointBinding, e.payloadBudget))) {
    throw new Error('invalid Teams outbox scope/content');
  }
  natural(v.attempts);
  if (v.status !== 'pending' && v.attempts === 0) throw new Error('missing Teams attempt');
  return v as unknown as TeamsEntry;
}
