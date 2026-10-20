import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { digest, serialize } from '../../src/context-engine/validation.js';
import { SlackDelivery } from '../../src/memory/slack-delivery.js';
import { WeeklyDelivery } from '../../src/memory/weekly-delivery.js';
import { slackEntry, slackPayload, slackLiteral } from '../../src/memory/slack-envelope.js';
import { createSlackWebhookAdapter } from '../../src/memory/slack-transport.js';
import type { SlackTransport } from '../../src/memory/slack-transport.js';
import { createWeeklyAccumulator, finishWeeklySummary } from '../../src/memory/weekly-summary.js';
import { RunHistory } from '../../src/memory/run-history.js';
import { fixture } from './fixture.js';

const due = Date.UTC(2026, 9, 18, 4, 30), week = 7 * 86400000;
// Deliberately fake Slack-shaped fixture. Every send uses an injected offline transport.
const fakeUrl = 'https://hooks.slack.com/services/T00000000/B00000000/offline_fixture_not_a_secret';
const accepted: SlackTransport = async () => ({ statusCode: 200, acknowledged: true });
function owner(url = fakeUrl, transport: SlackTransport = accepted, destinationId = 'weekly-team') {
  return createSlackWebhookAdapter({ destinationId, webhookUrl: url }, transport);
}
function authorization(adapter = owner()) { return { ...adapter, consent: true as const }; }
function options(adapter = owner()) { return { ...adapter, enabled: true, consent: true }; }
function ready() {
  const f = fixture(); let now = due - 1;
  const d = new SlackDelivery(f.directory, f.root, () => now);
  d.schedule.configure(); d.configure(options()); now = due;
  return { f, d, advance() { now += week; }, dispose() { d.close(); f.dispose(); } };
}
test('Slack defaults disabled; preview without email/destination; no read causes enqueue or configuration', () => {
  const f = fixture(), d = new SlackDelivery(f.directory, f.root, () => due);
  try {
    assert.equal(d.status().status, 'disabled'); assert.equal(d.tick().schedule.status, 'disabled');
    d.configure({ enabled: true, destinationId: null, endpointBinding: null, consent: false });
    d.schedule.configure(); assert.equal(d.tick().delivery.status, 'pending-configuration');
    const rows = serialize(d.schedule.store.database.db.prepare('SELECT * FROM owner_values ORDER BY key').all());
    assert.equal(d.preview().status, 'ready'); assert.equal(d.status().status, 'pending-configuration');
    assert.deepEqual(d.outbox(), []);
    assert.equal(serialize(d.schedule.store.database.db.prepare('SELECT * FROM owner_values ORDER BY key').all()), rows);
    assert.equal(d.schedule.store.get('weekly-email-config'), undefined);
    d.configure(options()); assert.equal(d.recoverLatest().status, 'enqueued');
  } finally { d.close(); f.dispose(); }
});
test('retained result crash gap, restart, independent connections and keyset pagination deduplicate', () => {
  const r = ready(), d = r.d;
  d.schedule.tick(); d.close();
  const reopened = new SlackDelivery(r.f.directory, r.f.root, () => due);
  const other = new SlackDelivery(r.f.directory, r.f.root, () => due + week);
  try {
    const a = reopened.recoverLatest(); assert.equal(a.status, 'enqueued');
    const exact = serialize(a.entry);
    assert.equal(other.recoverLatest().status, 'existing'); assert.equal(reopened.outbox().length, 1);
    assert.equal(other.tick().schedule.status, 'committed');
    assert.equal(reopened.outbox().length, 2);
    const first = reopened.outbox({ limit: 1 })[0]!;
    assert.equal(reopened.outbox({ after: first.envelope.id }).length, 1);
    assert.equal(serialize(reopened.outbox().find(e => e.envelope.id === a.entry!.envelope.id)), exact);
    assert.ok(Object.isFrozen(reopened.outbox()[0]!.envelope.payload));
  } finally { other.close(); reopened.close(); r.dispose(); }
});
test('real owner adapter capability posts immutable JSON once and retains only acceptance, never secret', async () => {
  const r = ready(); let calls = 0;
  const adapter = owner(fakeUrl, async req => {
    calls++; assert.equal(r.d.outbox()[0]?.status, 'uncertain');
    assert.equal(req.url, fakeUrl);
    assert.equal(req.body, serialize(r.d.outbox()[0]!.envelope.payload));
    assert.ok(Buffer.byteLength(req.body) <= 24576); assert.deepEqual(Object.keys(JSON.parse(req.body)), ['mrkdwn', 'parse', 'text', 'unfurl_links', 'unfurl_media']);
    return { statusCode: 200, acknowledged: true };
  });
  try {
    const entry = r.d.tick().delivery.entry!;
    assert.equal((await r.d.dispatch(entry.envelope.id, authorization())).status, 'pending-configuration');
    const result = await r.d.dispatch(entry.envelope.id, authorization(adapter), adapter);
    assert.equal(result.status, 'accepted');
    assert.equal((await r.d.dispatch(entry.envelope.id, authorization(adapter), adapter)).status, 'accepted');
    assert.equal(calls, 1); assert.equal(result.entry?.attempts, 1);
    const reopened = new SlackDelivery(r.f.directory, r.f.root, () => due);
    try { assert.equal((await reopened.dispatch(entry.envelope.id, authorization(adapter), adapter)).status, 'accepted'); }
    finally { reopened.close(); }
    assert.equal(calls, 1);
    const persisted = readFileSync(r.d.schedule.store.database.path).toString('utf8');
    for (const secret of [fakeUrl, 'offline_fixture_not_a_secret', 'hooks.slack.com']) assert.ok(!persisted.includes(secret));
    assert.ok(!serialize(result).includes('receiptId'));
  } finally { r.dispose(); }
});
test('competing claim, interrupted send, restart and later ticks never replay uncertain', async () => {
  const r = ready(), other = new SlackDelivery(r.f.directory, r.f.root, () => due);
  let calls = 0, release!: () => void;
  const adapter = owner(fakeUrl, async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); throw Error(fakeUrl); });
  try {
    const entry = r.d.tick().delivery.entry!;
    const first = r.d.dispatch(entry.envelope.id, authorization(adapter), adapter);
    await Promise.resolve(); await Promise.resolve();
    assert.equal((await other.dispatch(entry.envelope.id, authorization(adapter), adapter)).status, 'uncertain');
    assert.equal(calls, 1); release(); assert.equal((await first).status, 'uncertain');
    other.close();
    const restarted = new SlackDelivery(r.f.directory, r.f.root, () => due);
    try {
      assert.equal(restarted.tick().delivery.status, 'existing');
      assert.equal((await restarted.dispatch(entry.envelope.id, authorization(adapter), adapter)).status, 'uncertain');
      assert.equal(calls, 1);
    } finally { restarted.close(); }
  } finally { other.close(); r.dispose(); }
});
test('same ID with rotated URL or different destination cannot send stale entries', async () => {
  const r = ready(); let calls = 0;
  const newer = owner(fakeUrl + '-rotated', async () => { calls++; return { statusCode: 200, acknowledged: true }; });
  const elsewhere = owner(fakeUrl, accepted, 'other-team');
  try {
    const old = r.d.tick().delivery.entry!;
    r.d.configure(options(newer));
    await assert.rejects(r.d.dispatch(old.envelope.id, authorization(newer), newer), /mismatch/);
    const fresh = r.d.recoverLatest().entry!;
    assert.notEqual(fresh.envelope.id, old.envelope.id);
    await assert.rejects(r.d.dispatch(fresh.envelope.id, authorization(newer), owner()), /mismatch/);
    r.d.configure(options(elsewhere));
    const third = r.d.recoverLatest().entry!; assert.notEqual(third.envelope.id, fresh.envelope.id);
    assert.equal(calls, 0); assert.equal(r.d.outbox().length, 3);
  } finally { r.dispose(); }
});
test('Slack config/disable never rewrites email or schedule state; email and Slack can coexist', async () => {
  const r = ready(), email = new WeeklyDelivery(r.f.directory, r.f.root, () => due);
  try {
    email.configure({ enabled: true, recipient: 'owner@example.invalid', consent: true });
    const emailConfig = serialize(email.status().config), schedule = serialize(email.schedule.store.get('schedule'));
    r.d.configure({ ...options(), enabled: false });
    assert.equal(serialize(email.schedule.store.get('schedule')), schedule);
    assert.equal(serialize(email.status().config), emailConfig);
    assert.equal(r.d.tick().schedule.status, 'disabled');
    r.d.configure(options()); const e = r.d.tick().delivery.entry!;
    assert.equal(email.recoverLatest().status, 'enqueued'); assert.equal(email.outbox().length, 1);
    r.d.configure({ enabled: false, destinationId: null, endpointBinding: null, consent: false });
    assert.equal((await r.d.dispatch(e.envelope.id, authorization(), owner())).status, 'disabled');
    assert.equal(r.d.outbox().length, 1); assert.equal(email.status().status, 'outbox-ready');
  } finally { email.close(); r.dispose(); }
});
test('schedule reconfiguration between validation and claim/recovery refuses sends', async () => {
  const r = ready(); let calls = 0;
  const adapter = owner(fakeUrl, async () => { calls++; return { statusCode: 200, acknowledged: true }; });
  try {
    const e = r.d.tick().delivery.entry!, original = r.d.schedule.status.bind(r.d.schedule);
    r.d.schedule.status = () => { const s = original(); r.d.schedule.disable(); return s; };
    await assert.rejects(r.d.dispatch(e.envelope.id, authorization(adapter), adapter), /schedule changed/);
    assert.equal(calls, 0); assert.equal(r.d.outbox()[0]?.attempts, 0);
    r.d.schedule.status = original; r.d.schedule.configure();
    r.d.schedule.status = () => { const s = original(); r.d.schedule.disable(); return s; };
    assert.throws(() => r.d.recoverLatest(), /schedule changed/);
  } finally { r.dispose(); }
});
test('locked transaction, corrupt config/envelope and failed acceptance save fail closed', async () => {
  const r = ready(), db = r.d.schedule.store, lock = new DatabaseSync(db.database.path);
  try {
    r.d.schedule.tick(); lock.exec('BEGIN IMMEDIATE');
    try { assert.throws(() => r.d.recoverLatest(), /locked|busy/i); } finally { lock.exec('ROLLBACK'); }
    assert.deepEqual(r.d.outbox(), []);
    const e = r.d.recoverLatest().entry!, key = 'weekly-slack:' + e.envelope.id;
    db.put(key, { ...e, envelope: { ...e.envelope, payload: { text: 'changed' } } }); assert.throws(() => r.d.outbox());
    db.put(key, e); db.put('weekly-slack-config', null); assert.throws(() => r.d.status());
    db.put('weekly-slack-config', { ...options(), schemaVersion: 1, projectId: db.projectId, originalRoot: db.originalRoot, maxBytes: 24576 });
    const put = db.put.bind(db);
    db.put = (key, value) => { if ((value as { status?: string }).status === 'accepted') throw Error('fixture disk failure'); put(key, value); };
    await assert.rejects(r.d.dispatch(e.envelope.id, authorization(), owner()), /disk failure/);
    db.put = put; assert.equal(r.d.outbox()[0]?.status, 'uncertain');
  } finally { lock.close(); r.dispose(); }
});
test('plain data/descriptors, explicit consent, forged adapters and bounded pages reject safely', async () => {
  const r = ready(); let touched = false;
  try {
    const get = Object.defineProperty(options(), 'destinationId', { enumerable: true, get() { touched = true; return 'x'; } });
    for (const raw of [get, new Proxy(options(), {}), { ...options(), extra: 1 }, { ...options(), consent: false },
      { ...options(), destinationId: '../bad' }, { ...options(), maxBytes: 24577 },
      Object.defineProperty(options(), 'hidden', { value: 1 }), { ...options(), [Symbol()]: 1 }]) {
      assert.throws(() => r.d.configure(raw));
    }
    assert.equal(touched, false);
    for (const raw of [{ limit: 0 }, { limit: 101 }, { after: '../' }]) assert.throws(() => r.d.outbox(raw));
    const e = r.d.tick().delivery.entry!;
    await assert.rejects(r.d.dispatch(e.envelope.id, authorization(), { ...owner() }), /trusted/);
    assert.throws(() => slackEntry({ ...e, status: 'accepted' }, r.f.projectId, r.f.root));
    assert.throws(() => slackEntry({ ...e, attempts: 1 }, r.f.projectId, r.f.root));
    assert.equal(r.d.outbox()[0]?.attempts, 0);
  } finally { r.dispose(); }
});
test('scope isolation inherits private store protections and digest payload stays complete at UTF-8 budget', () => {
  const r = ready(), history = new RunHistory(r.f.directory, r.f.root, () => due);
  const clone = join(r.f.base, 'clone'); cpSync(r.f.root, clone, { recursive: true });
  const other = new SlackDelivery(r.f.directory, clone, () => due);
  try {
    r.d.schedule.configure({ maxBytes: 65536 });
    for (let n = 0; n < 8; n++) history.record({ schemaVersion: 1, runId: digest('run' + n), taskId: 'task' + n,
      execution: 'authenticated', startedAt: 1, endedAt: 2, outcome: 'completed', lastPhase: 'terminal',
      baselineSource: digest('base'), candidateSource: digest('candidate'), changedPaths: Array.from({ length: 45 }, (_, p) => 'src/' + p + 'é'.repeat(25) + '.ts'),
      checks: [{ phase: 'candidate', id: 'check', outcome: 'passed', exitCode: 0,
        source: digest('candidate'), evidenceSha256: digest('check') }],
      review: { outcome: 'pass', source: digest('candidate'), evidenceSha256: digest('review') },
      terminalReceiptSha256: digest('receipt') });
    const entry = r.d.tick().delivery.entry!, summary = entry.envelope.summary;
    assert.ok(Buffer.byteLength(serialize(summary)) > 24576);
    assert.equal(entry.envelope.mode, 'digest');
    const body = entry.envelope.payload.text; assert.match(body, /DIGEST.*not the full summary/);
    const parsed = JSON.parse(body.slice(body.indexOf('\n') + 1));
    assert.equal(parsed.summaryDigest, summary.digest); assert.equal(parsed.omittedExamples, summary.selectedRuns);
    assert.ok(Buffer.byteLength(serialize(entry.envelope.payload)) <= 24576);
    assert.equal(slackPayload(summary, 4096).mode, 'digest');
    assert.equal(other.status().status, 'disabled'); assert.deepEqual(other.outbox(), []);
    assert.throws(() => new SlackDelivery(join(r.f.root, 'state'), r.f.root), /external/);
  } finally { other.close(); history.close(); r.dispose(); }
});

test('literal controls escape mentions/entities and account for expansion without enabling formatting', () => {
  const dangerous = '/project/<!here>-<@U123>-<#C123>-&lt;!channel&gt;-*bold*-https:example.com';
  // Slack controls are raw text, not valid Windows path characters. Keep metadata roots canonical.
  const summary = finishWeeklySummary(createWeeklyAccumulator({ projectId: 'project', originalRoot: resolve(tmpdir(), 'project', '&lt;!channel&gt;'),
    dueAt: 0, lowerExclusive: 0, upperInclusive: 0 }));
  const { mode, payload: p } = slackPayload(summary);
  assert.equal(mode, 'full-summary'); assert.equal(p.mrkdwn, false); assert.equal(p.parse, 'none');
  assert.equal(p.unfurl_links, false); assert.equal(p.unfurl_media, false);
  assert.ok(!Object.hasOwn(p, 'link_names')); assert.ok(!Object.hasOwn(p, 'channel'));
  assert.ok(!p.text.includes('<')); assert.ok(!p.text.includes('>'));
  assert.match(slackLiteral(dangerous), /&lt;!here&gt;/); assert.match(p.text, /&amp;lt;!channel&amp;gt;/);
  assert.equal(slackLiteral(dangerous), '/project/&lt;!here&gt;-&lt;@U123&gt;-&lt;#C123&gt;-&amp;lt;!channel&amp;gt;-*bold*-https:example.com');
  assert.equal(p.text, slackLiteral('ForgeMind weekly summary (historical evidence only)\n' + serialize(summary)));
  assert.equal(slackLiteral('&<>'), '&amp;&lt;&gt;');
  const expanded = finishWeeklySummary(createWeeklyAccumulator({ projectId: 'project', originalRoot: resolve('/', 'project', '&'.repeat(900)),
    dueAt: 0, lowerExclusive: 0, upperInclusive: 0 }));
  const digestPayload = slackPayload(expanded, 4096);
  assert.equal(digestPayload.mode, 'digest');
  assert.ok(Buffer.byteLength(serialize(digestPayload.payload)) <= 4096);
  const r = ready();
  try {
    const e = r.d.tick().delivery.entry!;
    assert.throws(() => slackEntry({ ...e, envelope: { ...e.envelope, payload: { ...e.envelope.payload, mrkdwn: true } } }, r.f.projectId, r.f.root));
  } finally { r.dispose(); }
});
