import type { RpcRequest, RpcReply, RpcNotification } from '../agent-drivers/jsonl-rpc.js';
import type { NativeTask } from './native-executor-contracts.js';
import { unavailableNativeMetrics } from './native-executor-contracts.js';
import { NativeState } from './native-executor-state.js';
import { assertNativeHost } from './native-executor-host.js';
import type { NativeHost } from './native-executor-host.js';
import { nativeDynamicTools, nativeTool } from './native-executor-tools.js';
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Malformed native object');
  return raw as Record<string, unknown>;
}

const nativeErrorKinds = [
  'contextWindowExceeded','sessionBudgetExceeded','usageLimitExceeded','rateLimitExceeded',
  'flexUnavailable','serverOverloaded','cyberPolicy','misalignmentPolicyViolation','tooManyDenials',
  'internalServerError','unauthorized','badRequest','threadRollbackFailed','sandboxError','other',
] as const;
const nativeHttpErrorKinds = [
  'httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts',
] as const;
export type NativeErrorKind = typeof nativeErrorKinds[number] | typeof nativeHttpErrorKinds[number] | 'activeTurnNotSteerable' | 'unknown';
export interface NativeProviderDiagnostic {
  readonly kind: NativeErrorKind;
  readonly httpStatusCode: number | null;
  readonly willRetry: boolean | null;
}
/** Remote text is deliberately never assigned to Error.message, cause or receipts. */
export class NativeProviderError extends Error {
  readonly diagnostic: Readonly<NativeProviderDiagnostic>;
  constructor(rawError: unknown, willRetry: unknown) {
    let kind: NativeErrorKind='unknown',httpStatusCode:number|null=null;
    const error=rawError && typeof rawError==='object' && !Array.isArray(rawError) ? rawError as Record<string,unknown> : null;
    const info=error?.codexErrorInfo;
    if(typeof info==='string' && (nativeErrorKinds as readonly string[]).includes(info))kind=info as NativeErrorKind;
    else if(info && typeof info==='object' && !Array.isArray(info)){
      const keys=Object.keys(info);
      if(keys.length===1){
        const key=keys[0]!;
        if((nativeHttpErrorKinds as readonly string[]).includes(key)){
          const detail=(info as Record<string,unknown>)[key];
          if(detail && typeof detail==='object' && !Array.isArray(detail)){
            const status=(detail as Record<string,unknown>).httpStatusCode;
            if(status===null||status===undefined){kind=key as NativeErrorKind;}
            else if(Number.isSafeInteger(status) && (status as number)>=0 && (status as number)<=65535){
              kind=key as NativeErrorKind;httpStatusCode=status as number;
            }
          }
        }else if(key==='activeTurnNotSteerable'){
          const detail=(info as Record<string,unknown>)[key];
          if(detail && typeof detail==='object' && !Array.isArray(detail))kind=key;
        }
      }
    }
    super('Native provider failure: '+kind);
    this.name='NativeProviderError';
    this.diagnostic=Object.freeze({kind,httpStatusCode,willRetry:typeof willRetry==='boolean'?willRetry:null});
  }
}
export function nativeProviderDiagnostic(error:unknown):Readonly<NativeProviderDiagnostic>|null{
  return error instanceof NativeProviderError ? error.diagnostic : null;
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
  #turn: string | null = null;
  #active = false;
  #initialized = false;
  #toolBusy = false;
  #closed = false;
  #terminal = false;
  #fatal: Error | null = null;
  #controller = new AbortController();
  #reject: ((error: Error) => void) | undefined;
  #resolve: (() => void) | undefined;
  #cleanup: Promise<void> | null = null;
  #tokens: unknown = null;
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
        if (turn.status === 'failed') throw new NativeProviderError(turn.error, false);
        if (turn.status !== 'completed' || !Array.isArray(turn.items) ||
            this.#state.value.pending || this.#toolBusy) {
          throw new Error('Invalid turn completion');
        }
        turn.items.forEach(item => this.#item(item));
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
      this.#item(p.item);
    } else {
      throw new NativeProviderError(p.error, p.willRetry);
    }
  }
  #item(raw: unknown): void {
    const item = record(raw);
    const supported = ['userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall'];
    if (!supported.includes(String(item.type))) throw new Error('Unsupported native operation');
    if (item.type === 'agentMessage' && typeof item.text === 'string') {
      this.#state.charge('outputBytes', Buffer.byteLength(item.text));
    }
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
      return { result: { success: true, contentItems: [{ type: 'inputText', text }] } };
    } catch (e) {
      void this.#stop(e as Error);
      return { result: { success: false, contentItems: [{ type: 'inputText', text: 'Host denied operation' }] } };
    } finally {
      this.#toolBusy = false;
    }
  }
  async #stop(error: Error): Promise<void> {
    this.#fatal ??= error;
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
      this.#state.update({ status });
      this.#reject?.(error);
    })();
    return this.#cleanup;
  }
  async turn(input: string, signal?: AbortSignal): Promise<void> {
    if (this.#active || this.#closed || this.#state.value.pending) throw new Error('Inactive native session');
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
  get receipt() {
    return {
      checkpoint: this.#state.value, observedTokenUsage: this.#tokens, nativeDiagnostic:nativeProviderDiagnostic(this.#fatal),
      unavailable: [...unavailableNativeMetrics], qualification: this.#host.qualification,
    };
  }
  async close(): Promise<void> {
    await this.#stop(new Error('Owner closed native session'));
    this.#unlisten.forEach(unlisten => unlisten());
  }
}
