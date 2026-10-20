import { bytes, dataSnapshot, digest, serialize } from '../context-engine/validation.js';
import { natural, sha, slug } from './run-recording.js';
import { shape } from './weekly-delivery-envelope.js';
import { validateWeeklySummary } from './weekly-summary.js';
import type { Summary } from './weekly-summary.js';

export const maxSlackBytes = 24 * 1024;
export interface SlackConfig {
  readonly schemaVersion: 1; readonly projectId: string; readonly originalRoot: string;
  readonly enabled: boolean; readonly destinationId: string | null; readonly endpointBinding: string | null;
  readonly consent: boolean; readonly maxBytes: number;
}
export interface SlackPayload {
  readonly text: string; readonly mrkdwn: false; readonly parse: 'none';
  readonly unfurl_links: false; readonly unfurl_media: false;
}
/** Slack's control characters only; do not HTML-encode the JSON payload. */
export function slackLiteral(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function literalPayload(text: string): SlackPayload {
  return { text: slackLiteral(text), mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false };
}
export interface SlackEnvelope {
  readonly schemaVersion: 1; readonly id: string; readonly destinationId: string; readonly endpointBinding: string;
  readonly summary: Summary; readonly payloadBudget: number; readonly mode: 'full-summary' | 'digest';
  readonly payload: SlackPayload;
}
export interface SlackEntry {
  readonly schemaVersion: 1; readonly envelope: SlackEnvelope;
  readonly status: 'pending' | 'accepted' | 'uncertain'; readonly attempts: number;
}
export function slackBudget(value: unknown): asserts value is number {
  natural(value);
  if (value < 4096 || value > maxSlackBytes) throw new Error('invalid Slack byte budget');
}
export function slackConfig(raw: unknown, projectId: string, originalRoot: string): SlackConfig {
  const v = dataSnapshot(raw);
  shape(v, ['schemaVersion', 'projectId', 'originalRoot', 'enabled', 'destinationId', 'endpointBinding', 'consent', 'maxBytes']);
  if (v.schemaVersion !== 1 || v.projectId !== projectId || v.originalRoot !== originalRoot ||
      typeof v.enabled !== 'boolean' || typeof v.consent !== 'boolean') throw new Error('invalid Slack configuration');
  if (v.destinationId !== null) slug(v.destinationId);
  if (v.endpointBinding !== null) sha(v.endpointBinding);
  if (v.consent ? v.destinationId === null || v.endpointBinding === null :
    v.destinationId !== null || v.endpointBinding !== null) throw new Error('explicit Slack destination consent required');
  slackBudget(v.maxBytes);
  return v as unknown as SlackConfig;
}
/** Fixed text framing; JSON stays complete. Digest explicitly omits all examples. */
export function slackPayload(raw: Summary, maxBytes = maxSlackBytes): {
  readonly mode: 'full-summary' | 'digest'; readonly payload: SlackPayload;
} {
  const summary = validateWeeklySummary(raw); slackBudget(maxBytes);
  const full = literalPayload('ForgeMind weekly summary (historical evidence only)\n' + serialize(summary));
  if (bytes(serialize(full)) <= maxBytes) return dataSnapshot({ mode: 'full-summary' as const, payload: full });
  const payload = literalPayload('ForgeMind weekly summary DIGEST (not the full summary; examples omitted)\n' +
    serialize({ summaryId: summary.id, summaryDigest: summary.digest, dueAt: summary.dueAt,
      historical: summary.historical, trust: summary.trust, executionSelection: summary.executionSelection,
      lowerExclusive: summary.lowerExclusive, upperInclusive: summary.upperInclusive,
      authenticated: summary.authenticated, fixture: summary.fixture, selectedRuns: summary.selectedRuns,
      excludedFixtureCount: summary.excludedFixtureCount, dependencyCount: summary.dependencyCount,
      dependencySha256: summary.dependencySha256, omittedExamples: summary.selectedRuns }));
  if (bytes(serialize(payload)) > maxBytes) throw new Error('Slack digest exceeds byte budget');
  return dataSnapshot({ mode: 'digest' as const, payload });
}
export function slackEnvelope(raw: Summary, destinationId: string, endpointBinding: string,
  maxBytes = maxSlackBytes): SlackEnvelope {
  const summary = validateWeeklySummary(raw); slug(destinationId); sha(endpointBinding);
  const id = digest(serialize({ domain: 'weekly-slack-incoming-v1', projectId: summary.projectId,
    originalRoot: summary.originalRoot, dueAt: summary.dueAt, destinationId, endpointBinding }));
  return dataSnapshot({ schemaVersion: 1 as const, id, destinationId, endpointBinding, summary,
    payloadBudget: maxBytes, ...slackPayload(summary, maxBytes) });
}
export function slackEntry(raw: unknown, projectId: string, originalRoot: string): SlackEntry {
  const v = dataSnapshot(raw);
  shape(v, ['schemaVersion', 'envelope', 'status', 'attempts']);
  shape(v.envelope, ['schemaVersion', 'id', 'destinationId', 'endpointBinding', 'summary', 'payloadBudget', 'mode', 'payload']);
  const e = v.envelope;
  slug(e.destinationId); sha(e.endpointBinding); slackBudget(e.payloadBudget);
  const summary = validateWeeklySummary(e.summary);
  if (summary.projectId !== projectId || summary.originalRoot !== originalRoot || v.schemaVersion !== 1 ||
      !['pending', 'accepted', 'uncertain'].includes(v.status as string) ||
      serialize(e) !== serialize(slackEnvelope(summary, e.destinationId, e.endpointBinding, e.payloadBudget))) {
    throw new Error('invalid Slack outbox scope/content');
  }
  natural(v.attempts);
  if (v.attempts !== (v.status === 'pending' ? 0 : 1)) throw new Error('invalid Slack attempt state');
  return v as unknown as SlackEntry;
}
