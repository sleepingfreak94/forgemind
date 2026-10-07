import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { OptimizationInput } from '../context-engine/contracts.js';
import { PassThroughContextOptimizer } from '../context-engine/optimizer.js';
import { bytes, digest, freeze, positive, serialize, snapshot, string } from '../context-engine/validation.js';
import { DriverError } from './contracts.js';
import type { AgentDriver, DriverEvent, DriverHost, CodexIntent, DriverLease, DriverResult, DriverStatus } from './contracts.js';
import { CODEX_VERSION, denyRequest, initializeParams, record, threadParams, turnParams, verifyThread } from './codex-wire.js';
import type { RpcNotification } from './jsonl-rpc.js';

export interface CodexOptions {
  workspaceRoot: string;
  model: string;
  effort: string;
  host: DriverHost;
  optimizer: PassThroughContextOptimizer;
  maxRuntimeMs: number;
  maxOutputBytes: number;
  clock?: () => number;
}
/** Race a host/RPC await without assuming a privileged host honors cancellation. */
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw new DriverError('cancelled'); }
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new DriverError('cancelled')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([promise, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}
export class CodexDriver implements AgentDriver {
  readonly capabilities = Object.freeze({ protocol: 'codex-app-server-stdio', cliVersion: CODEX_VERSION,
    mode: 'read-only', nativeResume: false, writes: false, mcpInjection: false, subagents: false, liveConformance: false });
  readonly #options: CodexOptions;
  #busy = false;
  #unusable = false;
  constructor(options: CodexOptions) {
    string(options.workspaceRoot); string(options.model, 128); string(options.effort, 128);
    if (!isAbsolute(options.workspaceRoot) || realpathSync(options.workspaceRoot) !== options.workspaceRoot ||
        !options.host || typeof options.host.open !== 'function' || !(options.optimizer instanceof PassThroughContextOptimizer)) throw new DriverError('invalid-input');
    positive(options.maxRuntimeMs, 60000); positive(options.maxOutputBytes, 1024 * 1024);
    this.#options = Object.freeze({ ...options });
  }
  async run(raw: OptimizationInput, caller?: AbortSignal): Promise<DriverResult> {
    if (this.#busy || this.#unusable) throw new DriverError('busy'); this.#busy = true;
    const deadline = AbortSignal.timeout(this.#options.maxRuntimeMs);
    let active = caller ? AbortSignal.any([caller, deadline]) : deadline;
    let expiry: AbortSignal | undefined;
    let lease: DriverLease | undefined, threadId = '', turnId = '', viewDigest = '';
    let status: DriverStatus = 'failed';
    let result: DriverResult | undefined, failure: unknown;
    const events: DriverEvent[] = [], receipts: string[] = [];
    const messages = new Map<string, string>();
    const queue: RpcNotification[] = [];
    let resolveDone!: (value: Record<string, unknown>) => void;
    let rejectDone!: (error: unknown) => void;
    let fatal: unknown;
    let terminalSeen = false;
    let unlistenFailure: (() => void) | undefined;
    let unlistenNotification: (() => void) | undefined;
    let rejectFatal!: (error: unknown) => void;
    const failed = new Promise<never>((_, reject) => { rejectFatal = reject; });
    void failed.catch(() => {});
    const done = new Promise<Record<string, unknown>>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => {});
    const fault = (error: unknown) => { fatal ??= error; rejectDone(error); rejectFatal(error); };
    const wait = <T>(promise: Promise<T>, signal = active) => bounded(Promise.race([promise, failed]), signal);
    const live = async () => {
      if (fatal) throw fatal;
      active.throwIfAborted();
      try { await wait(lease!.check(active)); }
      catch { this.#unusable = true; throw new DriverError('denied'); }
      if (fatal) throw fatal;
      if (rawExpiry <= (this.#options.clock ?? Date.now)()) throw new DriverError('denied');
    };
    let rawExpiry = 0;
    const addMessage = (rawItem: unknown) => {
      const item = record(rawItem);
      // Automatic command reads still need host environment authority. Every other
      // tool/output type is unsupported rather than assumed harmless.
      if (!['userMessage', 'agentMessage', 'reasoning', 'commandExecution'].includes(String(item.type))) throw new DriverError('denied');
      if (item.type !== 'agentMessage') return;
      string(item.id, 128); string(item.text, this.#options.maxOutputBytes, true);
      messages.set(item.id, item.text);
      if (messages.size > 128 || bytes([...messages.values()].join('\n')) > this.#options.maxOutputBytes) throw new DriverError('output-limit');
    };
    const consume = (event: RpcNotification) => {
      if (!['item/completed', 'turn/completed', 'error'].includes(event.method)) return;
      const params = record(event.params);
      if (params.threadId !== threadId) return;
      if (!turnId) { if (queue.length >= 256) throw new DriverError('output-limit'); queue.push(event); return; }
      const current = event.method === 'turn/completed' ? record(params.turn).id : params.turnId;
      if (current !== turnId) return;
      if (terminalSeen) throw new DriverError('protocol-error');
      if (event.method === 'error') { fault(new DriverError('rpc-error')); return; }
      if (event.method === 'item/completed') addMessage(params.item);
      else {
        const turn = record(params.turn);
        if (!['completed', 'failed', 'interrupted'].includes(String(turn.status)) || !Array.isArray(turn.items)) throw new DriverError('protocol-error');
        turn.items.forEach(addMessage); terminalSeen = true; resolveDone(turn);
      }
    };
    try {
      const packet = snapshot(raw); rawExpiry = packet.expiresAt;
      const remaining = packet.expiresAt - (this.#options.clock ?? Date.now)();
      if (remaining <= 0) throw new DriverError('denied');
      expiry = AbortSignal.timeout(Math.min(remaining, 2147483647));
      active = AbortSignal.any([active, expiry]);
      active.throwIfAborted();
      const context = await bounded(this.#options.optimizer.optimize(packet, active), active);
      viewDigest = context.viewDigest; receipts.push(...context.authorizationReceipts);
      const intent: CodexIntent = freeze({ driver: 'codex', scope: structuredClone(packet.scope), expiresAt: packet.expiresAt,
        workspaceRoot: this.#options.workspaceRoot, model: this.#options.model, provider: 'openai', effort: this.#options.effort,
        cliVersion: CODEX_VERSION, mode: 'read-only', ephemeral: true, viewDigest,
        maxRuntimeMs: this.#options.maxRuntimeMs, maxOutputBytes: this.#options.maxOutputBytes });
      const opening = this.#options.host.open(intent, active);
      // A late open must not leak a worker after its caller has stopped waiting.
      void opening.then(async late => {
        if (active.aborted && lease !== late) {
          this.#unusable = true; late.rpc.close();
          let lateStatus: DriverStatus = caller?.aborted ? 'cancelled' : expiry?.aborted ? 'denied' : 'timed-out';
          try { await bounded(late.stop(), AbortSignal.timeout(1000)); } catch { lateStatus = 'indeterminate'; }
          await bounded(late.finish({ status: lateStatus, viewDigest }), AbortSignal.timeout(1000));
        }
      }).catch(() => { this.#unusable = true; });
      try { lease = await bounded(opening, active); }
      catch { if (active.aborted) this.#unusable = true; throw new DriverError('denied'); }
      string(lease.receiptId, 256); receipts.push(lease.receiptId);
      unlistenFailure = lease.rpc.onFailure(fault);
      unlistenNotification = lease.rpc.onNotification(event => { try { consume(event); } catch (error) { fault(error); } });
      lease.rpc.onRequest(async request => {
        if (events.length < 256) events.push({ type: 'request-denied', id: request.method });
        fault(new DriverError('denied'));
        return denyRequest(request.method);
      });
      await live();
      const initialized = record(await wait(lease.rpc.request('initialize', initializeParams)));
      string(initialized.userAgent, 4096);
      await live(); await wait(lease.rpc.notify('initialized', {}));
      const started = await wait(lease.rpc.request('thread/start', threadParams(intent, serialize(context.view.protected))));
      threadId = verifyThread(started, intent); events.push({ type: 'session-started', id: threadId });
      await live();
      const inventory = record(await wait(lease.rpc.request('mcpServerStatus/list', { threadId, limit: 100, cursor: null })));
      if (!Array.isArray(inventory.data) || inventory.data.length || inventory.nextCursor != null) throw new DriverError('denied');
      await live(); // Last host fencing check before the potentially billable action.
      const turn = record(record(await wait(lease.rpc.request('turn/start', turnParams(intent, threadId, serialize(context.view))))).turn);
      string(turn.id, 128);
      if (!['inProgress', 'completed', 'failed', 'interrupted'].includes(String(turn.status))) throw new DriverError('protocol-error');
      turnId = turn.id; events.push({ type: 'turn-started', id: turnId });
      for (const event of queue) consume(event); queue.length = 0;
      const completed = await wait(done);
      status = completed.status as DriverResult['status'];
      await live();
      const output = status === 'completed' ? [...messages.values()].join('\n') : '';
      for (const [id, text] of messages) if (status === 'completed') events.push({ type: 'message', id, text });
      result = { status, threadId, turnId, output, outputDigest: digest(output), viewDigest, receipts, events };
    } catch (error) {
      failure = caller?.aborted ? new DriverError('cancelled') : expiry?.aborted ? new DriverError('denied') : active.aborted ? new DriverError('timed-out') : error;
      status = failure instanceof DriverError && ['denied', 'cancelled', 'timed-out'].includes(failure.code) ? failure.code as DriverStatus : 'failed';
      // Interruption is best-effort; host teardown remains required even without a turn ID.
      if (lease && threadId && turnId) {
        try { await bounded(lease.rpc.request('turn/interrupt', { threadId, turnId }), AbortSignal.timeout(250)); } catch { /* stop below */ }
      }
    } finally {
      if (lease) {
        if (fatal && !failure) { failure = fatal; status = fatal instanceof DriverError && fatal.code === 'denied' ? 'denied' : 'failed'; }
        unlistenFailure?.(); unlistenNotification?.(); lease.rpc.close();
        try { await bounded(lease.stop(), AbortSignal.timeout(1000)); }
        catch { this.#unusable = true; status = 'indeterminate'; failure = new DriverError('cleanup-failed'); }
        try {
          const receipt = await bounded(lease.finish({ status, viewDigest, ...(result && !failure ? { outputDigest: result.outputDigest } : {}) }), AbortSignal.timeout(1000));
          string(receipt, 256); receipts.push(receipt);
        } catch { failure = new DriverError('receipt-failed'); }
      }
      this.#busy = false;
    }
    if (failure) throw failure;
    return freeze(result!);
  }
}
