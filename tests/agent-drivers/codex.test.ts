import assert from 'node:assert/strict';
import { test } from 'node:test';
import { driverFixture } from './fixture.js';
import { digest, serialize } from '../../src/context-engine/validation.js';

test('Codex driver frames pass-through context, verifies effective configuration and receipts a completed turn', async () => {
  const f = driverFixture(); const original = structuredClone(f.packet);
  const result = await f.driver.run(f.packet);
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'Diagnosed E42');
  assert.equal(result.outputDigest, digest(result.output)); assert.equal(f.stops, 1);
  assert.deepEqual(f.packet, original); assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(result.receipts.slice(-2), ['fixture-start', 'fixture-terminal']);
  const thread = f.server.sent.find(r => r.method === 'thread/start')!.params as Record<string, unknown>;
  assert.equal(thread.developerInstructions, serialize(original.protected)); assert.equal(thread.ephemeral, true);
  assert.equal(thread.sandbox, 'read-only'); assert.equal(thread.approvalPolicy, 'never');
  const turn = f.server.sent.find(r => r.method === 'turn/start')!.params as { input: { text: string }[] };
  const view = JSON.parse(turn.input[0]!.text);
  assert.deepEqual(view.protected, original.protected); assert.equal(view.evidence[0].content, original.evidence[0]!.content);
  assert.equal(digest(turn.input[0]!.text), f.opens[0]!.viewDigest);
  assert.equal(JSON.stringify(result).includes('private reasoning'), false);
  assert.equal(f.terminals[0]?.status, 'completed');
});

test('events received before turn acknowledgement are reconciled without duplicate message output', async () => {
  const f = driverFixture({ early: true }); const result = await f.driver.run(f.packet);
  assert.equal(result.output, 'Diagnosed E42'); assert.equal(result.events.filter(e => e.type === 'message').length, 1);
});

test('denied host startup sends no RPC or context', async () => {
  const f = driverFixture({ denied: true }); await assert.rejects(f.driver.run(f.packet), /denied/);
  assert.equal(f.server.sent.length, 0); assert.equal(f.opens.length, 0); f.server.close();
});

test('effective model, effort, workspace, version, sandbox, instructions and billing-tier mismatches block turn/start', async () => {
  const cases: ((r: Record<string, unknown>) => void)[] = [
    r => { r.model = 'different'; }, r => { r.reasoningEffort = 'low'; }, r => { r.cwd = '/outside'; },
    r => { (r.thread as Record<string, unknown>).cliVersion = 'newer'; }, r => { (r.thread as Record<string, unknown>).ephemeral = false; },
    r => { r.sandbox = { type: 'workspaceWrite', networkAccess: false }; }, r => { r.sandbox = { type: 'readOnly', networkAccess: true }; },
    r => { r.approvalPolicy = 'on-request'; }, r => { r.approvalsReviewer = 'auto_review'; },
    r => { r.instructionSources = ['/ambient/AGENTS.md']; }, r => { r.serviceTier = 'fast'; },
  ];
  for (const mutateThread of cases) {
    const f = driverFixture({ mutateThread }); await assert.rejects(f.driver.run(f.packet), /denied/);
    assert.equal(f.server.sent.some(r => r.method === 'turn/start'), false); assert.equal(f.stops, 1);
  }
});

test('unexpected MCP inventory or incomplete inventory blocks inference', async () => {
  for (const data of [{ data: [{ name: 'ambient' }], nextCursor: null }, { data: [], nextCursor: 'more' }]) {
    const f = driverFixture({ onRequest(r, s) {
      if (r.method !== 'mcpServerStatus/list') return false; s.receive({ id: r.id, result: data }); return true;
    } });
    await assert.rejects(f.driver.run(f.packet), /denied/); assert.equal(f.server.sent.some(r => r.method === 'turn/start'), false);
  }
});

test('revocation after thread creation prevents sending any task context', async () => {
  let f: ReturnType<typeof driverFixture>;
  f = driverFixture({ afterCheck(n) { if (n === 3) f.revoke(); } });
  await assert.rejects(f.driver.run(f.packet), /denied/);
  assert.equal(f.server.sent.some(r => r.method === 'turn/start'), false); assert.equal(f.terminals[0]?.status, 'denied');
});

test('failed and interrupted server turns are never successful and disclose no partial output', async () => {
  for (const terminalStatus of ['failed', 'interrupted'] as const) {
    const f = driverFixture({ terminalStatus }); const result = await f.driver.run(f.packet);
    assert.equal(result.status, terminalStatus); assert.equal(result.output, ''); assert.equal(f.terminals[0]?.status, terminalStatus);
  }
});

test('every approval/tool/unknown callback is denied and terminates the invocation', async () => {
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
    'execCommandApproval', 'applyPatchApproval', 'mcpServer/elicitation/request', 'item/tool/call', 'tool/requestUserInput', 'unknown/request']) {
    const f = driverFixture({ onRequest(r, s) {
      if (r.method !== 'turn/start') return false;
      s.receive({ id: r.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
      queueMicrotask(() => s.receive({ id: 'server-request', method, params: { threadId: 'thread-1', turnId: 'turn-1' } }));
      return true;
    } });
    await assert.rejects(f.driver.run(f.packet), /denied/);
    const reply = f.server.sent.find(r => r.id === 'server-request'); assert.ok(reply);
    assert.equal(JSON.stringify(reply).includes('accept'), false); assert.equal(f.terminals[0]?.status, 'denied'); assert.equal(f.stops, 1);
  }
});

test('caller cancellation after turn start interrupts once and reaps the worker', async () => {
  const controller = new AbortController();
  const f = driverFixture({ onRequest(r, s) {
    if (r.method !== 'turn/start') return false;
    s.receive({ id: r.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
    setImmediate(() => controller.abort()); return true;
  } });
  await assert.rejects(f.driver.run(f.packet, controller.signal), /cancelled/);
  assert.equal(f.server.sent.filter(r => r.method === 'turn/interrupt').length, 1);
  assert.equal(f.terminals[0]?.status, 'cancelled'); assert.equal(f.stops, 1);
});

test('cancellation before startup performs zero work', async () => {
  const f = driverFixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.driver.run(f.packet, controller.signal), /cancelled/);
  assert.equal(f.opens.length, 0); f.server.close();
});

test('timeout before turn acknowledgement closes the worker without retrying inference', async () => {
  const f = driverFixture({ maxRuntimeMs: 30, onRequest(r) { return r.method === 'turn/start'; } });
  await assert.rejects(f.driver.run(f.packet), /timed-out/);
  assert.equal(f.server.sent.filter(r => r.method === 'turn/start').length, 1); assert.equal(f.stops, 1);
});

test('wrong-thread or wrong-turn completion cannot complete an invocation', async () => {
  const f = driverFixture({ maxRuntimeMs: 30, onRequest(r, s) {
    if (r.method !== 'turn/start') return false;
    s.receive({ id: r.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
    s.receive({ method: 'turn/completed', params: { threadId: 'foreign', turn: { id: 'turn-1', status: 'completed', items: [] } } });
    s.receive({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'foreign', status: 'completed', items: [] } } });
    return true;
  } });
  await assert.rejects(f.driver.run(f.packet), /timed-out/); assert.notEqual(f.terminals[0]?.status, 'completed');
});

test('output, receipt and cleanup failures never return success', async () => {
  for (const options of [{ maxOutputBytes: 3 }, { finishFails: true }, { stopFails: true }]) {
    const f = driverFixture(options); await assert.rejects(f.driver.run(f.packet), /invalid-input|output-limit|receipt-failed|cleanup-failed/);
    assert.equal(f.stops, 1);
    if (options.stopFails) { assert.equal(f.terminals[0]?.status, 'indeterminate'); await assert.rejects(f.driver.run(f.packet), /busy/); }
  }
});

test('concurrent invocations cannot share a session', async () => {
  const f = driverFixture(); const first = f.driver.run(f.packet);
  await assert.rejects(f.driver.run(f.packet), /busy/); assert.equal((await first).status, 'completed');
});

test('callbacks before initialize acknowledgement and alongside completion block success', async () => {
  for (const early of [true, false]) {
    const f = driverFixture({ onRequest(r, s) {
      if (r.method !== (early ? 'initialize' : 'turn/start')) return false;
      if (!early) {
        s.receive({ id: r.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
        s.receive({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
      }
      s.receive({ id: 'early-callback', method: 'unknown/request', params: {} }); return true;
    } });
    await assert.rejects(f.driver.run(f.packet), /denied/);
    assert.equal(f.terminals[0]?.status, 'denied'); assert.equal(f.stops, 1);
  }
});

test('late-open lease after cancellation is reaped and receives a cancellation receipt', async () => {
  const f = driverFixture({ openDelayMs: 20 }); const controller = new AbortController();
  const running = f.driver.run(f.packet, controller.signal); setTimeout(() => controller.abort(), 5);
  await assert.rejects(running, /cancelled/);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.stops, 1); assert.equal(f.terminals[0]?.status, 'cancelled');
  assert.equal(f.server.sent.length, 0); await assert.rejects(f.driver.run(f.packet), /busy/);
});

test('packet expiry interrupts a pending turn and blocks output', async () => {
  const f = driverFixture({ onRequest(r, s) {
    if (r.method !== 'turn/start') return false;
    s.receive({ id: r.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } }); return true;
  } });
  f.packet.expiresAt = 1020;
  await assert.rejects(f.driver.run(f.packet), /denied/);
  assert.equal(f.terminals[0]?.status, 'denied'); assert.equal(f.stops, 1);
});

test('duplicate terminal notifications and unsupported tool item types fail closed', async () => {
  for (const kind of ['duplicate', 'functionCallOutput', 'imageView', 'futureTool']) {
    const f = driverFixture({ onRequest(r, s) {
      if (r.method !== 'turn/start') return false;
      const turn = { id: 'turn-1', status: 'completed', items: kind === 'duplicate' ? [] : [{ type: kind, id: 'tool-1' }] };
      s.receive({ id: r.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
      s.receive({ method: 'turn/completed', params: { threadId: 'thread-1', turn } });
      if (kind === 'duplicate') s.receive({ method: 'turn/completed', params: { threadId: 'thread-1', turn } });
      return true;
    } });
    await assert.rejects(f.driver.run(f.packet), kind === 'duplicate' ? /protocol-error/ : /denied/);
    assert.notEqual(f.terminals[0]?.status, 'completed');
  }
});
