import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { providerBatches } from '../../src/live-workflow/provider-batches.js';
import { startBroker } from '../../src/live-workflow/provider.js';
import type { LiveTask } from '../../src/live-workflow/contracts.js';
const encoder = new TextEncoder();
const task: LiveTask = { schemaVersion: 1, taskId: 'batch-fixture', objective: 'fixture',
  readPaths: [], writePaths: [], checks: [], model: 'fixture-model', effort: 'low',
  maxModelRequests: 1, maxPromptBytes: 20000, maxOutputBytes: 20000, maxRuntimeMs: 5000, draftPr: false };
function bytes(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({ pull(c) { if (index < parts.length) c.enqueue(parts[index++]!); else c.close(); } });
}
const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
const terminal = frame({ type: 'response.completed', response: { status: 'completed', model: task.model } });
test('queued tiny chunks preserve UTF-8 and SSE bytes with bounded source checks', async () => {
  const text = frame({ type: 'response.output_text.delta', delta: 'नमस्ते 🐻' }) + terminal;
  const raw = encoder.encode(text); let checks = 0;
  const broker = await startBroker({ task, source: () => { checks++; return 'a'.repeat(64); },
    authority: { reserveRequest: () => 1, reserve: () => ({ check() {}, finish() {} }) },
    credentials: () => ({ accessToken: 'fixture', accountId: 'fixture' }), signal: AbortSignal.timeout(5000),
    transport: async () => new Response(bytes(Array.from(raw, byte => Uint8Array.of(byte)))) });
  try { const response = await fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { method: 'POST',
    headers: { authorization: 'Bearer ' + broker.token }, body: JSON.stringify({ model: task.model, input: [], stream: true }) });
    assert.equal(await response.text(), text); broker.assertSuccess(); assert.ok(checks <= 4, String(checks));
  } finally { await broker.close(); }
});
test('drift at terminal gate cannot finish successful inference', async () => {
  let checks = 0; const outcomes: string[] = [];
  const broker = await startBroker({ task, source: () => (++checks < 3 ? 'a' : 'b').repeat(64),
    authority: { reserveRequest: () => 1, reserve: () => ({ check() {}, finish(status) { outcomes.push(status); } }) },
    credentials: () => ({ accessToken: 'fixture', accountId: 'fixture' }), signal: AbortSignal.timeout(5000),
    transport: async () => new Response(terminal) });
  try { const response = await fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { method: 'POST',
    headers: { authorization: 'Bearer ' + broker.token }, body: JSON.stringify({ model: task.model, input: [], stream: true }) }).catch(() => undefined);
    await response?.text().catch(() => undefined); assert.throws(() => broker.assertSuccess(), /Source changed/);
    assert.deepEqual(outcomes, ['indeterminate']);
  } finally { await broker.close(); }
});
test('oversized raw input rejects before delivering bytes', async () => {
  const iterator = providerBatches(bytes([new Uint8Array(101)]), new AbortController().signal, 100);
  await assert.rejects(iterator.next(), /byte limit/);
});
test('large input uses bounded batches and preserves exact bytes', async () => {
  const input = Uint8Array.from({ length: 50000 }, (_, i) => i % 251), output: Uint8Array[] = [];
  for await (const batch of providerBatches(bytes([input]), new AbortController().signal, input.length)) {
    assert.ok(batch.length <= 16384); output.push(batch);
  }
  assert.deepEqual(Buffer.concat(output), Buffer.from(input));
});
test('partial batch flushes while next read stalls and abort cancels it', async () => {
  let cancelled = false; const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode('partial')); }, cancel() { cancelled = true; } });
  const iterator = providerBatches(stream, controller.signal, 100);
  const result = await Promise.race([iterator.next(), delay(1000).then(() => { throw Error('Flush stalled'); })]);
  assert.equal(new TextDecoder().decode(result.value), 'partial');
  const pending = iterator.next(); controller.abort(new Error('fixture-abort'));
  await assert.rejects(pending, /fixture-abort/); assert.equal(cancelled, true);
});
for (const size of [0, 1]) test(`never-ending ${size}-byte chunks yield to cancellation`, { timeout: 3000 }, async () => {
  let cancelled = false; const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(size)); }, cancel() { cancelled = true; } });
  const timer = setTimeout(() => controller.abort(new Error('fixture-stop')), 10);
  try { await assert.rejects(async () => { for await (const _batch of providerBatches(stream, controller.signal, 32 * 1024 * 1024)) {} }, /fixture-stop|Abort/);
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});
test('consumer exit cancels the upstream reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(16384)); }, cancel() { cancelled = true; } });
  for await (const _batch of providerBatches(stream, new AbortController().signal, 20000)) break;
  assert.equal(cancelled, true);
});

for (const gate of ['batch', 'terminal']) test(`policy denial at ${gate} prevents success`, async () => {
  let checks = 0; const outcomes: string[] = [];
  const broker = await startBroker({ task, source: () => 'a'.repeat(64),
    authority: { reserveRequest: () => 1, reserve: () => ({ check() {
      if (++checks === (gate === 'batch' ? 2 : 3)) throw Error('fixture-policy-denied');
    }, finish(status) { outcomes.push(status); } }) },
    credentials: () => ({ accessToken: 'fixture', accountId: 'fixture' }), signal: AbortSignal.timeout(5000),
    transport: async () => new Response(terminal) });
  try { const response = await fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { method: 'POST',
    headers: { authorization: 'Bearer ' + broker.token }, body: JSON.stringify({ model: task.model, input: [], stream: true }) }).catch(() => undefined);
    await response?.text().catch(() => undefined); assert.throws(() => broker.assertSuccess(), /fixture-policy-denied/);
    assert.deepEqual(outcomes, ['indeterminate']);
  } finally { await broker.close(); }
});
test('source drift after downstream drain prevents the next frame', async () => {
  const text = frame({ type: 'response.output_text.delta', delta: 'x'.repeat(50000) }) + terminal;
  const limit = Math.ceil(Buffer.byteLength(text) / 16384) + 2;
  let checks = 0; const outcomes: string[] = [];
  const broker = await startBroker({ task: { ...task, maxOutputBytes: 100000 },
    source: () => (++checks < limit ? 'a' : 'b').repeat(64),
    authority: { reserveRequest: () => 1, reserve: () => ({ check() {}, finish(status) { outcomes.push(status); } }) },
    credentials: () => ({ accessToken: 'fixture', accountId: 'fixture' }), signal: AbortSignal.timeout(5000),
    transport: async () => new Response(text) });
  try { const response = await fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { method: 'POST',
    headers: { authorization: 'Bearer ' + broker.token }, body: JSON.stringify({ model: task.model, input: [], stream: true }) }).catch(() => undefined);
    await response?.text().catch(() => undefined); assert.throws(() => broker.assertSuccess(), /Source changed/);
    assert.equal(checks, limit); assert.deepEqual(outcomes, ['indeterminate']);
  } finally { await broker.close(); }
});
