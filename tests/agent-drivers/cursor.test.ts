import assert from 'node:assert/strict';
import test from 'node:test';
import { realpathSync } from 'node:fs';
import { cursorFixture, configOptions, selection } from './cursor-fixture.js';
import { CursorDriver } from '../../src/agent-drivers/cursor.js';
import { PassThroughContextOptimizer } from '../../src/context-engine/optimizer.js';

const frames = (...messages: object[]) => messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n';
test('Cursor negotiates explicit configuration, preserves canonical packet and reaps before receipt', async () => {
  const f = cursorFixture(); const result = await f.driver.run(f.packet);
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'Diagnosed E42 ✓'); assert.equal(f.stopped, 1);
  assert.equal(f.opens[0]!.driver, 'cursor'); assert.equal(f.opens[0]!.ephemeral, false);
  assert.equal(f.terminals[0]!.outputDigest, result.outputDigest);
  const requests = f.server.sent.filter(r => r.method);
  assert.ok(requests.every(r => r.jsonrpc === '2.0')); assert.ok(!requests.some(r => ['authenticate', 'session/load'].includes(String(r.method))));
  const prompt = (requests.find(r => r.method === 'session/prompt')!.params as { prompt: { text: string }[] }).prompt[0]!.text;
  const view = JSON.parse(prompt); assert.deepEqual(view.protected, f.packet.protected); assert.equal(view.evidence[0].content, f.packet.evidence[0]!.content);
  assert.ok(!JSON.stringify(result).includes('private reasoning')); await assert.rejects(f.driver.run(f.packet), /busy/);
});
test('wrong ACP version is denied before session creation', async () => {
  const f = cursorFixture({ onRequest(r, s) { if (r.method !== 'initialize') return false;
    s.receive({ jsonrpc: '2.0', id: r.id, result: { protocolVersion: 2, agentCapabilities: {}, authMethods: [] } }); return true; } });
  await assert.rejects(f.driver.run(f.packet), /denied/); assert.ok(!f.server.sent.some(r => r.method === 'session/new'));
});
test('missing configuration support prevents prompts', async () => {
  const f = cursorFixture({ onRequest(r, s) { if (r.method !== 'session/new') return false;
    s.receive({ jsonrpc: '2.0', id: r.id, result: { sessionId: 'cursor-session' } }); return true; } });
  await assert.rejects(f.driver.run(f.packet)); assert.ok(!f.server.sent.some(r => r.method === 'session/prompt'));
});
test('post-config response drift in the same chunk cannot be overwritten by an awaited response', async () => {
  const f = cursorFixture({ onRequest(r, s) { if (r.method !== 'session/set_config_option') return false;
    s.incoming.write(frames({ id: r.id, result: { configOptions: configOptions('fixture-model', 'ask') } },
      { method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'config_option_update', configOptions: configOptions('fixture-model', 'agent') } } })); return true; } });
  await assert.rejects(f.driver.run(f.packet)); assert.ok(!f.server.sent.some(r => r.method === 'session/prompt'));
});
test('post-terminal text in the same chunk cannot alter completed output', async () => {
  const f = cursorFixture({ onRequest(r, s) { if (r.method !== 'session/prompt') return false;
    s.incoming.write(frames({ id: r.id, result: { stopReason: 'end_turn' } },
      { method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late output' } } } })); return true; } });
  await assert.rejects(f.driver.run(f.packet), /protocol-error/); assert.equal(f.terminals.at(-1)!.status, 'failed');
});
test('pre-session unsupported updates deny startup', async () => {
  const f = cursorFixture({ onRequest(r, s) { if (r.method !== 'initialize') return false;
    s.incoming.write(frames({ id: r.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } },
      { method: 'session/update', params: { sessionId: 'unregistered', update: { sessionUpdate: 'tool_call', toolCallId: 'bad' } } })); return true; } });
  await assert.rejects(f.driver.run(f.packet), /denied/); assert.ok(!f.server.sent.some(r => r.method === 'session/new'));
});
test('permission IDs are opaque; rejected permission still prevents simultaneous completion', async () => {
  const f = cursorFixture({ onRequest(r, s) { if (r.method !== 'session/prompt') return false;
    s.incoming.write(frames({ id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'cursor-session', options: [
      { optionId: 'allow', kind: 'allow_once' }, { optionId: 'opaque-reject-id', kind: 'reject_once' }] } }, { id: r.id, result: { stopReason: 'end_turn' } })); return true; } });
  await assert.rejects(f.driver.run(f.packet), /denied/);
  const reply = f.server.sent.find(r => r.id === 'permission-1')!.result;
  assert.deepEqual(reply, { outcome: { outcome: 'selected', optionId: 'opaque-reject-id' } }); assert.equal(f.terminals[0]!.status, 'denied');
});
for (const method of ['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'cursor/create_plan', 'cursor/ask_question', 'unknown/method']) {
  test(`unsupported ${method} callback is denied before startup`, async () => {
    const f = cursorFixture({ onRequest(r, s) { if (r.method !== 'initialize') return false;
      s.receive({ jsonrpc: '2.0', id: 'callback', method, params: {} }); return true; } });
    await assert.rejects(f.driver.run(f.packet), /denied/); assert.equal(f.stopped, 1); assert.ok(!f.server.sent.some(r => r.method === 'session/new'));
  });
}
for (const stopReason of ['max_tokens', 'max_turn_requests', 'cancelled']) test(`${stopReason} is interrupted with no released text`, async () => {
  const f = cursorFixture({ stopReason }), result = await f.driver.run(f.packet);
  assert.equal(result.status, 'interrupted'); assert.equal(result.output, '');
});
for (const stopReason of ['refusal', 'invented']) test(`${stopReason} cannot establish success`, async () => {
  const f = cursorFixture({ stopReason }); await assert.rejects(f.driver.run(f.packet)); assert.notEqual(f.terminals[0]!.status, 'completed');
});
test('mode/model drift and native delegation notifications fail closed', async () => {
  for (const event of [
    { method: 'cursor/task', params: {} }, { method: 'cursor/generate_image', params: {} },
    { method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'current_mode_update', currentModeId: 'agent' } } },
    { method: 'session/update', params: { sessionId: 'other-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign' } } } },
  ]) {
    const f = cursorFixture({ onRequest(r, s) { if (r.method !== 'session/prompt') return false; s.receive({ jsonrpc: '2.0', ...event }); return true; } });
    await assert.rejects(f.driver.run(f.packet), /denied/); assert.notEqual(f.terminals[0]!.status, 'completed');
  }
});
test('cancellation notifies ACP and requires cleanup receipt', async () => {
  const controller = new AbortController();
  const f = cursorFixture({ onRequest(r) { if (r.method !== 'session/prompt') return false; controller.abort(); return true; } });
  await assert.rejects(f.driver.run(f.packet, controller.signal), /cancelled/);
  assert.ok(f.server.sent.some(r => r.method === 'session/cancel' && !('id' in r))); assert.equal(f.terminals[0]!.status, 'cancelled');
});
test('output bounds, failed receipts and uncertain cleanup prevent success', async () => {
  for (const options of [{ maxOutputBytes: 4 }, { finishFails: true }, { stopFails: true }]) {
    const f = cursorFixture(options); await assert.rejects(f.driver.run(f.packet)); assert.equal(f.stopped, 1);
    if ('stopFails' in options) assert.equal(f.terminals[0]!.status, 'indeterminate');
  }
});
test('revocation at an awaited boundary blocks prompt', async () => {
  const f = cursorFixture({ afterCheck(count) { if (count === 4) f.revoke(); } });
  await assert.rejects(f.driver.run(f.packet), /denied/); assert.ok(!f.server.sent.some(r => r.method === 'session/prompt'));
});
test('late-open workers are cleaned up after cancellation', async () => {
  const f = cursorFixture({ openDelayMs: 60, maxRuntimeMs: 20 });
  await assert.rejects(f.driver.run(f.packet)); await new Promise(resolve => setTimeout(resolve, 85));
  assert.equal(f.stopped, 1); assert.equal(f.terminals.length, 1); assert.notEqual(f.terminals[0]!.status, 'completed');
});
test('configuration rejects accessors and keeps caller mutation out of launch intent', async () => {
  const f = cursorFixture(); let invoked = false;
  const config = { ...selection, get modelOptionId() { invoked = true; return 'model-choice'; } };
  assert.throws(() => new CursorDriver({ workspaceRoot: realpathSync(process.cwd()), model: 'fixture-model', configuration: config,
    host: f.host, optimizer: new PassThroughContextOptimizer(f.context), maxRuntimeMs: 1000, maxOutputBytes: 65536 }));
  assert.equal(invoked, false);
  const mutable = structuredClone(selection);
  const driver = new CursorDriver({ workspaceRoot: realpathSync(process.cwd()), model: 'fixture-model', configuration: mutable,
    host: f.host, optimizer: new PassThroughContextOptimizer(f.context), maxRuntimeMs: 1000, maxOutputBytes: 65536, clock: f.context.clock });
  mutable.options[0]!.value = 'unauthorized-model';
  assert.equal((await driver.run(f.packet)).status, 'completed');
  assert.equal(f.opens[0]!.model, 'fixture-model');
});
