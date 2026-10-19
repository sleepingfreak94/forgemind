import { bytes, dataSnapshot, digest, object, serialize, string } from '../context-engine/validation.js';
import { natural, sha } from './run-recording.js';
import { validateWeeklySummary } from './weekly-summary.js';
import type { Summary } from './weekly-summary.js';

export const maxEnvelopeBytes = 98304;
export interface DeliveryConfig {
  readonly schemaVersion: 1; readonly projectId: string; readonly originalRoot: string;
  readonly enabled: boolean; readonly recipient: string | null; readonly consent: boolean; readonly maxBytes: number;
}
export interface EmailEnvelope {
  readonly schemaVersion: 1; readonly id: string; readonly projectId: string; readonly originalRoot: string;
  readonly dueAt: number; readonly summaryId: string; readonly summaryDigest: string;
  readonly recipient: string; readonly subject: string; readonly body: string;
}
export interface OutboxEntry {
  readonly schemaVersion: 1; readonly envelope: EmailEnvelope;
  readonly status: 'pending' | 'accepted' | 'uncertain'; readonly attempts: number; readonly receiptId: string | null; readonly serviceId: string | null;
}
export function shape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  object(value, keys);
  if (keys.some(key => !Object.hasOwn(value, key))) throw new Error('missing delivery field');
}
/** Intentionally narrow mailbox syntax: no display names, Unicode, comments or headers. */
export function recipient(value: unknown): asserts value is string {
  string(value, 254);
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)) throw new Error('invalid recipient');
  const [local, domain] = value.split('@');
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      !domain || domain !== domain.toLowerCase() || !domain.includes('.') ||
      domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('invalid mailbox');
}
export function budget(value: unknown): asserts value is number {
  natural(value);
  if (value < 1024 || value > maxEnvelopeBytes) throw new Error('invalid delivery byte budget');
}
export function deliveryConfig(raw: unknown, projectId: string, originalRoot: string): DeliveryConfig {
  const v = dataSnapshot(raw);
  shape(v, ['schemaVersion', 'projectId', 'originalRoot', 'enabled', 'recipient', 'consent', 'maxBytes']);
  if (v.schemaVersion !== 1 || v.projectId !== projectId || v.originalRoot !== originalRoot ||
      typeof v.enabled !== 'boolean' || typeof v.consent !== 'boolean') throw new Error('invalid delivery scope/config');
  if (v.recipient !== null) recipient(v.recipient);
  if ((v.recipient === null) !== !v.consent) throw new Error('explicit destination consent required');
  budget(v.maxBytes);
  return v as unknown as DeliveryConfig;
}
export function envelope(raw: Summary, address: string): EmailEnvelope {
  const summary = validateWeeklySummary(raw); recipient(address);
  const id = digest(serialize({ domain: 'weekly-email-v1', projectId: summary.projectId,
    originalRoot: summary.originalRoot, dueAt: summary.dueAt, recipient: address }));
  const value: EmailEnvelope = { schemaVersion: 1, id, projectId: summary.projectId, originalRoot: summary.originalRoot,
    dueAt: summary.dueAt, summaryId: summary.id, summaryDigest: summary.digest, recipient: address,
    subject: 'ForgeMind weekly summary ' + new Date(summary.dueAt).toISOString(), body: serialize(summary) };
  if (bytes(serialize(value)) > maxEnvelopeBytes) throw new Error('email envelope too large');
  return dataSnapshot(value);
}
export function receipt(value: unknown): asserts value is string {
  string(value, 256);
  if (!/^[\x21-\x7e]+$/.test(value)) throw new Error('invalid adapter receipt');
}
export function outboxEntry(raw: unknown, projectId: string, originalRoot: string): OutboxEntry {
  const v = dataSnapshot(raw);
  shape(v, ['schemaVersion', 'envelope', 'status', 'attempts', 'receiptId', 'serviceId']);
  shape(v.envelope, ['schemaVersion', 'id', 'projectId', 'originalRoot', 'dueAt', 'summaryId', 'summaryDigest', 'recipient', 'subject', 'body']);
  string(v.envelope.body, 65536); recipient(v.envelope.recipient); sha(v.envelope.id);
  const summary = validateWeeklySummary(JSON.parse(v.envelope.body));
  if (summary.projectId !== projectId || summary.originalRoot !== originalRoot ||
      serialize(envelope(summary, v.envelope.recipient)) !== serialize(v.envelope) ||
      v.schemaVersion !== 1 || !['pending', 'accepted', 'uncertain'].includes(v.status as string)) throw new Error('invalid outbox scope/content');
  natural(v.attempts);
  if (v.serviceId !== null) receipt(v.serviceId);
  if ((v.attempts === 0) !== (v.serviceId === null)) throw new Error('missing owner service binding');
  if (v.status === 'accepted') receipt(v.receiptId);
  else if (v.receiptId !== null) throw new Error('unexpected acceptance receipt');
  if (v.status !== 'pending' && v.attempts === 0) throw new Error('missing adapter attempt');
  return v as unknown as OutboxEntry;
}
