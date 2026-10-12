import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeCodexModel, startBroker } from '../../src/live-workflow/provider.js';
import { RunAuthority } from '../../src/live-workflow/authority.js';
import { task as parseTask, sha256 } from '../../src/live-workflow/validation.js';
import type { ActionEnvelope, LiveTask } from '../../src/live-workflow/contracts.js';
import { fixtureResponse } from './native-fixture.js';

const source = 'a'.repeat(64), MiB = 1024 * 1024;
const base: LiveTask = { schemaVersion: 1, taskId: 'response-budget-fixture', objective: 'fixture',
  readPaths: ['file'], writePaths: ['file'], checks: [{ id: 'fixture', executable: '/usr/bin/true', args: [], timeoutMs: 1000 }],
  model: 'fixture', effort: 'low', maxModelRequests: 1, maxPromptBytes: 20000,
  maxOutputBytes: 2 * MiB, maxRuntimeMs: 10000, draftPr: false };
const frame = (event: unknown) => Buffer.from('data: ' + JSON.stringify(event) + '\n\n');
const completed = frame({ type: 'response.completed', response: { status: 'completed', model: base.model, output: [] } });
const largeWire = Buffer.concat([Buffer.from((': neutral ' + 'x'.repeat(1010) + '\n\n').repeat(2100)), completed]);

async function fixture(task: LiveTask, wire: Buffer, mutate?: () => void, chunks?: Uint8Array[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-response-budget-'))), workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const authority = new RunAuthority(join(root, 'state'), workspace, 'fixture', task, source);
  let calls = 0, credentials = 0, payload = '';
  const broker = await startBroker({ task, source: () => source, authority, signal: AbortSignal.timeout(10000),
    credentials: () => { credentials++; return { accessToken: 'fixture', accountId: 'fixture' }; },
    transport: async (_url, init) => {
      calls++; payload = String(init?.body);
      return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
        try {
          if (chunks) { for (const chunk of chunks) { controller.enqueue(chunk); await delay(30); } }
          else for (let i = 0; i < wire.length; i += 16384) controller.enqueue(wire.subarray(i, i + 16384));
          controller.close();
        } catch {} // Intentional byte denial can cancel the synthetic producer.
      } }));
    } });
  try {
    mutate?.();
    let delivered = '';
    try { delivered = await (await fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { method: 'POST',
      headers: { authorization: 'Bearer ' + broker.token }, body: JSON.stringify({ model: base.model, input: [], stream: true }) })).text(); }
    catch {} // Over-limit streams intentionally destroy the loopback response.
    let failure: string | undefined;
    try { broker.assertSuccess(); } catch (error) { failure = (error as Error).message; }
    const ledger = authority.export() as { run: { requests: number; input_bytes: number }; receipts: {
      event: string; outcome: string; sourceSnapshot: string; requestId?: string; requestDigest?: string;
      resource?: string; grantId?: string; invocationId?: string }[] };
    assert.equal(calls, 1); assert.equal(credentials, 1); assert.equal(ledger.run.requests, 1);
    assert.equal(ledger.run.input_bytes, Buffer.byteLength(payload));
    const decided = ledger.receipts.filter(r => r.event === 'external.decided');
    const finished = ledger.receipts.filter(r => r.event === 'external.finished');
    assert.equal(decided.length, 1); assert.equal(finished.length, 1);
    assert.equal(finished[0]!.outcome, failure ? 'indeterminate' : 'completed');
    assert.equal(finished[0]!.sourceSnapshot, source);
    for (const key of ['requestId', 'requestDigest', 'resource', 'grantId', 'invocationId'] as const)
      assert.equal(finished[0]![key], decided[0]![key]);
    const db = new DatabaseSync(join(authority.directory, 'policy/policy.sqlite'), { readOnly: true });
    try {
      const attempt = JSON.parse(db.prepare('SELECT body FROM external_attempts').get()!.body as string);
      const envelope = JSON.parse(attempt.envelopeJson) as ActionEnvelope;
      assert.equal(attempt.intent.resource, 'host:' + sha256(attempt.envelopeJson));
      return { failure, delivered, detail: envelope.detail as Record<string, unknown> };
    } finally { db.close(); }
  } finally { await broker.close(); authority.close(); rmSync(root, { recursive: true, force: true }); }
}

test('task parsing keeps legacy JSON exact and binds the explicit raw allowance to cloned task data', () => {
  const legacy = parseTask(base); assert.equal(JSON.stringify(legacy), JSON.stringify(base));
  assert.equal(Object.hasOwn(legacy, 'maxProviderResponseBytes'), false);
  const input = { ...structuredClone(base), maxProviderResponseBytes: 8 * MiB }, parsed = parseTask(input);
  assert.deepEqual(parsed, input); assert.notEqual(sha256(JSON.stringify(parsed)), sha256(JSON.stringify(legacy)));
  input.maxProviderResponseBytes = MiB; input.checks[0] = { ...input.checks[0]!, id: 'changed' };
  assert.equal(parsed.maxProviderResponseBytes, 8 * MiB); assert.equal(parsed.checks[0]!.id, 'fixture');
  assert.equal(parseTask({ ...base, maxProviderResponseBytes: 32 * MiB }).maxProviderResponseBytes, 32 * MiB);
  assert.throws(() => parseTask({ ...base, maxOutputBytes: 2 * MiB + 1 }), /Invalid bound/);
});

test('invalid present raw allowances fail before authority, credentials, HTTP, or native preparation', async () => {
  let effects = 0;
  const authority = { reserve: () => { effects++; throw Error('unexpected'); }, reserveRequest: () => { effects++; return 1; } };
  const credentials = () => { effects++; return { accessToken: 'fixture', accountId: 'fixture' }; };
  const transport: typeof fetch = async () => { effects++; throw Error('unexpected'); };
  for (const value of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, 32 * MiB + 1, '8388608']) {
    const task = { ...base, maxProviderResponseBytes: value } as unknown as LiveTask;
    assert.throws(() => parseTask(task), /Invalid bound/);
    await assert.rejects(startBroker({ task, source: () => source, authority, credentials, transport,
      signal: AbortSignal.timeout(1000) }), /Invalid bound/);
    const native = new NativeCodexModel({ task, executable: '/nonexistent-fixture', source: () => source,
      authority: authority as unknown as RunAuthority, credentials, transport });
    await assert.rejects(native.complete('fixture', {}, {}, AbortSignal.timeout(1000)), /Invalid bound/);
  }
  for (const task of [Object.create({ maxProviderResponseBytes: 8 * MiB }, Object.getOwnPropertyDescriptors(base)),
    Object.defineProperty({ ...base }, 'maxProviderResponseBytes', { get() { effects++; return 8 * MiB; } })]) {
    await assert.rejects(startBroker({ task, source: () => source, authority, credentials, transport,
      signal: AbortSignal.timeout(1000) }), /Invalid response budget/);
  }
  assert.equal(effects, 0);
});

test('byte-identical neutral SSE over 2 MiB fails legacy cap and passes explicit 8 MiB with tiny result', async () => {
  assert.ok(largeWire.length > base.maxOutputBytes);
  assert.equal(sha256(largeWire), '90587fa727239dfffd54b429e7843eb6423872391dac62228f94c1bc804e7a0d');
  const legacy = await fixture({ ...base }, largeWire);
  assert.equal(legacy.failure, 'Provider response byte limit');
  assert.equal(legacy.detail.maxResponseBytes, base.maxOutputBytes);
  const explicit = await fixture({ ...base, maxProviderResponseBytes: 8 * MiB }, largeWire);
  assert.equal(explicit.failure, undefined); assert.equal(explicit.delivered, largeWire.toString());
  assert.equal(explicit.detail.maxResponseBytes, 8 * MiB);
  assert.equal(explicit.detail.maxGeneratedOutputBytes, base.maxOutputBytes);
});

test('raw cap is exact in bytes for split Unicode, cap plus one is indeterminate without retry', async () => {
  const wire = Buffer.concat([frame({ type: 'response.output_text.delta', delta: 'é😀' }), completed]);
  const split = wire.indexOf(Buffer.from('😀'));
  const chunks = [wire.subarray(0, split + 1), wire.subarray(split + 1, split + 3), wire.subarray(split + 3)];
  const exact = await fixture({ ...base, maxOutputBytes: 128, maxProviderResponseBytes: wire.length }, wire, undefined, chunks);
  assert.equal(exact.failure, undefined); assert.equal(exact.delivered, wire.toString());
  const denied = await fixture({ ...base, maxOutputBytes: 128, maxProviderResponseBytes: wire.length - 1 }, wire, undefined, chunks);
  assert.equal(denied.failure, 'Provider response byte limit');
});

test('broker freezes raw and generated limits and routing against subsequent direct task mutation', async () => {
  for (const initialLimit of [largeWire.length - 1, largeWire.length]) {
    const task = { ...base, maxProviderResponseBytes: initialLimit };
    const result = await fixture(task, largeWire, () => {
      task.maxProviderResponseBytes = initialLimit === largeWire.length ? 1 : 32 * MiB;
      task.maxOutputBytes = 1; task.model = 'changed';
    });
    assert.equal(result.failure, initialLimit === largeWire.length ? undefined : 'Provider response byte limit');
    assert.equal(result.detail.maxResponseBytes, initialLimit);
    assert.equal(result.detail.maxGeneratedOutputBytes, base.maxOutputBytes);
    assert.equal(result.detail.model, base.model);
  }
});

const binary = join(homedir(), '.local/bin/codex');
test('native raw allowance does not expand generated process output or permit an oversized answer',
  { skip: process.platform !== 'darwin' || !existsSync(binary), timeout: 65000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-native-output-cap-'))), workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const task: LiveTask = { ...base, model: 'gpt-6.1-sol', maxPromptBytes: 262144,
      maxOutputBytes: 4096, maxProviderResponseBytes: 8 * MiB, maxRuntimeMs: 60000 };
    const authority = new RunAuthority(join(root, 'state'), workspace, 'fixture', task, source);
    let calls = 0;
    const model = new NativeCodexModel({ executable: realpathSync(binary), task, authority, source: () => source,
      credentials: () => ({ accessToken: 'fixture', accountId: 'fixture' }), transport: async () => {
        calls++; return fixtureResponse(task.model, { text: 'x'.repeat(20000) });
      } });
    try {
      await assert.rejects(model.complete('Return JSON', {}, { type: 'object', required: ['text'], additionalProperties: false,
        properties: { text: { type: 'string' } } }, AbortSignal.timeout(60000)), { message: /^(?:output-limit|Output limit)$/ });
      assert.equal(calls, 1);
      const ledger = authority.export() as { run: { requests: number }; receipts: { event: string; outcome: string }[] };
      assert.equal(ledger.run.requests, 1);
      assert.ok(ledger.receipts.some(r => r.event === 'external.finished' && r.outcome === 'indeterminate'));
    } finally { authority.close(); rmSync(root, { recursive: true, force: true }); }
  });
