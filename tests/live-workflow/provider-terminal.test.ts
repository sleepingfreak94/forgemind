import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from '../../src/live-workflow/provider.js';
import { RunAuthority } from '../../src/live-workflow/authority.js';
import type { LiveTask } from '../../src/live-workflow/contracts.js';
import { setTimeout as delay } from 'node:timers/promises';

const source = 'a'.repeat(64), secret = 'synthetic-private-marker';
const task: LiveTask = { schemaVersion: 1, taskId: 'terminal-fixture', objective: 'fixture', readPaths: [],
  writePaths: [], checks: [], model: 'fixture', effort: 'low', maxModelRequests: 1, maxPromptBytes: 20000,
  maxOutputBytes: 20000, maxRuntimeMs: 5000, draftPr: false };
const frame = (value: unknown, ending = '\n\n') => Buffer.from('data: ' + JSON.stringify(value) + ending);
const completed = frame({ type: 'response.completed', response: { status: 'completed', model: task.model } });

async function fixture(chunks: readonly Uint8Array[], spacingMs = 2) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-terminal-'))), workspace = join(root, 'repo');
  mkdirSync(workspace);
  const authority = new RunAuthority(join(root, 'state'), workspace, 'fixture', task, source);
  let calls = 0, payload = '', delivered = '';
  const broker = await startBroker({ task, source: () => source, authority, signal: AbortSignal.timeout(5000),
    credentials: () => ({ accessToken: 'fixture', accountId: 'fixture' }), transport: async (url, init) => {
      calls++; assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      payload = String(init?.body); assert.equal(init?.redirect, 'error');
      return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
        try { for (const chunk of chunks) { controller.enqueue(chunk); await delay(spacingMs); } controller.close(); }
        catch {} // Broker cancellation may end a denied synthetic stream early.
      } }));
    },
  });
  try {
    try {
      const response = await fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { method: 'POST',
        headers: { authorization: 'Bearer ' + broker.token }, body: JSON.stringify({ model: task.model, input: [], stream: true }) });
      delivered = await response.text();
    } catch {} // A post-header stream denial intentionally destroys the client response.
    let failure: string | undefined;
    try { broker.assertSuccess(); } catch (error) { failure = (error as Error).message; }
    const ledger = authority.export() as { run: { requests: number; input_bytes: number }; receipts: {
      event: string; outcome: string; sourceSnapshot: string; requestId?: string; requestDigest?: string;
      resource?: string; grantId?: string; invocationId?: string; terminalEvidence?: { outputDigest?: string };
    }[] };
    assert.equal(calls, 1); assert.equal(ledger.run.requests, 1);
    assert.equal(ledger.run.input_bytes, Buffer.byteLength(payload));
    const finished = ledger.receipts.filter(receipt => receipt.event === 'external.finished');
    assert.equal(finished.length, 1); assert.equal(finished[0]!.sourceSnapshot, source);
    const decided = ledger.receipts.find(receipt => receipt.event === 'external.decided'); assert.ok(decided);
    for (const key of ['requestId', 'requestDigest', 'resource', 'grantId', 'invocationId'] as const)
      assert.equal(finished[0]![key], decided[key]);
    assert.equal(decided.outcome, 'allow');
    assert.equal(finished[0]!.outcome, failure ? 'indeterminate' : 'completed');
    if (failure) { assert.equal(failure.includes(secret), false); assert.equal(finished[0]!.terminalEvidence?.outputDigest, undefined); }
    return { failure, delivered };
  } finally { await broker.close(); authority.close(); rmSync(root, { recursive: true, force: true }); }
}

for (const reason of ['max_output_tokens', 'content_filter', secret] as const)
  test('explicit incomplete reason is fixed and never complete: ' + (reason === secret ? 'unknown' : reason), async () => {
    const result = await fixture([frame({ type: 'response.incomplete', response: { status: 'incomplete',
      incomplete_details: { reason }, error: { message: secret } }, message: secret })]);
    assert.equal(result.failure, 'Provider response incomplete (reason=' + (reason === secret ? 'unknown' : reason) + ')');
  });

test('missing or malformed incomplete reason never echoes provider data', async () => {
  for (const details of [undefined, { reason: { secret } }, { reason: null }]) {
    const result = await fixture([frame({ type: 'response.incomplete', response: { incomplete_details: details } })]);
    assert.equal(result.failure, 'Provider response incomplete (reason=unknown)');
  }
});

test('JSON parse denial uses fixed code, never raw parser excerpt', async () => {
  for (const data of [secret, '{"value":"' + secret + '" invalid}', '[' + secret]) {
    const result = await fixture([Buffer.from('data: ' + data + '\n\n')]);
    assert.equal(result.failure, 'Provider stream invalid JSON');
  }
});

test('empty EOF without terminal completion is distinct from unfinished frames', async () => {
  assert.equal((await fixture([])).failure, 'Provider stream ended without terminal completion');
  assert.equal((await fixture([frame({ type: 'response.created' })])).failure, 'Provider stream ended without terminal completion');
  assert.equal((await fixture([Buffer.from('data: {')])).failure, 'Provider stream ended with unfinished frame (completed=false)');
  assert.equal((await fixture([completed, Buffer.from('data: {')])).failure, 'Provider stream ended with unfinished frame (completed=true)');
});

test('invalid and truncated UTF-8 always deny, including after completed', async () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe2, 0x82]), Buffer.from([0xc0, 0xaf])])
    for (const prefix of [[], [completed]])
      assert.equal((await fixture([...prefix, bytes])).failure, 'Provider stream invalid UTF-8');
});

test('valid Unicode and CR/LF frames survive splits without rewriting provider data', async () => {
  const created = frame({ type: 'response.output_text.delta', delta: 'é😀' }, '\r\n\r\n');
  const final = frame({ type: 'response.completed', response: { status: 'completed', model: task.model } }, '\r\r');
  const wire = Buffer.concat([created, final]), split = created.indexOf(Buffer.from('😀'));
  const result = await fixture([wire.subarray(0, split + 1), wire.subarray(split + 1, split + 3),
    wire.subarray(split + 3, created.length - 1), wire.subarray(created.length - 1)], 30);
  assert.equal(result.failure, undefined);
  assert.ok(result.delivered.includes('é😀'));
  assert.ok(result.delivered.includes('response.completed'));
  assert.equal(result.delivered.includes('\r'), false);
});
