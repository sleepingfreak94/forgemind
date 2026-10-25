import { performance } from 'node:perf_hooks';
import { dataSnapshot, serialize } from '../context-engine/validation.js';
import { sha } from './run-recording.js';
import { renderWeeklyEmail } from './weekly-email.js';
import type { Summary } from './weekly-summary.js';
import { outboxEntry, recipient, shape } from './weekly-delivery-envelope.js';
import type { EmailEnvelope } from './weekly-delivery-envelope.js';
import type { AdapterResult, OwnerEmailAdapter } from './weekly-delivery.js';
import { createGmailSmtpTransport, gmailDeadline, gmailUsername } from './gmail-smtp-transport.js';
import type { GmailSmtpFactory, GmailSmtpTransport } from './gmail-smtp-transport.js';

export interface GmailOwnerOptions {
  readonly username: string;
  readonly recipient: string;
  readonly deadlineMs?: number;
}
/** Owner-supplied in-memory resolution only; never files/env/argv in this module. */
export type GmailAppPasswordResolver = () => string | Promise<string>;
interface Binding { username: string; recipient: string; deadlineMs: number }
interface Message { subject: string; text: string; html?: string; messageId: string; receiptId: string; date: Date }
const uncertain = () => new Error('Gmail SMTP result uncertain');
export const gmailSetupTestText = 'ForgeMind delivery setup test. No project content included.';
export function gmailMessageId(id: string): string {
  sha(id); return '<forgemind-weekly.' + id + '@forgemind.invalid>';
}
function binding(raw: GmailOwnerOptions, resolver: GmailAppPasswordResolver, factory: GmailSmtpFactory): Binding {
  try {
    const v = dataSnapshot(raw);
    shape(v, Object.hasOwn(v, 'deadlineMs') ? ['username', 'recipient', 'deadlineMs'] : ['username', 'recipient']);
    gmailUsername(v.username); recipient(v.recipient);
    const deadlineMs = Object.hasOwn(v, 'deadlineMs') ? v.deadlineMs : 20000;
    gmailDeadline(deadlineMs);
    if (typeof resolver !== 'function' || typeof factory !== 'function') throw uncertain();
    return { username: v.username, recipient: v.recipient, deadlineMs };
  } catch { throw new Error('Invalid private Gmail SMTP owner configuration'); }
}
function canonical(raw: EmailEnvelope, address: string): EmailEnvelope {
  const v = dataSnapshot(raw);
  shape(v, ['schemaVersion', 'id', 'projectId', 'originalRoot', 'dueAt', 'summaryId',
    'summaryDigest', 'recipient', 'subject', 'body']);
  if (typeof v.projectId !== 'string' || typeof v.originalRoot !== 'string') throw uncertain();
  const message = outboxEntry({ schemaVersion: 1, envelope: v, status: 'pending',
    attempts: 0, receiptId: null, serviceId: null }, v.projectId, v.originalRoot).envelope;
  if (message.recipient !== address) throw uncertain();
  return message;
}
function accepted(raw: unknown, from: string, to: string, messageId: string): void {
  const value = dataSnapshot(raw);
  const required = ['accepted', 'rejected', 'response', 'messageId', 'envelope'];
  if (!value || typeof value !== 'object') throw uncertain();
  const v = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(v, key))) throw uncertain();
  const allowed = [...required, 'pending', 'envelopeTime', 'messageTime', 'messageSize', 'ehlo', 'rejectedErrors'];
  shape(v, Object.keys(v));
  if (Object.keys(v).some(key => !allowed.includes(key)) ||
      serialize(v.accepted) !== serialize([to]) || serialize(v.rejected) !== '[]' ||
      Object.hasOwn(v, 'pending') && serialize(v.pending) !== '[]' ||
      Object.hasOwn(v, 'rejectedErrors') && serialize(v.rejectedErrors) !== '[]' ||
      v.messageId !== messageId || typeof v.response !== 'string' ||
      v.response.length > 4096 || !/^250 2\.0\.0(?: [\x20-\x7e]+)?$/.test(v.response)) throw uncertain();
  shape(v.envelope, ['from', 'to']);
  if (v.envelope.from !== from || serialize(v.envelope.to) !== serialize([to])) throw uncertain();
}
function send(config: Binding, resolver: GmailAppPasswordResolver, factory: GmailSmtpFactory,
  prepare: () => Message): Promise<AdapterResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let settled = false, transport: GmailSmtpTransport | undefined, message: Message;
    const expired = () => performance.now() - started >= config.deadlineMs;
    const finish = (ok = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { transport?.close(); } catch { ok = false; }
      if (ok) resolve({ status: 'accepted', receiptId: message.receiptId });
      else reject(uncertain());
    };
    const timer = setTimeout(() => finish(), config.deadlineMs);
    // Snapshot and canonically validate before the first async boundary or password access.
    try { message = prepare(); } catch { finish(); return; }
    Promise.resolve().then(() => {
      if (settled || expired()) throw uncertain();
      return resolver();
    }).then(password => {
      if (settled || expired()) { finish(); return; }
      if (typeof password !== 'string' || !/^[a-z]{16}$/.test(password)) throw uncertain();
      transport = factory({ username: config.username, appPassword: password, deadlineMs: config.deadlineMs,
        expiresAt: started + config.deadlineMs });
      if (settled || expired()) { finish(); return; }
      return transport.sendMail({
        from: { address: config.username, name: '' }, to: [{ address: config.recipient, name: '' }],
        envelope: { from: config.username, to: [config.recipient] },
        subject: message.subject, text: message.text, ...(message.html === undefined ? {} : { html: message.html }),
        messageId: message.messageId, date: message.date,
        encoding: 'utf-8', textEncoding: 'base64', attachments: [], alternatives: [],
        disableFileAccess: true, disableUrlAccess: true
      });
    }).then(info => {
      if (settled) return;
      if (expired()) { finish(); return; }
      accepted(info, config.username, config.recipient, message.messageId); finish(true);
    }).catch(() => finish());
  });
}
/** Dormant callback; explicit WeeklyDelivery.dispatch owns consent and durable no-replay. */
export function createGmailSmtpAdapter(raw: GmailOwnerOptions, resolver: GmailAppPasswordResolver,
  factory: GmailSmtpFactory = createGmailSmtpTransport): OwnerEmailAdapter {
  const config = binding(raw, resolver, factory);
  return envelope => send(config, resolver, factory, () => {
    const e = canonical(envelope, config.recipient);
    const rendered = renderWeeklyEmail(JSON.parse(e.body) as Summary);
    return { subject: e.subject, text: rendered.text, html: rendered.html, messageId: gmailMessageId(e.id),
      receiptId: 'gmail-smtp-' + e.id, date: new Date(e.dueAt) };
  });
}
/** Separate one-off domain. Owner MUST durably claim stableTestId before I/O; no dedupe here. */
export function sendGmailSetupTest(raw: GmailOwnerOptions, stableTestId: string,
  resolver: GmailAppPasswordResolver, factory: GmailSmtpFactory = createGmailSmtpTransport): Promise<AdapterResult> {
  const config = binding(raw, resolver, factory);
  return send(config, resolver, factory, () => {
    sha(stableTestId);
    return { subject: gmailSetupTestText, text: gmailSetupTestText,
      messageId: '<forgemind-setup.' + stableTestId + '@forgemind.invalid>',
      receiptId: 'gmail-smtp-setup-' + stableTestId, date: new Date() };
  });
}
