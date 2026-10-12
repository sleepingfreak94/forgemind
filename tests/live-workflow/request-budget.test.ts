import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from '../../src/live-workflow/provider.js';
import { RunAuthority } from '../../src/live-workflow/authority.js';
import { NATIVE_ENVELOPE_MAX_BYTES, decodeNativeRequest, outboundPromptBytes } from '../../src/live-workflow/request-budget.js';
import type { LiveTask } from '../../src/live-workflow/contracts.js';

const source = 'a'.repeat(64);
const task: LiveTask = {
  schemaVersion: 1, taskId: 'request-budget-test', objective: 'bounded synthetic provider transport',
  readPaths: [], writePaths: [], checks: [], model: 'fixture', effort: 'low',
  maxModelRequests: 1, maxPromptBytes: 4096, maxOutputBytes: 20000, maxRuntimeMs: 5000, draftPr: false,
};
const body = (content = 'evidence', extra: Record<string, unknown> = {}) => ({
  model: task.model, instructions: 'protected', stream: true,
  input: [{ type: 'message', role: 'user', content }], ...extra,
});
const completion = () => new Response('data: ' + JSON.stringify({
  type: 'response.completed', response: { status: 'completed', model: task.model },
}) + '\n\n');

async function request(raw: Uint8Array, maximum = task.maxPromptBytes, encoding?: string) {
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-request-budget-')));
  mkdirSync(join(state, 'workspace'));
  const authority = new RunAuthority(join(state, 'ledger'), join(state, 'workspace'), 'fixture',
    { ...task, maxPromptBytes: maximum }, source);
  const initialReceiptCount = (authority.export() as { receipts: unknown[] }).receipts.length;
  let calls = 0, credentials = 0, payload = '';
  const broker = await startBroker({ task: { ...task, maxPromptBytes: maximum }, source: () => source, authority,
    signal: AbortSignal.timeout(5000), credentials: () => { credentials++; return { accessToken: 'fixture', accountId: 'fixture' }; },
    transport: async (url, init) => {
      calls++; assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(init?.redirect, 'error'); payload = String(init?.body);
      const ledger = authority.export() as { run: { requests: number; input_bytes: number } };
      assert.equal(ledger.run.requests, 1); assert.equal(ledger.run.input_bytes, Buffer.byteLength(payload));
      return completion();
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { method: 'POST',
      headers: { authorization: 'Bearer ' + broker.token, ...(encoding ? { 'content-encoding': encoding } : {}) },
      body: Buffer.from(raw),
    });
    const responseText = await response.text();
    const ledger = authority.export() as { run: { requests: number; input_bytes: number }; receipts: unknown[] };
    if (response.status === 200) broker.assertSuccess();
    else assert.throws(() => broker.assertSuccess());
    return { status: response.status, responseText, calls, credentials, payload, ledger, initialReceiptCount };
  } finally { await broker.close(); authority.close(); rmSync(state, { recursive: true, force: true }); }
}

test('native wire overhead is bounded separately; only sanitized bytes reserve real authority', async () => {
  const raw = Buffer.from(JSON.stringify(body('evidence', {
    tools: [{ type: 'function', name: 'unavailable', description: 'x'.repeat(10000) }],
    additional_tools: [{ name: 'unavailable' }],
    input: [{ type: 'additional_tools', tools: [{ name: 'unavailable', description: 'x'.repeat(10000) }] },
      { type: 'message', role: 'user', content: 'evidence' }],
    paid_fallback: true,
  })));
  assert.ok(raw.length > task.maxPromptBytes);
  const result = await request(raw);
  assert.equal(result.status, 200); assert.equal(result.calls, 1);
  const forwarded = JSON.parse(result.payload);
  assert.deepEqual(forwarded.tools, []); assert.equal(forwarded.tool_choice, 'none');
  assert.equal(forwarded.parallel_tool_calls, false); assert.equal(forwarded.service_tier, 'default');
  assert.equal(forwarded.store, false); assert.deepEqual(forwarded.reasoning, { effort: task.effort });
  assert.equal(forwarded.additional_tools, undefined); assert.equal(forwarded.paid_fallback, undefined);
  assert.deepEqual(forwarded.input, [{ type: 'message', role: 'user', content: 'evidence' }]);
  assert.equal(result.ledger.run.requests, 1); assert.equal(result.ledger.run.input_bytes, Buffer.byteLength(result.payload));
});

test('full serialized schema and Unicode payload use exact byte cap before authority or credentials', async () => {
  const raw = Buffer.from(JSON.stringify(body('é😀', { text: { format: { type: 'json_schema', schema: {
    type: 'object', properties: { value: { type: 'string', description: 'evidence' } }, additionalProperties: false,
  } } } })));
  const accepted = await request(raw);
  const exact = Buffer.byteLength(accepted.payload);
  assert.ok(exact > accepted.payload.length);
  const edge = await request(raw, exact);
  assert.equal(edge.status, 200); assert.equal(edge.ledger.run.input_bytes, exact);
  const denied = await request(raw, exact - 1);
  assert.equal(denied.status, 502); assert.match(denied.responseText, /Provider prompt byte limit/);
  assert.equal(denied.calls, 0); assert.equal(denied.credentials, 0);
  assert.equal(denied.ledger.run.requests, 0); assert.equal(denied.ledger.run.input_bytes, 0);
  assert.equal(denied.ledger.receipts.length, denied.initialReceiptCount);
});

for (const [encoding, compress] of [['gzip', gzipSync], ['zstd', zstdCompressSync]] as const) {
  test(encoding + ' decodes bounded overhead without relaxing sanitized prompt budget', async () => {
    const raw = Buffer.from(JSON.stringify(body('evidence', { tools: [{ description: 'x'.repeat(10000) }] })));
    assert.equal((await request(compress(raw), task.maxPromptBytes, encoding)).status, 200);
    const excessive = Buffer.from(JSON.stringify(body('x'.repeat(task.maxPromptBytes))));
    const result = await request(compress(excessive), task.maxPromptBytes, encoding);
    assert.equal(result.status, 502); assert.equal(result.calls, 0); assert.equal(result.ledger.run.requests, 0);
  });
  test(encoding + ' rejects malformed compressed data and decompression bombs before inference', async () => {
    for (const bytes of [Buffer.from('malformed'), compress(Buffer.alloc(NATIVE_ENVELOPE_MAX_BYTES + 1, 120))]) {
      const result = await request(bytes, task.maxPromptBytes, encoding);
      assert.equal(result.status, 502); assert.match(result.responseText, /Invalid or oversized compressed request/);
      assert.equal(result.calls, 0); assert.equal(result.credentials, 0); assert.equal(result.ledger.run.requests, 0);
    }
  });
}

test('transport and decoded envelope hard ceilings reject huge stripped metadata without reserving inference', async () => {
  assert.equal(decodeNativeRequest(Buffer.alloc(NATIVE_ENVELOPE_MAX_BYTES, 120), 'identity').length, NATIVE_ENVELOPE_MAX_BYTES);
  assert.throws(() => decodeNativeRequest(Buffer.alloc(NATIVE_ENVELOPE_MAX_BYTES + 1), undefined), /Prompt transport limit/);
  const raw = Buffer.from(JSON.stringify(body('evidence', { tools: [{ description: 'x'.repeat(NATIVE_ENVELOPE_MAX_BYTES) }] })));
  const result = await request(raw);
  assert.equal(result.status, 502); assert.match(result.responseText, /Prompt transport limit/);
  assert.equal(result.calls, 0); assert.equal(result.ledger.run.requests, 0);
});

test('malformed JSON, invalid UTF-8, unsupported encoding, and tool history fail closed', async () => {
  for (const [raw, encoding] of [
    [Buffer.from('{'), undefined], [Buffer.from([0xff]), undefined],
    [Buffer.from(JSON.stringify(body())), 'br'],
    [Buffer.from(JSON.stringify(body('evidence', { input: [{ type: 'function_call_output', output: 'untrusted' }] }))), undefined],
  ] as const) {
    const result = await request(raw, task.maxPromptBytes, encoding);
    assert.equal(result.status, 502); assert.equal(result.calls, 0); assert.equal(result.ledger.run.requests, 0);
  }
  assert.throws(() => decodeNativeRequest(Buffer.from('{}'), ['gzip']), /Unsupported encoding/);
});

test('outbound cap remains limited to allowed task maximum and measures complete UTF-8', () => {
  assert.equal(outboundPromptBytes('é😀', 6), 6);
  assert.throws(() => outboundPromptBytes('é😀', 5), /Provider prompt byte limit/);
  for (const maximum of [0, -1, 262145, 1.5, NaN])
    assert.throws(() => outboundPromptBytes('x', maximum), /Invalid provider prompt limit/);
  assert.throws(() => outboundPromptBytes('', 1), /Provider prompt byte limit/);
});
