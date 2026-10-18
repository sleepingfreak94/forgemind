import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeExecutor, NativeProviderError } from '../../src/live-workflow/native-executor.js';
import { NativeState } from '../../src/live-workflow/native-executor-state.js';
import { FixtureNativeHost, fixtureStdioRpc } from '../../src/live-workflow/native-executor-host.js';
import { NATIVE_MAX_WIRE_BYTES, validateBudget } from '../../src/live-workflow/native-executor-contracts.js';
import type { NativeBudget, NativeProjectBoundary, NativeTask } from '../../src/live-workflow/native-executor-contracts.js';
import type { ActionAuthority } from '../../src/live-workflow/contracts.js';
import { runNativeTask, validateNativeTask } from '../../src/live-workflow/native-executor-run.js';
import { ChatGPTPlanSession } from '../../src/live-workflow/chatgpt-plan.js';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const message = (id = 'answer', text = 'Review: revise') => ({ type: 'agentMessage', id, text });
const item = (turnId: string, value: unknown, method = 'item/completed') =>
  ({ method, params: { threadId: 'thread', turnId, item: value } });
const terminal = (turnId: string, items: unknown[] = [], status = 'completed') =>
  ({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: turnId, status, items } } });
const remoteError = (turnId: string) => ({ method: 'error', params: {
  threadId: 'thread', turnId, error: { codexErrorInfo: 'unauthorized', message: 'REMOTE_SECRET', additionalDetails: 'REMOTE_SECRET' }, willRetry: false,
} });
type Send = (...frames: unknown[]) => void;
interface Options {
  budget?: Partial<NativeBudget>;
  resumed?: boolean;
  history?: unknown[];
  preack?: boolean;
  frames?: (turnId: string, pass: number) => unknown[];
  reply?: (reply: { id?: number; result?: unknown }, turnId: string, send: Send) => void;
}

/** Real metered JSONL transport with owner-owned in-memory streams. No process,
 * socket, repository command, or other test module participates in this fixture. */
function fixture(options: Options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'native-result-'))), root = join(dir, 'repo');
  mkdirSync(root); writeFileSync(join(root, 'value.txt'), 'before');
  const task: NativeTask = { project: 'fixture', task: 'review', root, source: hash('before'),
    model: 'gpt-6.1-sol', effort: 'medium', readPaths: ['value.txt'], writePaths: ['value.txt'],
    checks: [{ id: 'check', executable: realpathSync(process.execPath), args: [], timeoutMs: 1000 }],
    budget: { runtimeMs: 10000, turns: 4, toolCalls: 8, retries: 0, inputBytes: 10000,
      resultBytes: 10000, wireBytes: 500000, outputBytes: 10000, ...options.budget } };
  const state = new NativeState(join(dir, 'state'), task);
  if (options.resumed) state.update({ thread: 'thread' });
  const input = new PassThrough(), output = new PassThrough();
  let wire = 0, pass = 0, turnId = '', buffer = '', revoked = false, source = task.source;
  const send: Send = (...frames) => {
    const encoded = frames.map(frame => JSON.stringify(frame)).join('\n') + '\n';
    wire += Buffer.byteLength(encoded); input.write(encoded);
  };
  output.on('data', (chunk: Buffer) => {
    wire += chunk.byteLength; buffer += chunk.toString('utf8');
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const request = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      queueMicrotask(() => {
        if (!request.method) { options.reply?.(request, turnId, send); return; }
        const p = request.params ?? {};
        if (request.method === 'initialize' || request.method === 'turn/interrupt') send({ id: request.id, result: {} });
        else if (request.method === 'thread/start' || request.method === 'thread/resume') send({ id: request.id, result: {
          thread: { id: 'thread', cliVersion: '0.162.1', cwd: p.cwd, ephemeral: false, modelProvider: 'openai', turns: options.history ?? [] },
          model: task.model, reasoningEffort: task.effort, modelProvider: 'openai', cwd: p.cwd,
          serviceTier: 'default', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false },
        } });
        else if (request.method === 'turn/start') {
          turnId = 'turn-' + ++pass;
          const ack = { id: request.id, result: { turn: { id: turnId } } };
          const frames = options.frames?.(turnId, pass) ?? [item(turnId, message()), terminal(turnId)];
          send(...(options.preack ? [...frames, ack] : [ack, ...frames]));
        }
      });
    }
  });
  const boundary = () => { if (revoked) throw new Error('Fixture authority revoked'); };
  const authority: ActionAuthority = { reserve: () => ({ check: boundary, finish: () => undefined }) };
  // A typed fake source authority keeps the actual host_apply callback path pure.
  const project: NativeProjectBoundary = { source: () => source, assertCurrent: expected => {
    boundary(); assert.equal(source, expected);
  }, commitAppliedSource: (before, proposal) => {
    assert.equal(before, source); assert.equal(proposal.edits.length, 1);
    const edit = proposal.edits[0]!;
    assert.equal(edit.path, 'value.txt'); assert.equal(edit.beforeSha256, hash('before')); assert.equal(edit.content, 'after');
    writeFileSync(join(root, 'value.txt'), 'after'); source = hash('after');
    return { source, transitionReceiptId: 'fixture-transition' };
  } };
  const host = new FixtureNativeHost(fixtureStdioRpc(input, output), authority, boundary,
    async () => undefined, () => source, async () => ({ passed: true }), project);
  const executor = new NativeExecutor(task, state, host);
  return { dir, task, state, host, executor, send, wire: () => wire, revoke: () => { revoked = true; },
    close: async () => { await executor.close(); state.close(); input.destroy(); output.destroy(); rmSync(dir, { recursive: true, force: true }); } };
}

test('completed item followed by empty terminal items yields frozen source-bound final evidence', async () => {
  const f = fixture();
  let observedPending = false;
  f.host.rpc.onNotification(event => {
    if (event.method === 'item/completed' || event.method === 'turn/completed') {
      assert.equal(f.executor.receipt.finalResult, null); observedPending = true;
    }
  });
  try {
    await f.executor.turn('review');
    const receipt = f.executor.receipt, result = receipt.finalResult;
    assert.ok(result); assert.ok(observedPending); assert.equal(receipt.checkpoint.status, 'ready');
    assert.equal(result.schema, 'native-final-text-v1'); assert.equal(result.trust, 'evidence-only');
    assert.equal(result.source, f.state.value.source); assert.equal(result.turnId, 'turn-1');
    assert.deepEqual(result.messages, [{ id: 'answer', text: 'Review: revise' }]);
    const encoded = JSON.stringify({ schema: result.schema, trust: result.trust, source: result.source, turnId: result.turnId, messages: result.messages });
    assert.equal(result.digest, hash(encoded));
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.messages)); assert.ok(Object.isFrozen(result.messages[0]));
    assert.throws(() => Object.assign(result.messages[0]!, { text: 'forged verdict' }), TypeError);
    assert.throws(() => Object.assign(result.messages, { 1: { id: 'forged', text: 'pass' } }), TypeError);
    assert.equal(f.state.value.counters.outputBytes, Buffer.byteLength('Review: revise'));
    assert.equal(f.state.value.counters.wireBytes, f.wire());
    assert.equal(JSON.stringify(f.state.value).includes('Review: revise'), false);
    await f.executor.close();
    assert.equal(f.executor.receipt.finalResult, null);
    assert.equal(receipt.finalResult, result); assert.equal(result.digest, hash(encoded));
  } finally { await f.close(); }
});

test('terminal-only and preack completion items are accepted, including optional null phase', async () => {
  for (const preack of [false, true]) {
    const f = fixture({ preack, frames: t => [terminal(t, [{ ...message('a', 'final α'), phase: null }, message('b', '')])] });
    try {
      await f.executor.turn('review');
      assert.deepEqual(f.executor.receipt.finalResult?.messages, [{ id: 'a', text: 'final α' }, { id: 'b', text: '' }]);
      assert.equal(f.state.value.counters.outputBytes, Buffer.byteLength('final α'));
    } finally { await f.close(); }
  }
});

test('identical completed IDs reconcile across both frame forms without changing output or wire charging', async () => {
  const text = 'évidence';
  const f = fixture({ frames: t => [item(t, message('same', text)), item(t, { ...message('same', text), phase: 'final_answer' }),
    terminal(t, [message('same', text), message('other', 'second')])] });
  try {
    await f.executor.turn('review');
    assert.deepEqual(f.executor.receipt.finalResult?.messages, [{ id: 'same', text }, { id: 'other', text: 'second' }]);
    assert.equal(f.state.value.counters.outputBytes, 3 * Buffer.byteLength(text) + Buffer.byteLength('second'));
    assert.equal(f.state.value.counters.wireBytes, f.wire());
  } finally { await f.close(); }
});

test('conflicting completed text, types and phases fail closed in either arrival order', async () => {
  const variants = [message('same', 'changed'), { type: 'reasoning', id: 'same', text: 'PRIVATE_REASONING' },
    { ...message('same', 'first'), phase: 'commentary' }];
  for (const variant of variants) for (const reverse of [false, true]) {
    const pair = reverse ? [variant, message('same', 'first')] : [message('same', 'first'), variant];
    const f = fixture({ frames: t => [item(t, pair[0]), terminal(t, [pair[1]])] });
    try {
      await assert.rejects(f.executor.turn('review'), /Conflicting native completed item/);
      assert.equal(f.executor.receipt.finalResult, null); assert.equal(f.state.value.status, 'stopped');
      assert.equal(JSON.stringify(f.executor.receipt).includes('PRIVATE_REASONING'), false);
    } finally { await f.close(); }
  }
});

test('missing or malformed final IDs, text and phase reject with host-authored errors', async () => {
  const variants: unknown[] = [
    { type: 'agentMessage', text: 'MALFORMED_SECRET' }, { type: 'agentMessage', id: 'a' },
    ...['', null, 4, {}, []].map(id => ({ type: 'agentMessage', id, text: 'MALFORMED_SECRET' })),
    ...[null, 4, {}, []].map(text => ({ type: 'agentMessage', id: 'a', text })),
    { ...message('a', 'MALFORMED_SECRET'), phase: 'unexpected' },
  ];
  for (const value of variants) for (const terminalOnly of [false, true]) {
    const f = fixture({ frames: t => terminalOnly ? [terminal(t, [value])] : [item(t, value), terminal(t)] });
    try {
      await assert.rejects(f.executor.turn('review'), error => {
        assert.match(String(error), /Malformed native final message|Invalid native message phase/);
        assert.equal(String(error).includes('MALFORMED_SECRET'), false); return true;
      });
      assert.equal(f.executor.receipt.finalResult, null);
      assert.equal(JSON.stringify(f.executor.receipt).includes('MALFORMED_SECRET'), false);
    } finally { await f.close(); }
  }
});

test('started text, deltas, reasoning, commentary and user/tool content never enter final evidence', async () => {
  const f = fixture({ frames: t => [item(t, message('started', 'STARTED_ONLY'), 'item/started'),
    { method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: t, delta: 'DELTA_ONLY' } },
    item(t, { type: 'reasoning', id: 'reason', text: 'REASONING_ONLY', summary: ['PRIVATE_SUMMARY'] }),
    item(t, { ...message('comment', 'COMMENTARY_ONLY'), phase: 'commentary' }),
    terminal(t, [{ type: 'userMessage', id: 'user', text: 'USER_ONLY' }, { type: 'dynamicToolCall', id: 'tool', arguments: 'TOOL_ONLY' },
      { ...message('final', 'Owner must independently assess this model claim'), phase: 'final_answer' }])] });
  try {
    await f.executor.turn('review');
    const result = f.executor.receipt.finalResult;
    assert.deepEqual(result?.messages, [{ id: 'final', text: 'Owner must independently assess this model claim' }]);
    for (const marker of ['STARTED_ONLY', 'DELTA_ONLY', 'REASONING_ONLY', 'PRIVATE_SUMMARY', 'COMMENTARY_ONLY', 'USER_ONLY', 'TOOL_ONLY']) {
      assert.equal(JSON.stringify(f.executor.receipt).includes(marker), false);
    }
    assert.equal(f.state.value.counters.outputBytes, Buffer.byteLength('STARTED_ONLYDELTA_ONLYCOMMENTARY_ONLYOwner must independently assess this model claim'));
  } finally { await f.close(); }
  const empty = fixture({ frames: t => [item(t, message('partial', 'partial'), 'item/started'), terminal(t)] });
  try { await empty.executor.turn('review'); assert.deepEqual(empty.executor.receipt.finalResult?.messages, []); }
  finally { await empty.close(); }
});

test('failed, interrupted, provider error, cancellation, pending effect and output rejection publish no result', async () => {
  for (const mode of ['failed', 'interrupted', 'provider', 'cancel', 'pending', 'output']) {
    const controller = new AbortController();
    const f = fixture({ budget: mode === 'output' ? { outputBytes: 1 } : {}, frames: t => [item(t, message()),
      ...(mode === 'provider' ? [remoteError(t)] : [terminal(t, [], mode === 'failed' || mode === 'interrupted' ? mode : 'completed')])] });
    f.host.rpc.onNotification(event => {
      if (event.method !== 'item/completed') return;
      if (mode === 'cancel') controller.abort();
      if (mode === 'pending') f.state.update({ pending: 'files.apply' });
    });
    try {
      await assert.rejects(f.executor.turn('review', controller.signal), error => {
        assert.equal(String(error).includes('REMOTE_SECRET'), false);
        if (mode === 'provider') assert.ok(error instanceof NativeProviderError);
        return true;
      });
      assert.equal(f.executor.receipt.finalResult, null);
      assert.equal(JSON.stringify(f.executor.receipt).includes('REMOTE_SECRET'), false);
      assert.equal(f.state.value.status, mode === 'pending' ? 'indeterminate' : 'stopped');
    } finally { await f.close(); }
  }
});

test('same receive batch terminal followed by faults, duplicates, callbacks or disconnect suppresses success', async () => {
  for (const mode of ['fault', 'duplicate', 'failed', 'callback', 'transport', 'disconnect', 'revoke']) {
    const f = fixture({ frames: t => [item(t, message()), terminal(t),
      ...(mode === 'fault' ? [remoteError(t)] : mode === 'duplicate' ? [terminal(t)] : mode === 'failed' ? [terminal(t, [], 'failed')] :
        mode === 'callback' ? [{ id: 900, method: 'item/tool/call', params: { threadId: 'thread', turnId: t, callId: 'late', tool: 'host_read', arguments: { path: 'value.txt' } } }] :
        mode === 'transport' ? [{ invalid: true }] : [])] });
    f.host.rpc.onNotification(event => {
      if (event.method === 'turn/completed') {
        if (mode === 'disconnect') f.host.rpc.close();
        if (mode === 'revoke') queueMicrotask(f.revoke);
      }
    });
    const statuses: string[] = [], update = f.state.update.bind(f.state);
    f.state.update = patch => { if (patch.status) statuses.push(patch.status); update(patch); };
    try {
      await assert.rejects(f.executor.turn('review'));
      assert.equal(f.executor.receipt.finalResult, null); assert.equal(statuses.includes('ready'), false);
      assert.equal(f.state.value.status, 'stopped');
    } finally { await f.close(); }
  }
});

test('a failed ready checkpoint write cannot publish evidence', async () => {
  const f = fixture(), update = f.state.update.bind(f.state);
  f.state.update = patch => { if (patch.status === 'ready') throw new Error('Fixture checkpoint failure'); update(patch); };
  try { await assert.rejects(f.executor.turn('review'), /checkpoint failure/); assert.equal(f.executor.receipt.finalResult, null); }
  finally { await f.close(); }
});

test('next turns reset evidence and immutable prior snapshots survive success, early budget failure and late faults', async () => {
  for (const mode of ['success', 'input', 'turns', 'late']) {
    const f = fixture({ budget: mode === 'input' ? { inputBytes: 1 } : mode === 'turns' ? { turns: 1 } : {},
      frames: (t, pass) => [item(t, message('same-id', 'answer ' + pass)), terminal(t)] });
    try {
      await f.executor.turn('x');
      const prior = f.executor.receipt.finalResult; assert.ok(prior); const encoded = JSON.stringify(prior);
      if (mode === 'success') {
        await f.executor.turn('x');
        assert.deepEqual(f.executor.receipt.finalResult?.messages, [{ id: 'same-id', text: 'answer 2' }]);
        assert.equal(f.executor.receipt.finalResult?.turnId, 'turn-2');
      } else if (mode === 'late') {
        f.send(remoteError('turn-1')); assert.equal(f.executor.receipt.finalResult, null); await f.executor.close();
      } else {
        await assert.rejects(f.executor.turn('x'), /Native budget exhausted/);
        assert.equal(f.executor.receipt.finalResult, null);
      }
      assert.equal(JSON.stringify(prior), encoded); assert.equal(prior.messages[0]?.text, 'answer 1');
    } finally { await f.close(); }
  }
});

test('resumed historical messages are excluded; historical completed notifications cannot be collected', async () => {
  const history = [{ id: 'old', status: 'completed', items: [message('old-answer', 'HISTORICAL_SECRET')] }];
  for (const historicalFrame of [false, true]) {
    const f = fixture({ resumed: true, history, frames: t => [
      ...(historicalFrame ? [item('old', message('old-answer', 'HISTORICAL_SECRET'))] : []), item(t, message()), terminal(t)] });
    try {
      if (historicalFrame) { await assert.rejects(f.executor.turn('review'), /Wrong notification turn/); assert.equal(f.executor.receipt.finalResult, null); }
      else { await f.executor.turn('review'); assert.deepEqual(f.executor.receipt.finalResult?.messages, [{ id: 'answer', text: 'Review: revise' }]); }
      assert.equal(JSON.stringify(f.executor.receipt).includes('HISTORICAL_SECRET'), false);
    } finally { await f.close(); }
  }
});

test('accepted result source follows an actual host_apply callback through the typed fixture authority', async () => {
  const f = fixture({ frames: t => [{ id: 900, method: 'item/tool/call', params: {
    threadId: 'thread', turnId: t, callId: 'apply', tool: 'host_apply', arguments: { summary: 'fixture edit',
      edits: [{ path: 'value.txt', beforeSha256: hash('before'), content: 'after' }] },
  } }], reply: (reply, t, send) => {
    if (reply.id === 900) {
      assert.equal((reply.result as { success: boolean }).success, true);
      send(item(t, message()), terminal(t));
    }
  } });
  try {
    await f.executor.turn('repair');
    assert.equal(readFileSync(join(f.task.root, 'value.txt'), 'utf8'), 'after');
    assert.equal(f.state.value.pending, null); assert.equal(f.state.value.counters.toolCalls, 1);
    assert.equal(f.executor.receipt.finalResult?.source, hash('after'));
    assert.notEqual(f.executor.receipt.finalResult?.source, f.task.source);
  } finally { await f.close(); }
});

test('32 MiB wire boundary validates; larger and 64 MiB tasks reject before authentication or lease effects', async () => {
  const f = fixture(), session = new ChatGPTPlanSession(); let effects = 0;
  session.prepare = async () => { effects++; };
  session.admitExecution = () => { effects++; throw new Error('Unexpected fixture admission'); };
  try {
    assert.equal(NATIVE_MAX_WIRE_BYTES, 33554432);
    validateNativeTask({ ...f.task, budget: { ...f.task.budget, wireBytes: NATIVE_MAX_WIRE_BYTES } });
    for (const wireBytes of [NATIVE_MAX_WIRE_BYTES + 1, 64 * 1024 * 1024]) {
      const task = { ...f.task, root: join(f.dir, 'absent-root'), budget: { ...f.task.budget, wireBytes } };
      assert.throws(() => validateNativeTask(task), /Invalid native budget: wireBytes/);
      await assert.rejects(runNativeTask({ task, session, objective: 'review', runDirectory: join(f.dir, 'never-created'),
        codexExecutable: process.execPath, parent: { binding: 'a'.repeat(64), check: () => { effects++; } }, signal: new AbortController().signal }), /Invalid native budget: wireBytes/);
    }
    assert.equal(effects, 0); assert.equal(existsSync(join(f.dir, 'never-created')), false);
    for (const wireBytes of [0, 1.5, Infinity]) assert.throws(() => validateBudget({ ...f.task.budget, wireBytes }), /Invalid native budget/);
  } finally { await f.close(); }
});
