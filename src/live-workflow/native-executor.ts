import { NativeProviderError, nativeProviderDiagnostic, nativeProviderFailureContext, createNativeFailureContext } from './native-failure-context.js';
import type { NativeFailureContext } from './native-failure-context.js';
export { NativeProviderError, nativeProviderDiagnostic, nativeProviderFailureContext } from './native-failure-context.js';
export type { NativeErrorKind, NativeProviderDiagnostic, NativeFailureContext } from './native-failure-context.js';
import type { RpcRequest, RpcReply, RpcNotification } from '../agent-drivers/jsonl-rpc.js';
import type { NativeTask } from './native-executor-contracts.js';
import { unavailableNativeMetrics } from './native-executor-contracts.js';
import { NativeResultCollector } from './native-result.js';
import type { NativeFinalResult } from './native-result.js';
import { NativeState } from './native-executor-state.js';
import { assertNativeHost } from './native-executor-host.js';
import type { NativeHost } from './native-executor-host.js';
import { nativeDynamicTools, nativeTool } from './native-executor-tools.js';
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Malformed native object');
  return raw as Record<string, unknown>;
}

function callbackParams(raw: unknown, thread: string | null, turn: string | null) {
  const value = record(raw);
  const keys = ['arguments', 'callId', 'threadId', 'tool', 'turnId', 'namespace'];
  const namespace = value.namespace === undefined || value.namespace === null;
  const call = typeof value.callId === 'string' && value.callId.length > 0 && value.callId.length <= 128;
  if (Object.keys(value).some(key => !keys.includes(key)) || !namespace || !call ||
      value.threadId !== thread || value.turnId !== turn || typeof value.tool !== 'string' ||
      !Object.hasOwn(value, 'arguments')) {
    throw new Error('Malformed native callback');
  }
  return value as {callId: string; tool: string; arguments: unknown};
}

function effectiveThread(raw: unknown, task: NativeTask, existing: string | null, provider: string, cwd: string): string {
  const response = record(raw), thread = record(response.thread), sandbox = record(response.sandbox);
  const model = response.model === task.model && response.reasoningEffort === task.effort && response.modelProvider === provider;
  const policy = response.serviceTier === 'default' && response.approvalPolicy === 'never' && response.approvalsReviewer === 'user';
  const isolationConfig = sandbox.type === 'readOnly' && sandbox.networkAccess === false;
  const runtime = thread.cliVersion === '0.162.1' && thread.cwd === cwd && thread.ephemeral === false && thread.modelProvider === provider;
  if (!model || !policy || !isolationConfig || !runtime || response.cwd !== cwd) {
    throw new Error('Native effective configuration mismatch');
  }
  if (typeof thread.id !== 'string' || !thread.id || thread.id.length > 256 || (existing && thread.id !== existing)) {
    throw new Error('Invalid native thread');
  }
  return thread.id;
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native cleanup timeout')), timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Native owns reasoning and tool sequencing; the owner only enforces host boundaries. */
export class NativeExecutor {
  readonly #task: NativeTask;
  readonly #state: NativeState;
  readonly #host: NativeHost;
  readonly #resultCollector = new NativeResultCollector();
  #finalResult: NativeFinalResult | null = null;
  #turn: string | null = null;
  #active = false;
  #initialized = false;
  #toolBusy = false;
  #closed = false;
  #terminal = false;
  #fatal: Error | null = null;
  #failureContext: Readonly<NativeFailureContext> | null = null;
  #lastTool: NativeFailureContext['lastTool'] = null;
  #controller = new AbortController();
  #reject: ((error: Error) => void) | undefined;
  #resolve: (() => void) | undefined;
  #cleanup: Promise<void> | null = null;
  #checkpointUncertain = false;
  #tokens: unknown = null;
  #historicalTurns = new Set<string>();
  #runtimeStart = 0;
  #runtimeBase = 0;
  readonly #unlisten: (() => void)[] = [];
  constructor(task: NativeTask, state: NativeState, host: NativeHost) {
    assertNativeHost(host);
    host.boundary();
    if (!state.matches(task)) throw new Error('Native task and checkpoint mismatch');
    this.#task = structuredClone(task);
    this.#state = state;
    this.#host = host;
    host.rpc.onRequest(r => this.#callback(r));
    this.#unlisten.push(host.rpc.onWire(bytes => {
      try {
        state.charge('wireBytes', bytes);
      } catch (error) {
        void this.#stop(error as Error);
        throw error;
      }
    }), host.rpc.onFailure(e => { void this.#stop(e); }), host.rpc.onNotification(event => {
      try {
        this.#consume(event);
      } catch (error) {
        void this.#stop(error as Error);
      }
    }));
  }
  #events: RpcNotification[] = [];
  #consume(event: RpcNotification): void {
    const known = [
      'thread/started', 'turn/started', 'item/started', 'item/completed',
      'item/agentMessage/delta', 'thread/tokenUsage/updated', 'turn/completed', 'error',
    ];
    if (!known.includes(event.method)) return;
    if (!this.#active || this.#controller.signal.aborted) throw new Error('Notification outside active turn');
    this.#host.boundary();
    this.#runtimeBoundary();
    const p = event.params as Record<string, unknown>;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Malformed native notification');
    if (event.method === 'thread/tokenUsage/updated' && !this.#turn && this.#state.value.thread &&
        typeof p.turnId === 'string' && this.#historicalTurns.has(p.turnId)) {
      if (p.threadId !== this.#state.value.thread) throw new Error('Wrong notification thread');
      return; // Resume bootstrap telemetry is not current-turn token usage.
    }
    if (!this.#state.value.thread || (!this.#turn && event.method !== 'thread/started')) {
      if (this.#events.length >= 64) throw new Error('Preack notification limit');
      this.#events.push(event);
      return;
    }
    if (event.method === 'thread/started') {
      const thread = p.thread as {id?:string} | undefined;
      if (thread?.id !== this.#state.value.thread) throw new Error('Wrong started thread');
      return;
    }
    if (p.threadId !== this.#state.value.thread) throw new Error('Wrong notification thread');
    if (event.method === 'turn/started' || event.method === 'turn/completed') {
      const turn = p.turn as {id?:string;status?:string;items?:unknown[];error?:unknown} | undefined;
      if (turn?.id !== this.#turn) throw new Error('Wrong notification turn');
      if (event.method === 'turn/completed') {
        if (this.#terminal) throw new Error('Duplicate native terminal frame');
        this.#terminal = true;
        if (turn.status === 'failed') throw new NativeProviderError(turn.error, false, {origin: 'turn-completed', lastTool: this.#lastTool});
        if (turn.status !== 'completed' || !Array.isArray(turn.items) ||
            this.#state.value.pending || this.#toolBusy) {
          throw new Error('Invalid turn completion');
        }
        turn.items.forEach(item => this.#item(item, true));
        this.#resolve?.();
      }
      return;
    }
    if (this.#terminal) throw new Error('Native traffic after terminal frame');
    if (p.turnId !== this.#turn) throw new Error('Wrong notification turn');
    if (event.method === 'item/agentMessage/delta') {
      if (typeof p.delta !== 'string') throw new Error('Malformed output');
      this.#state.charge('outputBytes', Buffer.byteLength(p.delta));
    } else if (event.method === 'thread/tokenUsage/updated') {
      this.#tokens = p.tokenUsage;
    } else if (event.method === 'item/started' || event.method === 'item/completed') {
      this.#item(p.item, event.method === 'item/completed');
    } else {
      throw new NativeProviderError(p.error, p.willRetry, {origin: 'error-notification', lastTool: this.#lastTool});
    }
  }
  #item(raw: unknown, completed: boolean): void {
    const item = record(raw);
    const supported = ['userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall'];
    if (!supported.includes(String(item.type))) throw new Error('Unsupported native operation');
    if (item.type === 'agentMessage' && typeof item.text === 'string') {
      this.#state.charge('outputBytes', Buffer.byteLength(item.text));
    }
    if (completed) this.#resultCollector.completed(item);
  }
  #flush(): void {
    const queued = this.#events;
    this.#events = [];
    queued.forEach(event => this.#consume(event));
  }

  #runtimeBoundary(): void {
    if (!this.#active) return;
    const elapsed = Math.ceil(performance.now() - this.#runtimeStart);
    const target = this.#runtimeBase + elapsed;
    const extra = target - this.#state.value.counters.runtimeMs;
    if (target >= this.#task.budget.runtimeMs) throw new Error('Native runtime exhausted');
    if (extra > 0) this.#state.charge('runtimeMs', extra);
  }
  async #callback(request: RpcRequest): Promise<RpcReply> {
    try {
      if (request.method !== 'item/tool/call' || this.#terminal || !this.#active ||
          !this.#turn || this.#controller.signal.aborted) {
        throw new Error('Denied native request');
      }
      this.#host.boundary();
      this.#runtimeBoundary();
      const p = callbackParams(request.params, this.#state.value.thread, this.#turn);
      if (this.#state.value.pending || this.#toolBusy) throw new Error('Concurrent native callback');
      this.#toolBusy = true;
      this.#state.claim(p.callId);
      this.#state.charge('inputBytes', Buffer.byteLength(JSON.stringify(p.arguments)));
      const text = await nativeTool(this.#task, this.#state, this.#host, p.tool, p.arguments, this.#controller.signal);
      // The awaited host operation has settled; attempted or denied tools never advance this fact.
      if (p.tool === 'host_read' || p.tool === 'host_apply' || p.tool === 'host_check') this.#lastTool = p.tool;
      return { result: { success: true, contentItems: [{ type: 'inputText', text }] } };
    } catch (e) {
      void this.#stop(e as Error);
      return { result: { success: false, contentItems: [{ type: 'inputText', text: 'Host denied operation' }] } };
    } finally {
      this.#toolBusy = false;
    }
  }
  async #stop(error: Error): Promise<void> {
    this.#finalResult = null;
    this.#resultCollector.clear();
    this.#fatal ??= error;
    this.#failureContext ??= nativeProviderFailureContext(this.#fatal) ??
      createNativeFailureContext('missing', {lastTool: this.#lastTool});
    if (this.#closed) return this.#cleanup ?? Promise.resolve();
    this.#controller.abort(error);
    this.#closed = true;
    this.#cleanup = (async () => {
      let status: 'stopped' | 'indeterminate' = this.#state.value.pending ? 'indeterminate' : 'stopped';
      if (this.#turn && this.#state.value.thread) {
        try {
          await bounded(this.#host.rpc.request('turn/interrupt', {
            threadId: this.#state.value.thread, turnId: this.#turn,
          }), 100);
        } catch { /* supervisor stop remains mandatory */ }
      }
      this.#host.rpc.close();
      try {
        await bounded(this.#host.stop(), 3000);
      } catch {
        status = 'indeterminate';
      }
      try { this.#state.update({ status }); }
      catch {
        this.#checkpointUncertain = true;
        // Retain pending effects; only mark uncertainty best effort. A failed
        // checkpoint write must never prevent rejection with the primary error.
        try { this.#state.update({status:'indeterminate'}); } catch {}
      }
      this.#reject?.(error);
    })();
    return this.#cleanup;
  }
  async turn(input: string, signal?: AbortSignal): Promise<void> {
    if (this.#active) throw new Error('Inactive native session');
    // A failed next attempt must never expose the previous accepted result.
    this.#finalResult = null;
    this.#resultCollector.clear();
    this.#tokens = null;
    this.#historicalTurns.clear();
    if (!this.#closed) { this.#lastTool = null; this.#failureContext = null; }
    if (this.#closed || this.#state.value.pending) throw new Error('Inactive native session');
    this.#host.boundary();
    signal?.throwIfAborted();
    this.#state.charge('inputBytes', Buffer.byteLength(input));
    this.#state.charge('turns', 1);
    // Prepaid slices prevent a crash from silently resetting active runtime.
    const slice = Math.min(20, this.#task.budget.runtimeMs - this.#state.value.counters.runtimeMs);
    if (slice < 1) throw new Error('Native runtime exhausted');
    this.#runtimeStart = performance.now();
    this.#runtimeBase = this.#state.value.counters.runtimeMs;
    this.#state.charge('runtimeMs', slice);
    this.#state.update({ status: 'running' });
    this.#terminal = false;
    this.#active = true;
    const done = new Promise<void>((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    void done.catch(() => undefined);
    const abort = () => { void this.#stop(new Error('Native cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setInterval(() => {
      try { this.#host.boundary();
    this.#runtimeBoundary(); }
      catch (e) { void this.#stop(e as Error); }
    }, slice);
    try {
      const rpc = this.#host.rpc;
      if (!this.#initialized) {
        await rpc.request('initialize', {
          clientInfo: { name: 'forgemind-native', version: '1' },
          capabilities: { experimentalApi: true },
        });
        await rpc.notify('initialized', {});
        this.#initialized = true;
      }
      const existing = this.#state.value.thread;
      const cwd = this.#host.nativeCwd ?? this.#task.root;
      const thread = await rpc.request(existing ? 'thread/resume' : 'thread/start', {
        ...(existing ? { threadId: existing } : {}), cwd, approvalPolicy: 'never',
        sandbox: 'read-only', model: this.#task.model, modelProvider: this.#host.provider,
        serviceTier: 'default', approvalsReviewer: 'user',
        ...(!existing ? { allowProviderModelFallback: false, ephemeral: false } : {}),
        config: { model_reasoning_effort: this.#task.effort, project_doc_max_bytes: 0 },
        ...(!existing ? { dynamicTools: nativeDynamicTools, historyMode: 'legacy' } : {}),
      });
      const threadId = effectiveThread(thread, this.#task, existing, this.#host.provider, cwd);
      if (existing) {
        const turns = record(record(thread).thread).turns;
        if (!Array.isArray(turns) || turns.length > 10000) throw new Error('Invalid resumed turn history');
        for (const raw of turns) {
          const past = record(raw);
          if (typeof past.id !== 'string' || !past.id || past.id.length > 256 ||
              typeof past.status !== 'string' || !['completed', 'failed', 'interrupted'].includes(past.status) ||
              this.#historicalTurns.has(past.id)) throw new Error('Invalid resumed turn history');
          this.#historicalTurns.add(past.id);
        }
      }
      this.#state.update({ thread: threadId, status: 'running' });
      this.#flush();
      await rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input, text_elements: [] }],
        cwd, model: this.#task.model, effort: this.#task.effort,
        serviceTier: 'default', approvalPolicy: 'never', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }, value => {
        const response = record(value), turn = record(response.turn);
        if (typeof turn.id !== 'string' || !turn.id || turn.id.length > 256) throw new Error('Invalid native turn');
        if (this.#historicalTurns.has(turn.id)) throw new Error('Native turn reused historical ID');
        this.#turn = turn.id;
        this.#flush();
      });
      await done;
      // This settlement observes faults already dispatched by the current receive
      // batch and queued preack events. A persistent session does not await EOF.
      if (this.#fatal || this.#closed) throw this.#fatal ?? new Error('Native session closed');
      this.#controller.signal.throwIfAborted();
      signal?.throwIfAborted();
      this.#host.boundary();
      this.#runtimeBoundary();
      if (this.#fatal || !this.#terminal || this.#toolBusy || this.#state.value.pending || this.#events.length) {
        throw this.#fatal ?? new Error('Native turn has unsettled operations');
      }
      this.#state.update({ status: 'ready' });
      this.#finalResult = this.#resultCollector.snapshot(this.#state.value.source, this.#turn!);
      this.#resultCollector.clear();
    } catch (error) {
      await this.#stop(error as Error);
      throw error;
    }
    finally {
      clearInterval(timer);
      signal?.removeEventListener('abort', abort);
      this.#active = false;
      this.#turn = null;
      this.#resolve = undefined;
      this.#reject = undefined;
    }
  }
  get failureContext(): Readonly<NativeFailureContext> | null { return this.#failureContext; }
  get receipt() {
    return {
      checkpoint: this.#state.value, checkpointUncertain:this.#checkpointUncertain, finalResult: this.#finalResult,
      observedTokenUsage: this.#tokens, nativeDiagnostic:nativeProviderDiagnostic(this.#fatal),
      unavailable: [...unavailableNativeMetrics], qualification: this.#host.qualification,
    };
  }
  async close(): Promise<void> {
    await this.#stop(new Error('Owner closed native session'));
    this.#unlisten.forEach(unlisten => unlisten());
  }
}
