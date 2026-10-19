import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeExecutor, NativeProviderError, nativeProviderDiagnostic, nativeProviderFailureContext } from '../../src/live-workflow/native-executor.js';
import { createNativeFailureContext } from '../../src/live-workflow/native-failure-context.js';
import { NativeState } from '../../src/live-workflow/native-executor-state.js';
import { FixtureNativeHost } from '../../src/live-workflow/native-executor-host.js';
import type { NativeRpc } from '../../src/live-workflow/native-executor-host.js';
import type { NativeTask } from '../../src/live-workflow/native-executor-contracts.js';
import type { RpcNotification, RpcReply, RpcRequest } from '../../src/agent-drivers/jsonl-rpc.js';
import { sha256 } from '../../src/live-workflow/validation.js';

const expected = (parseStatus: string, origin = 'unspecified', lastTool: string | null = null) =>
  ({schemaVersion: 1, origin, parseStatus, nativeCliVersion: '0.162.1', lastTool});
const marker = 'PRIVATE_REMOTE_PAYLOAD_MUST_NOT_SURVIVE';

test('legacy diagnostics retain exactly three fields and all supported variants', () => {
  const kinds = ['contextWindowExceeded','sessionBudgetExceeded','usageLimitExceeded','rateLimitExceeded',
    'flexUnavailable','serverOverloaded','cyberPolicy','misalignmentPolicyViolation','tooManyDenials',
    'internalServerError','unauthorized','badRequest','threadRollbackFailed','sandboxError','other'];
  for (const kind of kinds) {
    const error = new NativeProviderError({codexErrorInfo: kind, message: marker, cause: marker}, false);
    assert.deepEqual(nativeProviderDiagnostic(error), {kind, httpStatusCode: null, willRetry: false});
    assert.deepEqual(nativeProviderFailureContext(error), expected(kind === 'other' ? 'provider-other' : 'recognized'));
    assert.equal(Object.isFrozen(error.diagnostic), true);
    assert.equal(Object.isFrozen(nativeProviderFailureContext(error)), true);
    assert.equal(JSON.stringify(error).includes(marker), false);
    assert.equal(String(error).includes(marker), false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
  }
  for (const kind of ['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts']) {
    for (const status of [null, undefined, 0, 502, 65535]) {
      const error = new NativeProviderError({codexErrorInfo: {[kind]: {httpStatusCode: status}}}, true);
      assert.deepEqual(error.diagnostic, {kind, httpStatusCode: status ?? null, willRetry: true});
      assert.deepEqual(nativeProviderFailureContext(error), expected('recognized'));
    }
    for (const status of [-1, 65536, 1.5, NaN, '502', marker]) {
      const error = new NativeProviderError({codexErrorInfo: {[kind]: {httpStatusCode: status}}}, marker);
      assert.deepEqual(error.diagnostic, {kind: 'unknown', httpStatusCode: null, willRetry: null});
      assert.deepEqual(nativeProviderFailureContext(error), expected('unrecognized'));
    }
  }
  assert.equal(new NativeProviderError({codexErrorInfo: {activeTurnNotSteerable: {}}}, null).diagnostic.kind, 'activeTurnNotSteerable');
});

test('missing, unrecognized and explicit provider other remain distinct without inferred causes', () => {
  for (const raw of [undefined, null, {}, {codexErrorInfo: null}, {codexErrorInfo: undefined}]) {
    const error = new NativeProviderError(raw, false);
    assert.deepEqual(nativeProviderFailureContext(error), expected('missing'));
    assert.equal(error.diagnostic.kind, 'unknown');
  }
  for (const raw of [marker, false, 2, [], {codexErrorInfo: marker}, {codexErrorInfo: {}},
    {codexErrorInfo: {unknownKind: marker}}, {codexErrorInfo: {other: {}}},
    {message: 'quota auth network', codexErrorInfo: {unauthorized: {}, other: {}}}]) {
    const error = new NativeProviderError(raw, false);
    assert.deepEqual(nativeProviderFailureContext(error), expected('unrecognized'));
    assert.equal(error.diagnostic.kind, 'unknown');
    assert.equal(JSON.stringify(nativeProviderFailureContext(error)).includes(marker), false);
  }
  assert.deepEqual(nativeProviderFailureContext(new NativeProviderError({codexErrorInfo: 'other'}, false)), expected('provider-other'));
  const nullPrototype = Object.assign(Object.create(null), {codexErrorInfo: 'other'});
  assert.deepEqual(nativeProviderFailureContext(new NativeProviderError(nullPrototype, false)), expected('provider-other'));
});

test('raw parsing, trusted-context sanitizing and identity lookups invoke zero hostile traps', () => {
  let traps = 0;
  const trap = () => { traps++; throw new Error('Unexpected hostile invocation'); };
  const handler = {get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, ownKeys: trap, has: trap};
  const revoked = Proxy.revocable({}, handler); revoked.revoke();
  const accessor = Object.defineProperty({}, 'codexErrorInfo', {get: trap});
  const hiddenGetter = Object.defineProperty({codexErrorInfo: 'unauthorized'}, 'message', {get: trap});
  const prototype = new Proxy({}, handler);
  const hostile: unknown[] = [new Proxy({}, handler), revoked.proxy, accessor, hiddenGetter, Object.create(prototype),
    new (class {codexErrorInfo = 'unauthorized';})(),
    Object.defineProperty({}, Symbol.toPrimitive, {get: trap})];
  for (const raw of hostile) {
    const error = new NativeProviderError(raw, raw, raw);
    assert.deepEqual(error.diagnostic, {kind: 'unknown', httpStatusCode: null, willRetry: null});
    assert.deepEqual(nativeProviderFailureContext(error), expected('unrecognized'));
    assert.equal(nativeProviderDiagnostic(raw), null);
    assert.equal(nativeProviderFailureContext(raw), null);
    for (const nested of [{codexErrorInfo: raw}, {codexErrorInfo: {httpConnectionFailed: raw}}]) {
      assert.equal(new NativeProviderError(nested, false).diagnostic.kind, 'unknown');
    }
  }
  const context = new NativeProviderError({codexErrorInfo: 'other'}, false,
    {origin: marker, lastTool: marker, parseStatus: 'recognized', nativeCliVersion: marker, cause: marker});
  assert.deepEqual(nativeProviderFailureContext(context), expected('provider-other'));
  assert.deepEqual(createNativeFailureContext('recognized', {origin: 'turn-completed', lastTool: 'host_check'}), expected('recognized', 'turn-completed', 'host_check'));
  const diagnostic = context.diagnostic, facts = nativeProviderFailureContext(context);
  Object.defineProperties(context, {diagnostic: {get: trap}, failureContext: {get: trap}, message: {get: trap}, cause: {get: trap}});
  assert.equal(nativeProviderDiagnostic(context), diagnostic);
  assert.equal(nativeProviderFailureContext(context), facts);
  for (const value of [new Proxy(context, handler), Object.create(context), NativeProviderError.prototype, () => {}, 0, null]) {
    assert.equal(nativeProviderDiagnostic(value), null); assert.equal(nativeProviderFailureContext(value), null);
  }
  assert.equal(traps, 0);
});

class EventRpc implements NativeRpc {
  listeners = new Set<(event: RpcNotification) => void>();
  handler!: (request: RpcRequest) => Promise<RpcReply>;
  action: () => Promise<void> = async () => {};
  actionDone: Promise<void> = Promise.resolve();
  onRequest(handler: (request: RpcRequest) => Promise<RpcReply>) { this.handler = handler; }
  onNotification(listener: (event: RpcNotification) => void) { this.listeners.add(listener); return () => {this.listeners.delete(listener);}; }
  onFailure(_listener: (error: Error) => void) { return () => {}; }
  onWire(_listener: (bytes: number) => void) { return () => {}; }
  async notify() {}
  close() {}
  emit(event: RpcNotification) { this.listeners.forEach(listener => listener(event)); }
  async request(method: string, raw: unknown, onResult?: (value: unknown) => void) {
    const p = raw as {cwd: string; model: string; config: {model_reasoning_effort: string}};
    let result: unknown = {};
    if (method === 'thread/start' || method === 'thread/resume') result = {
      thread: {id: 'thread', cliVersion: '0.162.1', cwd: p.cwd, ephemeral: false, modelProvider: 'openai', turns: []},
      model: p.model, reasoningEffort: p.config.model_reasoning_effort, modelProvider: 'openai', cwd: p.cwd,
      serviceTier: 'default', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: {type: 'readOnly', networkAccess: false},
    };
    if (method === 'turn/start') result = {turn: {id: 'turn'}};
    onResult?.(result);
    if (method === 'turn/start') this.actionDone = Promise.resolve().then(() => this.action());
    return result;
  }
  tool(tool: string, args: unknown, callId = tool): Promise<RpcReply> {
    return this.handler({id: callId, method: 'item/tool/call', params: {
      threadId: 'thread', turnId: 'turn', callId, tool, arguments: args, namespace: null,
    }});
  }
  failure(origin: string, info: unknown = 'other') {
    const error = {codexErrorInfo: info, message: marker, cause: {secret: marker}, additionalDetails: marker};
    this.emit(origin === 'error-notification'
      ? {method: 'error', params: {threadId: 'thread', turnId: 'turn', error, willRetry: false}}
      : {method: 'turn/completed', params: {threadId: 'thread', turn: {id: 'turn', status: 'failed', error}}});
  }
}
function fixture(check: () => Promise<unknown> = async () => ({passed: true})) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'native-context-'))), root = join(dir, 'repo');
  mkdirSync(root); writeFileSync(join(root, 'file.txt'), 'before');
  const source = () => sha256(readFileSync(join(root, 'file.txt')));
  const task: NativeTask = {project: 'fixture', task: 'context', root, source: source(), model: 'gpt-6.1-sol', effort: 'medium',
    readPaths: ['file.txt'], writePaths: ['file.txt'], checks: [{id: 'check', executable: process.execPath, args: [], timeoutMs: 1000}],
    budget: {runtimeMs: 10000, turns: 4, toolCalls: 10, retries: 0, inputBytes: 10000, resultBytes: 10000, wireBytes: 10000, outputBytes: 10000}};
  const state = new NativeState(join(dir, 'state'), task), rpc = new EventRpc();
  let beforeCleanup: unknown;
  const host = new FixtureNativeHost(rpc, {reserve: () => ({check: () => {}, finish: () => {}})}, () => {},
    async () => {beforeCleanup = executor.failureContext;}, source, check);
  const executor = new NativeExecutor(task, state, host);
  return {executor, rpc, state, get beforeCleanup() {return beforeCleanup;},
    close: async () => {await executor.close(); state.close(); rmSync(dir, {recursive: true, force: true});}};
}

test('actual executor error and failed-turn events capture origin and only settled tools before cleanup', async () => {
  for (const origin of ['error-notification', 'turn-completed']) {
    for (const tool of [null, 'host_read', 'host_apply', 'host_check'] as const) {
      const f = fixture();
      f.rpc.action = async () => {
        if (tool) {
          const args = tool === 'host_read' ? {path: 'file.txt'} : tool === 'host_check' ? {id: 'check'} :
            {summary: 'fixture', edits: [{path: 'file.txt', beforeSha256: sha256('before'), content: 'after'}]};
          const reply = await f.rpc.tool(tool, args);
          assert.equal('result' in reply && (reply.result as {success: boolean}).success, true);
        }
        f.rpc.failure(origin);
      };
      try {
        assert.equal(f.executor.failureContext, null);
        await assert.rejects(f.executor.turn('offline event'), error => {
          assert.deepEqual(nativeProviderFailureContext(error), expected('provider-other', origin, tool));
          return true;
        });
        await f.rpc.actionDone;
        assert.deepEqual(f.executor.failureContext, expected('provider-other', origin, tool));
        assert.equal(f.beforeCleanup, f.executor.failureContext);
        assert.deepEqual(f.executor.receipt.nativeDiagnostic, {kind: 'other', httpStatusCode: null, willRetry: false});
        assert.equal(Object.hasOwn(f.executor.receipt, 'failureContext'), false);
        assert.equal(JSON.stringify([f.executor.receipt, f.executor.failureContext]).includes(marker), false);
      } finally {await f.close();}
    }
  }
});

test('an in-flight check cannot replace the preceding completed read in captured provider facts', async () => {
  let resolveCheck!: (value: unknown) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => {started = resolve;});
  const f = fixture(() => {started(); return new Promise(resolve => {resolveCheck = resolve;});});
  f.rpc.action = async () => {
    await f.rpc.tool('host_read', {path: 'file.txt'});
    const pending = f.rpc.tool('host_check', {id: 'check'});
    await entered;
    f.rpc.failure('error-notification', 'rateLimitExceeded');
    resolveCheck({passed: true});
    await pending;
  };
  try {
    await assert.rejects(f.executor.turn('offline pending'), error => {
      assert.deepEqual(nativeProviderFailureContext(error), expected('recognized', 'error-notification', 'host_read'));
      return true;
    });
    await f.rpc.actionDone;
    assert.deepEqual(f.executor.failureContext, expected('recognized', 'error-notification', 'host_read'));
  } finally {await f.close();}
});

test('denied callbacks retain safe unspecified failure context without inventing completed tools', async () => {
  const f = fixture();
  f.rpc.action = async () => {await f.rpc.tool('host_read', {path: 'outside'});};
  try {
    await assert.rejects(f.executor.turn('offline denied'));
    await f.rpc.actionDone;
    assert.deepEqual(f.executor.failureContext, expected('missing'));
    assert.equal(f.beforeCleanup, f.executor.failureContext);
    assert.equal(f.executor.receipt.nativeDiagnostic, null);
  } finally {await f.close();}
});
