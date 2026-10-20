import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SendMailOptions } from 'nodemailer';
import { createGmailSmtpAdapter, gmailMessageId, gmailSetupTestText, sendGmailSetupTest } from '../../src/memory/gmail-smtp.js';
import type { GmailOwnerOptions } from '../../src/memory/gmail-smtp.js';
import type { GmailSmtpFactory } from '../../src/memory/gmail-smtp-transport.js';
import { envelope } from '../../src/memory/weekly-delivery-envelope.js';
import type { EmailEnvelope } from '../../src/memory/weekly-delivery-envelope.js';
import { createWeeklyAccumulator, finishWeeklySummary } from '../../src/memory/weekly-summary.js';
import { WeeklyDelivery } from '../../src/memory/weekly-delivery.js';
import { serialize } from '../../src/context-engine/validation.js';
import { fixture } from './fixture.js';

const options = { username: 'offline.owner@gmail.com', recipient: 'recipient@example.invalid' };
const password = 'abcdefghijklmnop'; // Offline fixture only; no credential resolution or SMTP network.
const message = () => envelope(finishWeeklySummary(createWeeklyAccumulator({ projectId: 'project',
  originalRoot: resolve('/', 'project'), dueAt: 0, lowerExclusive: 0, upperInclusive: 0 })), options.recipient);
function info(m: SendMailOptions): Record<string, unknown> {
  return { accepted: [options.recipient], rejected: [], envelope: m.envelope,
    messageId: m.messageId, response: '250 2.0.0 offline-provider-raw-text', envelopeTime: 1, messageTime: 1, messageSize: 1 };
}
function fake(response: (m: SendMailOptions) => unknown | Promise<unknown> = info) {
  let opens = 0, sends = 0, closes = 0, sent: SendMailOptions | undefined;
  const factory: GmailSmtpFactory = connection => {
    opens++; assert.equal(connection.username, options.username); assert.equal(connection.appPassword, password);
    return { async sendMail(m) { sends++; sent = m; return response(m); }, close() { closes++; } };
  };
  return { factory, get opens() { return opens; }, get sends() { return sends; },
    get closes() { return closes; }, get sent() { return sent!; } };
}
test('factory is dormant; sends exact canonical plain body, fixed sender and sole explicit recipient once', async () => {
  const f = fake(); let resolutions = 0;
  const adapter = createGmailSmtpAdapter(options, () => { resolutions++; return password; }, f.factory);
  assert.equal(resolutions, 0); assert.equal(f.opens, 0); assert.deepEqual(Object.keys(adapter), []);
  const e = message(), result = await adapter(e);
  assert.equal(result.status, 'accepted'); assert.equal(f.opens, 1); assert.equal(f.sends, 1); assert.equal(f.closes, 1);
  assert.equal(f.sent.text, e.body); assert.equal(f.sent.subject, e.subject);
  assert.equal(f.sent.messageId, gmailMessageId(e.id));
  assert.deepEqual(f.sent.from, { address: options.username, name: '' });
  assert.deepEqual(f.sent.to, [{ address: options.recipient, name: '' }]);
  assert.deepEqual(f.sent.envelope, { from: options.username, to: [options.recipient] });
  assert.equal(f.sent.disableFileAccess, true); assert.equal(f.sent.disableUrlAccess, true);
  assert.deepEqual(f.sent.attachments, []); assert.deepEqual(f.sent.alternatives, []);
  for (const k of ['cc', 'bcc', 'html', 'raw', 'auth', 'headers', 'replyTo']) assert.ok(!Object.hasOwn(f.sent, k));
  assert.ok(!serialize(result).includes(password)); assert.ok(!serialize(result).includes('offline-provider-raw-text'));
});
test('snapshot is taken before async password resolution and preserves canonical immutable message identity', async () => {
  const f = fake(), e = { ...message() }, expected = e.body;
  const pending = createGmailSmtpAdapter(options, () => Promise.resolve(password), f.factory)(e);
  e.body = 'caller mutation'; e.subject = 'caller mutation';
  assert.equal((await pending).status, 'accepted'); assert.equal(f.sent.text, expected);
});
test('wrong destination, corrupt/extra fields, getters and proxies reject before password or transport', async () => {
  let touched = false, resolves = 0;
  const f = fake(), e = message(), adapter = createGmailSmtpAdapter(options, () => { resolves++; return password; }, f.factory);
  const getter = Object.defineProperty({ ...e }, 'body', { enumerable: true, get() { touched = true; return e.body; } });
  for (const raw of [getter, new Proxy(e, {}), { ...e, recipient: 'other@example.invalid' }, { ...e, subject: e.subject + '\r\nBcc: bad' },
    { ...e, body: e.body + ' ' }, { ...e, id: '0'.repeat(64) }, { ...e, summaryDigest: '0'.repeat(64) },
    { ...e, extra: true }, { ...e, body: 'x'.repeat(65537) }, Object.defineProperty({ ...e }, 'hidden', { value: 1 })])
    await assert.rejects(adapter(raw as EmailEnvelope), { message: 'Gmail SMTP result uncertain' });
  assert.equal(touched, false); assert.equal(resolves, 0); assert.equal(f.opens, 0);
});
test('only exact private owner fields and canonical Gmail sender/mailbox/deadline accepted', () => {
  let touched = false;
  const getter = Object.defineProperty({ ...options }, 'username', { enumerable: true, get() { touched = true; return options.username; } });
  for (const raw of [getter, new Proxy(options, {}), { ...options, host: 'evil.invalid' }, { ...options, sender: 'other@gmail.com' },
    { ...options, appPassword: password }, { ...options, username: 'Name <x@gmail.com>' }, { ...options, username: 'x@example.invalid' },
    { ...options, username: 'X@gmail.com' }, { ...options, recipient: 'a@example.invalid,b@example.invalid' },
    { ...options, recipient: 'a@example.invalid\r\nBcc: bad' }, { ...options, deadlineMs: 0 }, { ...options, deadlineMs: 30001 },
    { ...options, deadlineMs: undefined }, { ...options, deadlineMs: NaN }, { ...options, deadlineMs: 1.1 }])
    assert.throws(() => createGmailSmtpAdapter(raw as GmailOwnerOptions, () => password), { message: 'Invalid private Gmail SMTP owner configuration' });
  assert.equal(touched, false);
});
test('password errors and invalid values are sanitized and never open a transport', async () => {
  const f = fake();
  for (const raw of ['', 'not-an-app-password', password + ' ', password.toUpperCase(), { secret: password }])
    await assert.rejects(createGmailSmtpAdapter(options, () => raw as string, f.factory)(message()), { message: 'Gmail SMTP result uncertain' });
  await assert.rejects(createGmailSmtpAdapter(options, () => { throw Error(password); }, f.factory)(message()),
    { message: 'Gmail SMTP result uncertain' });
  assert.equal(f.opens, 0);
});
test('password deadline prevents late resolution from creating an SMTP connection', async t => {
  let now = 0, release!: (p: string) => void, entered!: () => void;
  t.mock.method(performance, 'now', () => now); t.mock.timers.enable({ apis: ['setTimeout'] });
  const resolving = new Promise<void>(r => { entered = r; });
  const f = fake(), adapter = createGmailSmtpAdapter({ ...options, deadlineMs: 10 },
    () => new Promise(r => { release = r; entered(); }), f.factory);
  const pending = adapter(message()); await resolving;
  const rejected = assert.rejects(pending, { message: 'Gmail SMTP result uncertain' });
  now = 11; t.mock.timers.tick(11); await rejected;
  release(password); await Promise.resolve(); await Promise.resolve(); assert.equal(f.opens, 0);
});
test('unknown, contradictory, partial and descriptor-bearing acceptance stays uncertain without response retention', async () => {
  let touched = false;
  const mutations: ((m: SendMailOptions) => unknown)[] = [
    m => ({ ...info(m), accepted: ['other@example.invalid'] }), m => ({ ...info(m), accepted: [options.recipient, options.recipient] }),
    m => ({ ...info(m), rejected: [options.recipient] }), m => ({ ...info(m), pending: [options.recipient] }),
    m => ({ ...info(m), response: '251 2.0.0 forwarded' }), m => ({ ...info(m), response: '250 5.1.1 contradiction' }),
    m => ({ ...info(m), response: '250 2.0.0 ok\r\ninjected' }), m => ({ ...info(m), response: 'x'.repeat(4097) }),
    m => ({ ...info(m), messageId: 'wrong' }), m => ({ ...info(m), envelope: { from: options.username, to: ['other@example.invalid'] } }),
    m => ({ ...info(m), envelope: { from: 'other@gmail.com', to: [options.recipient] } }),
    m => Object.defineProperty(info(m), 'response', { enumerable: true, get() { touched = true; return password; } }),
    m => new Proxy(info(m), {}), m => ({ ...info(m), providerSecret: password }), () => null
  ];
  for (const mutate of mutations) {
    const f = fake(mutate);
    await assert.rejects(createGmailSmtpAdapter(options, () => password, f.factory)(message()), { message: 'Gmail SMTP result uncertain' });
    assert.equal(f.sends, 1); assert.equal(f.closes, 1);
  }
  assert.equal(touched, false);
});
test('empty pending is accepted; factory/send/cleanup errors never escape or trigger retries', async () => {
  const good = fake(m => ({ ...info(m), pending: [] }));
  assert.equal((await createGmailSmtpAdapter(options, () => password, good.factory)(message())).status, 'accepted');
  for (const factory of [
    () => { throw Error(password); },
    () => ({ sendMail() { throw Error(password); }, close() {} }),
    () => ({ async sendMail(m: SendMailOptions) { return info(m); }, close() { throw Error(password); } })
  ]) await assert.rejects(createGmailSmtpAdapter(options, () => password, factory)(message()), { message: 'Gmail SMTP result uncertain' });
});
test('total deadline closes hung send and ignores late acceptance; one connection attempt only', async t => {
  let now = 0, finish!: (v: unknown) => void, entered!: () => void;
  t.mock.method(performance, 'now', () => now); t.mock.timers.enable({ apis: ['setTimeout'] });
  const sending = new Promise<void>(r => { entered = r; });
  const f = fake(() => new Promise(r => { finish = r; entered(); }));
  const pending = createGmailSmtpAdapter({ ...options, deadlineMs: 10 }, () => password, f.factory)(message());
  await sending;
  const rejected = assert.rejects(pending, { message: 'Gmail SMTP result uncertain' });
  now = 11; t.mock.timers.tick(11); await rejected;
  assert.equal(f.closes, 1); finish(info(f.sent)); await Promise.resolve(); assert.equal(f.sends, 1); assert.equal(f.closes, 1);
});
test('separate setup helper has exact fixed payload/domain, no summary or arbitrary message input, no dedupe claim', async () => {
  const f = fake(), id = 'b'.repeat(64);
  const result = await sendGmailSetupTest(options, id, () => password, f.factory);
  assert.equal(result.status, 'accepted'); assert.equal(f.sent.subject, gmailSetupTestText); assert.equal(f.sent.text, gmailSetupTestText);
  assert.equal(gmailSetupTestText, 'ForgeMind delivery setup test. No project content included.');
  assert.equal(f.sent.messageId, '<forgemind-setup.' + id + '@forgemind.invalid>');
  assert.notEqual(f.sent.messageId, gmailMessageId(id));
  assert.deepEqual(f.sent.envelope, { from: options.username, to: [options.recipient] });
  const invalid = fake();
  await assert.rejects(sendGmailSetupTest(options, '../bad', () => password, invalid.factory));
  assert.equal(invalid.opens, 0);
  assert.throws(() => sendGmailSetupTest({ ...options, subject: 'arbitrary' } as GmailOwnerOptions, id, () => password, f.factory));
  await sendGmailSetupTest(options, id, () => password, f.factory);
  assert.equal(f.sends, 2); // Host ledger, not this helper or Message-ID, must prevent replay.
});
for (const accepted of [true, false]) test('WeeklyDelivery restart never replays ' + (accepted ? 'accepted' : 'uncertain') + ' SMTP attempt', async () => {
  const f = fixture(), due = Date.UTC(2026, 9, 18, 4, 30); let now = due - 1, sends = 0;
  const d = new WeeklyDelivery(f.directory, f.root, () => now);
  d.configure({ enabled: true, recipient: options.recipient, consent: true }); d.schedule.configure(); now = due;
  const adapter = createGmailSmtpAdapter(options, () => password, () => ({
    async sendMail(m) { sends++; assert.equal(d.outbox()[0]!.status, 'uncertain'); if (!accepted) throw Error(password); return info(m); },
    close() {}
  }));
  try {
    const e = d.tick().delivery.entry!, auth = { recipient: options.recipient, consent: true as const, serviceId: 'gmail-owner-fixture' };
    assert.equal(JSON.parse(e.envelope.body).selectedRuns, 0);
    assert.equal((await d.dispatch(e.envelope.id, auth, adapter)).status, accepted ? 'accepted' : 'uncertain');
    d.close(); const reopened = new WeeklyDelivery(f.directory, f.root, () => now);
    try {
      assert.equal((await reopened.dispatch(e.envelope.id, auth, adapter)).status, accepted ? 'accepted' : 'uncertain');
      assert.equal(reopened.tick().delivery.entry!.attempts, 1); assert.equal(sends, 1);
      const bytes = readFileSync(reopened.schedule.store.database.path).toString();
      assert.ok(!bytes.includes(password)); assert.ok(!bytes.includes('offline-provider-raw-text'));
    } finally { reopened.close(); }
  } finally { d.close(); f.dispose(); }
});
