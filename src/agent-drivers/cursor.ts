import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import type { OptimizationInput } from '../context-engine/contracts.js';
import { PassThroughContextOptimizer } from '../context-engine/optimizer.js';
import { bytes, digest, freeze, positive, serialize, snapshot, string } from '../context-engine/validation.js';
import { DriverError } from './contracts.js';
import type { AgentDriver, CursorConfiguration, CursorIntent, DriverEvent, DriverHost, DriverLease, DriverResult, DriverStatus } from './contracts.js';
import { configState, configurationSnapshot, CURSOR_VERSION, cursorInitialize, denyCursorRequest, record, verifyConfiguration, verifyInitialize } from './cursor-wire.js';

export interface CursorOptions {
  workspaceRoot: string; model: string; configuration: CursorConfiguration;
  host: DriverHost; optimizer: PassThroughContextOptimizer;
  maxRuntimeMs: number; maxOutputBytes: number; clock?: () => number;
}
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw new DriverError('cancelled'); }
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new DriverError('cancelled')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([promise, interrupted]); } finally { signal.removeEventListener('abort', abort); }
}
/** One fresh, text-only ACP session. Authentication and live provider access are disabled. */
export class CursorDriver implements AgentDriver {
  readonly capabilities = Object.freeze({ protocol: 'cursor-acp-stdio', protocolVersion: 1, cliVersion: CURSOR_VERSION,
    nativeResume: false, writes: false, mcpInjection: false, subagents: false, nativeEphemeral: false, liveConformance: false });
  readonly #options: CursorOptions;
  #used = false;
  constructor(options: CursorOptions) {
    string(options.model, 256); string(options.workspaceRoot);
    if (!isAbsolute(options.workspaceRoot) || realpathSync(options.workspaceRoot) !== options.workspaceRoot ||
        !options.host || typeof options.host.open !== 'function' || !(options.optimizer instanceof PassThroughContextOptimizer)) throw new DriverError('invalid-input');
    positive(options.maxRuntimeMs, 60000); positive(options.maxOutputBytes, 1024 * 1024);
    this.#options = Object.freeze({ ...options, configuration: configurationSnapshot(options.configuration, options.model) });
  }
  async run(raw: OptimizationInput, caller?: AbortSignal): Promise<DriverResult> {
    if (this.#used) throw new DriverError('busy'); this.#used = true;
    const deadline = AbortSignal.timeout(this.#options.maxRuntimeMs);
    let expiry: AbortSignal | undefined, active = caller ? AbortSignal.any([caller, deadline]) : deadline;
    let lease: DriverLease | undefined, sessionId = '', turnId = '', viewDigest = '', output = '';
    let status: DriverStatus = 'failed', failure: unknown, result: DriverResult | undefined;
    let phase: 'startup' | 'configure' | 'prompt' | 'terminal' = 'startup';
    let updateCount = 0, rawExpiry = 0;
    let observedConfig: unknown;
    const applied = new Map<string, string>();
    let modeObserved: string | undefined;
    let unlistenFailure: (() => void) | undefined, unlistenNotification: (() => void) | undefined;
    const events: DriverEvent[] = [], receipts: string[] = [];
    let fatal: unknown, rejectFatal!: (error: unknown) => void;
    const failed = new Promise<never>((_, reject) => { rejectFatal = reject; }); void failed.catch(() => {});
    const fault = (error: unknown) => { fatal ??= error; rejectFatal(error); };
    const wait = <T>(promise: Promise<T>, signal = active) => bounded(Promise.race([promise, failed]), signal);
    const live = async () => {
      if (fatal) throw fatal; active.throwIfAborted();
      try { await wait(lease!.check(active)); } catch { throw new DriverError('denied'); }
      if (fatal) throw fatal;
      if (rawExpiry <= (this.#options.clock ?? Date.now)()) throw new DriverError('denied');
    };
    try {
      const packet = snapshot(raw); rawExpiry = packet.expiresAt;
      const remaining = rawExpiry - (this.#options.clock ?? Date.now)();
      if (remaining <= 0) throw new DriverError('denied');
      expiry = AbortSignal.timeout(Math.min(remaining, 2147483647)); active = AbortSignal.any([active, expiry]); active.throwIfAborted();
      const context = await bounded(this.#options.optimizer.optimize(packet, active), active);
      viewDigest = context.viewDigest; receipts.push(...context.authorizationReceipts);
      const intent: CursorIntent = freeze({ driver: 'cursor', scope: structuredClone(packet.scope), expiresAt: rawExpiry,
        workspaceRoot: this.#options.workspaceRoot, model: this.#options.model, provider: 'cursor', cliVersion: CURSOR_VERSION,
        protocolVersion: 1, sessionMode: 'ask', mode: 'read-only', ephemeral: false, persistence: 'private-scratch', configuration: this.#options.configuration,
        viewDigest, maxRuntimeMs: this.#options.maxRuntimeMs, maxOutputBytes: this.#options.maxOutputBytes });
      const opening = this.#options.host.open(intent, active);
      void opening.then(async late => {
        if (active.aborted && lease !== late) {
          late.rpc.close(); let terminal: DriverStatus = caller?.aborted ? 'cancelled' : expiry?.aborted ? 'denied' : 'timed-out';
          try { await bounded(late.stop(), AbortSignal.timeout(1000)); } catch { terminal = 'indeterminate'; }
          await bounded(late.finish({ status: terminal, viewDigest }), AbortSignal.timeout(1000));
        }
      }).catch(() => {});
      try { lease = await bounded(opening, active); } catch { throw new DriverError('denied'); }
      string(lease.receiptId, 256); receipts.push(lease.receiptId);
      if (!lease.rpc.strictJsonrpc) throw new DriverError('denied');
      unlistenFailure = lease.rpc.onFailure(fault);
      lease.rpc.onRequest(async request => {
        if (events.length < 256) events.push({ type: 'request-denied', id: request.method });
        fault(new DriverError('denied'));
        if (active.aborted && request.method === 'session/request_permission') return { result: { outcome: { outcome: 'cancelled' } } };
        return denyCursorRequest(request.method, request.params);
      });
      unlistenNotification = lease.rpc.onNotification(event => {
        try {
          if (++updateCount > 512) throw new DriverError('output-limit');
          if (event.method !== 'session/update') throw new DriverError('denied');
          const params = record(event.params); string(params.sessionId, 128);
          if (!sessionId || params.sessionId !== sessionId) throw new DriverError('denied');
          const update = record(params.update);
          if (phase === 'terminal') throw new DriverError('protocol-error');
          if (update.sessionUpdate === 'agent_message_chunk') {
            if (phase !== 'prompt') throw new DriverError('protocol-error');
            const content = record(update.content);
            if (content.type !== 'text') throw new DriverError('denied'); string(content.text, this.#options.maxOutputBytes, true);
            output += content.text;
            if (bytes(output) > this.#options.maxOutputBytes) throw new DriverError('output-limit');
          } else if (update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'user_message_chunk') {
            if (phase !== 'prompt') throw new DriverError('protocol-error'); // Never export reasoning or echo as agent output.
          } else if (update.sessionUpdate === 'config_option_update') {
            const state = configState(update.configOptions, this.#options.configuration);
            if ([...applied].some(([id, value]) => state.get(id) !== value)) throw new DriverError('denied');
            modeObserved = state.get(this.#options.configuration.modeOptionId); observedConfig = update.configOptions;
            if (phase === 'prompt') verifyConfiguration(observedConfig, this.#options.configuration);
          } else if (update.sessionUpdate === 'current_mode_update') {
            string(update.currentModeId, 128); modeObserved = update.currentModeId;
            if ((phase === 'prompt' || applied.has(this.#options.configuration.modeOptionId)) && modeObserved !== 'ask') throw new DriverError('denied');
          } else if (!['available_commands_update', 'session_info_update', 'usage_update'].includes(String(update.sessionUpdate))) throw new DriverError('denied');
        } catch (error) { fault(error); }
      });
      await live(); verifyInitialize(await wait(lease.rpc.request('initialize', cursorInitialize)));
      await live();
      await wait(lease.rpc.request('session/new', { cwd: intent.workspaceRoot, mcpServers: [] }, raw => {
        const created = record(raw); string(created.sessionId, 128); sessionId = created.sessionId; phase = 'configure';
        observedConfig = created.configOptions; modeObserved = configState(observedConfig, intent.configuration).get(intent.configuration.modeOptionId);
      }));
      events.push({ type: 'session-started', id: sessionId });
      for (const setting of intent.configuration.options) {
        const current = configState(observedConfig, intent.configuration);
        if (current.get(setting.configId) !== setting.value) {
          await live();
          await wait(lease.rpc.request('session/set_config_option', { sessionId, configId: setting.configId, value: setting.value }, raw => {
            const configured = record(raw); observedConfig = configured.configOptions;
            applied.set(setting.configId, setting.value);
            const state = configState(observedConfig, intent.configuration);
            modeObserved = state.get(intent.configuration.modeOptionId);
            if ([...applied].some(([id, value]) => state.get(id) !== value)) throw new DriverError('denied');
          }));
        }
        applied.set(setting.configId, setting.value);
        const state = configState(observedConfig, intent.configuration);
        if ([...applied].some(([id, value]) => state.get(id) !== value)) throw new DriverError('denied');
      }
      verifyConfiguration(observedConfig, intent.configuration);
      await live(); verifyConfiguration(observedConfig, intent.configuration);
      if (modeObserved !== 'ask') throw new DriverError('denied');
      turnId = randomUUID(); phase = 'prompt'; events.push({ type: 'turn-started', id: turnId });
      const terminal = record(await wait(lease.rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: serialize(context.view) }] }, () => { phase = 'terminal'; })));
      phase = 'terminal';
      if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(String(terminal.stopReason))) throw new DriverError('protocol-error');
      if (terminal.stopReason === 'refusal') throw new DriverError('denied');
      status = terminal.stopReason === 'end_turn' ? 'completed' : 'interrupted';
      await live();
      if (status !== 'completed') output = '';
      if (status === 'completed') events.push({ type: 'message', id: turnId, text: output });
      result = { status, threadId: sessionId, turnId, output, outputDigest: digest(output), viewDigest, receipts, events };
    } catch (error) {
      failure = caller?.aborted ? new DriverError('cancelled') : expiry?.aborted ? new DriverError('denied') : active.aborted ? new DriverError('timed-out') : error;
      status = failure instanceof DriverError && ['denied', 'cancelled', 'timed-out'].includes(failure.code) ? failure.code as DriverStatus : 'failed';
      if (lease && sessionId) { try { await bounded(lease.rpc.notify('session/cancel', { sessionId }), AbortSignal.timeout(250)); } catch { /* stop remains required */ } }
    } finally {
      if (lease) {
        if (fatal && !failure) { failure = fatal; status = fatal instanceof DriverError && fatal.code === 'denied' ? 'denied' : 'failed'; }
        unlistenFailure?.(); unlistenNotification?.(); lease.rpc.close();
        try { await bounded(lease.stop(), AbortSignal.timeout(1000)); }
        catch { status = 'indeterminate'; failure = new DriverError('cleanup-failed'); }
        try {
          const receipt = await bounded(lease.finish({ status, viewDigest, ...(result && !failure ? { outputDigest: result.outputDigest } : {}) }), AbortSignal.timeout(1000));
          string(receipt, 256); receipts.push(receipt);
        } catch { failure = new DriverError('receipt-failed'); }
      }
    }
    if (failure) throw failure;
    return freeze(result!);
  }
}
