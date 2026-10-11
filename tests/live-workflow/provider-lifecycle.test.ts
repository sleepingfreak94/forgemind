import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startBroker } from '../../src/live-workflow/provider.js';
import type { LiveTask } from '../../src/live-workflow/contracts.js';

const task: LiveTask = { schemaVersion: 1, taskId: 'disconnect-fixture', objective: 'fixture',
  readPaths: [], writePaths: [], checks: [], model: 'test-model', effort: 'low',
  maxModelRequests: 1, maxPromptBytes: 20000, maxOutputBytes: 20000, maxRuntimeMs: 3000, draftPr: false };
for (const phase of ['headers', 'stream'] as const) test(`worker disconnect cancels upstream during ${phase}`, { timeout: 5000 }, async () => {
  let aborted = false, ready!: () => void;
  const upstreamReady = new Promise<void>(resolve => { ready = resolve; }), outcomes: string[] = [];
  const broker = await startBroker({ task, source: () => 'a'.repeat(64),
    authority: { reserve: () => ({ check() {}, finish(status) { outcomes.push(status); } }), reserveRequest: () => 1 },
    credentials: () => ({ accessToken: 'fixture', accountId: 'fixture' }), signal: AbortSignal.timeout(3000),
    transport: async (_url, init) => {
      const signal = init!.signal!;
      if (phase === 'headers') return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('fixture-aborted')); }, { once: true }); ready();
      });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('fixture-aborted')); }, { once: true });
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n')); ready();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
  const client = new AbortController();
  const request = fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { method: 'POST',
    headers: { authorization: 'Bearer ' + broker.token }, body: JSON.stringify({ model: task.model, input: [], stream: true }), signal: client.signal });
  // Attach a rejection handler before aborting the header-waiting request.
  const settled = request.catch(() => undefined);
  try {
    await upstreamReady;
    if (phase === 'stream') { const response = await request; await response.body!.getReader().read(); }
    client.abort(); await settled;
    for (let i = 0; i < 40 && !aborted; i++) await delay(10);
    assert.equal(aborted, true, 'upstream must cancel without waiting for task expiry or broker.close');
    await delay(10); assert.deepEqual(outcomes, ['indeterminate']);
    assert.throws(() => broker.assertSuccess());
  } finally { client.abort(); await broker.close(); }
});
