import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, cpSync, linkSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest, serialize } from '../../src/context-engine/validation.js';
import { RunHistory } from '../../src/memory/run-history.js';
import { WeeklyDelivery } from '../../src/memory/weekly-delivery.js';
import type { AdapterResult, OutboxEntry, OwnerEmailAdapter } from '../../src/memory/weekly-delivery.js';
import { recipient } from '../../src/memory/weekly-delivery-envelope.js';
import { fixture } from './fixture.js';

const due = Date.UTC(2026, 9, 18, 4, 30), week = 7 * 86400000;
const address = 'owner@example.invalid';
const authorization = { recipient: address, consent: true as const, serviceId: 'offline-fixture' };
const options = { enabled: true, recipient: address, consent: true };

function ready() {
  const f = fixture(); let now = due - 1;
  const delivery = new WeeklyDelivery(f.directory, f.root, () => now);
  delivery.schedule.configure(); delivery.configure(options); now = due;
  return { f, delivery, advance() { now += week; }, dispose() { delivery.close(); f.dispose(); } };
}

test('default disabled; missing recipient keeps usable retained preview without enqueue or sends', () => {
  const f = fixture(), d = new WeeklyDelivery(f.directory, f.root, () => due);
  try {
    assert.equal(d.status().status, 'disabled');
    assert.equal(d.tick().schedule.status, 'disabled'); assert.deepEqual(d.outbox(), []);
    d.configure({ enabled: true, recipient: null, consent: false }); d.schedule.configure();
    const result = d.tick();
    assert.equal(result.schedule.status, 'committed'); assert.ok(result.schedule.summary);
    assert.equal(result.delivery.status, 'pending-configuration'); assert.deepEqual(d.outbox(), []);
    assert.equal(d.status().status, 'pending-configuration');
    d.configure(options); assert.equal(d.recoverLatest().status, 'enqueued');
    assert.equal(d.outbox()[0]?.status, 'pending');
  } finally { d.close(); f.dispose(); }
});

test('crash between schedule commit and enqueue; restart and concurrent instances deduplicate exactly', () => {
  const r = ready(), d = r.delivery;
  let reopened: WeeklyDelivery | undefined;
  try {
    const committed = d.schedule.tick(); assert.ok(committed.summary); assert.deepEqual(d.outbox(), []);
    reopened = new WeeklyDelivery(r.f.directory, r.f.root, () => due);
    const first = reopened.recoverLatest(); assert.equal(first.status, 'enqueued'); assert.ok(first.entry);
    const exact = serialize(first.entry);
    assert.equal(d.tick().schedule.status, 'not-due'); assert.equal(d.recoverLatest().status, 'existing');
    assert.equal(serialize(d.outbox()[0]), exact);
    assert.equal(first.entry.envelope.body, serialize(committed.summary));
    assert.equal(first.entry.envelope.summaryDigest, committed.summary.digest);
    assert.equal(d.outbox().length, 1);
    r.advance(); assert.equal(d.tick().schedule.status, 'committed'); assert.equal(d.outbox().length, 2);
    const page = d.outbox({ limit: 1 }); assert.equal(page.length, 1);
    assert.equal(d.outbox({ after: page[0]!.envelope.id, limit: 1 }).length, 1);
    assert.equal(d.outbox({ after: d.outbox()[1]!.envelope.id }).length, 0);
  } finally { reopened?.close(); r.dispose(); }
});

test('recipient-specific identities and project/workspace isolation', async () => {
  const r = ready(), d = r.delivery, clone = join(r.f.base, 'clone');
  cpSync(r.f.root, clone, { recursive: true });
  const other = new WeeklyDelivery(r.f.directory, clone, () => due);
  try {
    const a = d.tick().delivery.entry!; d.configure({ ...options, recipient: 'second@example.invalid' });
    const b = d.recoverLatest().entry!; assert.notEqual(a.envelope.id, b.envelope.id); assert.equal(d.outbox().length, 2);
    await assert.rejects(d.dispatch(a.envelope.id, authorization, async () => ({ status: 'accepted', receiptId: 'not-called' })), /mismatch/);
    assert.equal(other.status().status, 'disabled'); assert.deepEqual(other.outbox(), []);
    other.configure(options); other.schedule.configure(); const c = other.tick().delivery.entry!;
    assert.notEqual(c.envelope.id, a.envelope.id); assert.equal(other.outbox().length, 1);
  } finally { other.close(); r.dispose(); }
});

test('explicit adapter requires current consent/destination; accepts immutable bounded envelope once', async () => {
  const r = ready(), d = r.delivery; let calls = 0;
  try {
    const entry = d.tick().delivery.entry!;
    assert.equal((await d.dispatch(entry.envelope.id, authorization)).status, 'pending-configuration');
    assert.equal(d.outbox()[0]!.attempts, 0);
    const adapter: OwnerEmailAdapter = async message => {
      calls++; assert.ok(Object.isFrozen(message)); assert.equal(message.recipient, address);
      assert.throws(() => { (message as { recipient: string }).recipient = 'changed@example.invalid'; });
      assert.equal(d.outbox()[0]?.status, 'uncertain'); // durable before external call
      return { status: 'accepted', receiptId: 'fixture-acceptance-1' };
    };
    const accepted = await d.dispatch(entry.envelope.id, authorization, adapter);
    assert.equal(accepted.status, 'accepted'); assert.equal(accepted.entry?.receiptId, 'fixture-acceptance-1');
    assert.equal(accepted.entry?.serviceId, 'offline-fixture');
    assert.equal((await d.dispatch(entry.envelope.id, authorization, adapter)).status, 'accepted');
    assert.equal(calls, 1); assert.equal(d.tick().delivery.entry?.status, 'accepted');
  } finally { r.dispose(); }
});

test('in-flight competing dispatch cannot replay; callback failure and restart remain uncertain', async () => {
  const r = ready(), d = r.delivery;
  const other = new WeeklyDelivery(r.f.directory, r.f.root, () => due);
  let finish!: (value: AdapterResult) => void;
  try {
    const entry = d.tick().delivery.entry!;
    let calls = 0;
    const pending = d.dispatch(entry.envelope.id, authorization, async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
    assert.equal(other.outbox()[0]?.status, 'uncertain');
    const second = await other.dispatch(entry.envelope.id, authorization, async () => { calls++; return { status: 'accepted', receiptId: 'duplicate' }; });
    assert.equal(second.status, 'uncertain'); assert.equal(calls, 1);
    finish({ status: 'accepted', receiptId: 'accepted-after-wait' }); assert.equal((await pending).status, 'accepted');
    r.advance(); const next = d.tick().delivery.entry!;
    const unknown = await d.dispatch(next.envelope.id, authorization, async () => { throw new Error('transport interrupted'); });
    assert.equal(unknown.status, 'uncertain'); assert.equal(unknown.reason, 'adapter-result-unknown');
    other.close();
    const reopened = new WeeklyDelivery(r.f.directory, r.f.root, () => due + week);
    try {
      assert.equal((await reopened.dispatch(next.envelope.id, authorization, async () => { calls++; return { status: 'not-accepted' }; })).status, 'uncertain');
      assert.equal(calls, 1);
    } finally { reopened.close(); }
  } finally { other.close(); r.dispose(); }
});

test('definitive not-accepted returns pending; invalid responses conservatively stay uncertain', async () => {
  const r = ready(), d = r.delivery; let touched = false;
  try {
    const entry = d.tick().delivery.entry!;
    assert.equal((await d.dispatch(entry.envelope.id, authorization, async () => ({ status: 'not-accepted' }))).status, 'pending');
    assert.equal(d.outbox()[0]?.attempts, 1);
    const response = Object.defineProperty({}, 'status', { enumerable: true, get() { touched = true; return 'accepted'; } });
    const invalid = await d.dispatch(entry.envelope.id, authorization, async () => response as AdapterResult);
    assert.equal(invalid.status, 'uncertain'); assert.equal(touched, false);
    assert.equal(d.outbox()[0]?.attempts, 2);
  } finally { r.dispose(); }
});

test('disable retains preview; prevents new tick and callback; reenable preserves deduplication', async () => {
  const r = ready(), d = r.delivery; let calls = 0;
  try {
    const entry = d.tick().delivery.entry!; d.configure({ ...options, enabled: false }); r.advance();
    assert.equal(d.tick().schedule.status, 'disabled'); assert.equal(d.outbox().length, 1);
    assert.equal((await d.dispatch(entry.envelope.id, authorization, async () => { calls++; return { status: 'not-accepted' }; })).status, 'disabled');
    d.configure(options); d.schedule.disable();
    assert.equal((await d.dispatch(entry.envelope.id, authorization, async () => { calls++; return { status: 'not-accepted' }; })).status, 'disabled');
    assert.equal(calls, 0); assert.equal(d.outbox().length, 1);
    d.schedule.configure(); assert.equal(d.recoverLatest().status, 'existing');
  } finally { r.dispose(); }
});

test('header injection, unknown fields, getters, proxies and inconsistent consent reject', () => {
  const r = ready(), d = r.delivery; let touched = false;
  try {
    for (const value of ['a@example.invalid\r\nBcc: b@evil.invalid', 'Name <a@example.invalid>', 'a@@example.invalid',
      'a@Example.invalid', '.a@example.invalid', 'a..b@example.invalid', 'a@-bad.invalid', 'a@bad..invalid']) assert.throws(() => recipient(value));
    assert.throws(() => d.configure({ ...options, extra: true } as typeof options));
    assert.throws(() => d.configure({ ...options, consent: false }));
    const getter = Object.defineProperty({ ...options }, 'recipient', { enumerable: true, get() { touched = true; return address; } });
    assert.throws(() => d.configure(getter)); assert.equal(touched, false);
    assert.throws(() => d.configure(new Proxy(options, {}))); // structuredClone rejects proxies
    assert.throws(() => d.outbox({ limit: 101 })); assert.throws(() => d.outbox({ after: '../' }));
    assert.throws(() => d.configure({ ...options, maxBytes: 98305 }));
  } finally { r.dispose(); }
});

test('byte budget failure retains committed schedule and no partial entry; increase then recover', () => {
  const r = ready(), d = r.delivery;
  try {
    d.configure({ ...options, maxBytes: 1024 });
    assert.throws(() => d.tick(), /byte limit/);
    assert.equal(d.schedule.status().lastCompletedDue, due); assert.deepEqual(d.outbox(), []);
    d.configure(options); // configure preserves prior budget
    d.configure({ ...options, maxBytes: 98304 });
    assert.equal(d.recoverLatest().status, 'enqueued'); assert.equal(d.outbox().length, 1);
    assert.equal(d.schedule.tick().status, 'not-due');
  } finally { r.dispose(); }
});

test('owner transaction contention leaves no partial entry; malformed config/outbox fail closed', () => {
  const r = ready(), d = r.delivery, store = d.schedule.store;
  const lock = new DatabaseSync(store.database.path);
  try {
    d.schedule.tick(); lock.exec('BEGIN IMMEDIATE');
    try { assert.throws(() => d.recoverLatest(), /locked|busy/i); } finally { lock.exec('ROLLBACK'); }
    assert.deepEqual(d.outbox(), []); const entry = d.recoverLatest().entry!;
    store.put('weekly-email:' + entry.envelope.id, { ...entry, attempts: 1 });
    assert.throws(() => d.outbox(), /service binding/);
    store.put('weekly-email:' + entry.envelope.id, { ...entry, extra: true });
    assert.throws(() => d.outbox());
    store.put('weekly-email:' + entry.envelope.id, entry);
    store.put('weekly-email:' + entry.envelope.id, { ...entry, envelope: { ...entry.envelope, subject: 'injected' } });
    assert.throws(() => d.outbox(), /content/);
    store.put('weekly-email:' + entry.envelope.id, entry);
    store.put('weekly-email-config', null); assert.throws(() => d.status());
  } finally { lock.close(); r.dispose(); }
});

test('private canonical external state, symlinks, hardlinks and permissions enforced by owner store', () => {
  const r = ready(), d = r.delivery;
  try {
    assert.throws(() => new WeeklyDelivery(join(r.f.root, 'state'), r.f.root), /external/);
    if (process.platform !== 'win32') {
      const alias = join(r.f.base, 'alias'); symlinkSync(r.f.directory, alias);
      assert.throws(() => new WeeklyDelivery(alias, r.f.root), /canonical/);
    }
    const linked = join(r.f.base, 'linked.sqlite'); linkSync(d.schedule.store.database.path, linked);
    assert.throws(() => d.status(), /unsafe/); rmSync(linked);
    if (typeof process.getuid === 'function') {
      const publicState = join(r.f.base, 'public-state'); mkdirSync(publicState, { mode: 0o755 }); chmodSync(publicState, 0o755);
      assert.throws(() => new WeeklyDelivery(publicState, r.f.root), /private/);
      chmodSync(d.schedule.store.database.path, 0o644);
      assert.throws(() => d.outbox(), /private/); chmodSync(d.schedule.store.database.path, 0o600);
    }
  } finally { r.dispose(); }
});

test('schedule disable between status validation and transactional claim refuses callback/recovery', async () => {
  const r = ready(), d = r.delivery; let calls = 0;
  try {
    const entry = d.tick().delivery.entry!;
    const original = d.schedule.status.bind(d.schedule);
    d.schedule.status = () => { const status = original(); d.schedule.disable(); return status; };
    await assert.rejects(d.dispatch(entry.envelope.id, authorization, async () => {
      calls++; return { status: 'accepted', receiptId: 'must-not-send' };
    }), /schedule changed/);
    assert.equal(calls, 0); assert.equal(d.outbox()[0]?.status, 'pending'); assert.equal(d.outbox()[0]?.attempts, 0);
    d.schedule.status = original; d.schedule.configure();
    d.schedule.status = () => { const status = original(); d.schedule.disable(); return status; };
    assert.throws(() => d.recoverLatest(), /schedule changed/);
    assert.equal(d.outbox().length, 1);
  } finally { r.dispose(); }
});

test('forty real scheduled weeks above 1 MiB return immutable bounded ordered pages without omissions', () => {
  const f = fixture(); let now = due - 1;
  const d = new WeeklyDelivery(f.directory, f.root, () => now);
  const history = new RunHistory(f.directory, f.root, () => now);
  const source = digest('source'), candidate = digest('candidate');
  const paths = Array.from({ length: 80 }, (_, i) => 'src/' + String(i).padStart(3, '0') + 'abcdefghijklmnop.ts');
  const entries: OutboxEntry[] = [];
  try {
    d.schedule.configure({ maxBytes: 65536 }); d.configure(options);
    for (let w = 0; w < 40; w++) {
      for (let r = 0; r < 8; r++) {
        const n = w * 8 + r + 1;
        history.record({ schemaVersion: 1, runId: digest('run-' + n), taskId: 'task-' + n,
          execution: 'authenticated', startedAt: 10, endedAt: 20, outcome: 'completed', lastPhase: 'terminal',
          baselineSource: source, candidateSource: candidate, changedPaths: paths,
          checks: [
            { phase: 'baseline', id: 'baseline', outcome: 'passed', exitCode: 0, source, evidenceSha256: digest('baseline') },
            { phase: 'candidate', id: 'candidate', outcome: 'passed', exitCode: 0, source: candidate, evidenceSha256: digest('candidate') }
          ], review: { outcome: 'pass', source: candidate, evidenceSha256: digest('review') },
          terminalReceiptSha256: digest('receipt') });
      }
      now = due + w * week;
      const tick = d.tick(); assert.equal(tick.schedule.status, 'committed'); assert.ok(tick.delivery.entry);
      entries.push(tick.delivery.entry);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(entries)) > 1024 * 1024);
    const expected = entries.map(entry => entry.envelope.id).sort();
    const all = d.outbox({ limit: 100 });
    assert.equal(all.length, 40); assert.ok(Object.isFrozen(all));
    assert.deepEqual(all.map(entry => entry.envelope.id), expected);
    assert.throws(() => { (all as OutboxEntry[]).pop(); }, TypeError);
    for (const entry of all) {
      assert.ok(Object.isFrozen(entry)); assert.ok(Object.isFrozen(entry.envelope));
      assert.ok(Buffer.byteLength(serialize(entry.envelope)) <= 98304);
      assert.ok(Buffer.byteLength(entry.envelope.body) <= 65536);
      assert.equal(Reflect.set(entry, 'status', 'accepted'), false);
      assert.equal(Reflect.set(entry.envelope, 'body', 'changed'), false);
      assert.equal(entry.status, 'pending'); assert.equal(entry.attempts, 0);
    }
    assert.equal(d.outbox().length, 20); assert.equal(d.outbox({ limit: 1 }).length, 1);
    const seen: string[] = []; const sizes: number[] = []; let after: string | undefined;
    for (;;) {
      const page = d.outbox({ limit: 17, ...(after === undefined ? {} : { after }) });
      assert.ok(Object.isFrozen(page)); sizes.push(page.length);
      if (!page.length) break;
      seen.push(...page.map(entry => entry.envelope.id)); after = page.at(-1)!.envelope.id;
    }
    assert.deepEqual(sizes, [17, 17, 6, 0]); assert.deepEqual(seen, expected); assert.equal(new Set(seen).size, 40);
    const again = d.outbox({ limit: 100 }); assert.deepEqual(again, all);
    assert.notEqual(again, all);
    for (let i = 0; i < all.length; i++) {
      assert.notEqual(again[i], all[i]); assert.notEqual(again[i]!.envelope, all[i]!.envelope);
    }
    for (const limit of [0, 101]) assert.throws(() => d.outbox({ limit }));
  } finally { history.close(); d.close(); f.dispose(); }
});

test('outbox caps a page at 100 and continues to the remaining entry', () => {
  const r = ready(), d = r.delivery;
  try {
    const expected: string[] = [];
    for (let i = 0; i < 101; i++) { expected.push(d.tick().delivery.entry!.envelope.id); r.advance(); }
    const page = d.outbox({ limit: 100 }); assert.equal(page.length, 100); assert.ok(Object.isFrozen(page));
    const rest = d.outbox({ limit: 100, after: page.at(-1)!.envelope.id }); assert.equal(rest.length, 1);
    assert.deepEqual([...page, ...rest].map(entry => entry.envelope.id), expected.sort());
    const end = d.outbox({ after: rest[0]!.envelope.id, limit: 100 });
    assert.deepEqual(end, []); assert.ok(Object.isFrozen(end));
  } finally { r.dispose(); }
});
