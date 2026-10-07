import { PassThrough } from 'node:stream';
import { realpathSync } from 'node:fs';
import { JsonlRpc } from '../../src/agent-drivers/jsonl-rpc.js';
import { PassThroughContextOptimizer } from '../../src/context-engine/optimizer.js';
import { CodexDriver } from '../../src/agent-drivers/codex.js';
import { DriverError } from '../../src/agent-drivers/contracts.js';
import type { DriverHost, DriverIntent, DriverTerminal } from '../../src/agent-drivers/contracts.js';
import { hostFixture, input } from '../context-engine/fixture.js';
const workspaceRoot = realpathSync(process.cwd());

export function rpcFixture(options: Partial<ConstructorParameters<typeof JsonlRpc>[2]> = {}) {
  const incoming = new PassThrough(), outgoing = new PassThrough();
  const rpc = new JsonlRpc(incoming, outgoing, { timeoutMs: 50, maxLineBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, ...options });
  const sent: Record<string, unknown>[] = [];
  let handle: ((request: Record<string, unknown>) => void) | undefined;
  let buffer = '';
  outgoing.on('data', chunk => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const request = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
      buffer = buffer.slice(end + 1); sent.push(request); handle?.(request);
    }
  });
  return { rpc, sent, incoming, outgoing,
    receive(message: unknown) { incoming.write(JSON.stringify(message) + '\n'); },
    handle(handler: typeof handle) { handle = handler; },
    close() { rpc.close(); incoming.destroy(); outgoing.destroy(); } };
}
export interface FixtureOptions {
  onRequest?: (request: Record<string, unknown>, server: ReturnType<typeof rpcFixture>) => boolean;
  mutateThread?: (result: Record<string, unknown>) => void;
  afterCheck?: (count: number) => void;
  denied?: boolean;
  early?: boolean;
  terminalStatus?: 'completed' | 'failed' | 'interrupted';
  maxRuntimeMs?: number;
  maxOutputBytes?: number;
  finishFails?: boolean;
  stopFails?: boolean;
  openDelayMs?: number;
}
/** Explicit fixture authority; does not implement real process or spend authorization. */
export function driverFixture(options: FixtureOptions = {}) {
  const packet = input(); const context = hostFixture(packet);
  const server = rpcFixture();
  const opens: DriverIntent[] = [], terminals: DriverTerminal[] = [];
  let live = true, checks = 0, stops = 0;
  const turn = { id: 'turn-1', status: options.terminalStatus ?? 'completed', items: [{ id: 'message-1', type: 'agentMessage', text: 'Diagnosed E42' }] };
  const notify = () => {
    server.receive({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'untrusted intermediate' } });
    server.receive({ method: 'item/reasoning/textDelta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'private reasoning' } });
    server.receive({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: turn.items[0] } });
    server.receive({ method: 'turn/completed', params: { threadId: 'thread-1', turn } });
  };
  server.handle(request => {
    if (options.onRequest?.(request, server)) return;
    if (!request.method || !request.id) return;
    const reply = (result: unknown) => server.receive({ id: request.id, result });
    switch (request.method) {
      case 'initialize': reply({ userAgent: 'codex/0.160.0 fixture', codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux' }); break;
      case 'thread/start': {
        const params = request.params as Record<string, unknown>;
        const result = { model: params.model, modelProvider: 'openai', reasoningEffort: 'high', cwd: workspaceRoot, approvalPolicy: 'never', approvalsReviewer: 'user',
          sandbox: { type: 'readOnly', networkAccess: false }, serviceTier: 'default', instructionSources: [],
          thread: { id: 'thread-1', cliVersion: '0.160.0', ephemeral: true, cwd: workspaceRoot, modelProvider: 'openai' } };
        options.mutateThread?.(result); reply(result); break;
      }
      case 'mcpServerStatus/list': reply({ data: [], nextCursor: null }); break;
      case 'turn/start':
        if (options.early) notify();
        reply({ turn: { id: 'turn-1', status: 'inProgress', items: [] } });
        if (!options.early) queueMicrotask(notify);
        break;
      case 'turn/interrupt': reply({}); break;
      default: server.receive({ id: request.id, error: { code: -32601, message: 'unsupported' } });
    }
  });
  const host: DriverHost = { async open(intent, signal) {
    signal.throwIfAborted(); if (options.denied) throw new DriverError('denied');
    if (options.openDelayMs) await new Promise(resolve => setTimeout(resolve, options.openDelayMs));
    opens.push(structuredClone(intent));
    return { rpc: server.rpc, receiptId: 'fixture-start', async check(signal) {
      signal.throwIfAborted(); options.afterCheck?.(++checks); if (!live) throw new DriverError('denied');
    }, async finish(terminal) {
      terminals.push(structuredClone(terminal)); if (options.finishFails) throw new Error('storage unavailable'); return 'fixture-terminal';
    }, async stop() { stops++; server.close(); if (options.stopFails) throw new Error('not reaped'); } };
  } };
  const driver = new CodexDriver({ workspaceRoot, model: 'fixture-model', effort: 'high', host,
    optimizer: new PassThroughContextOptimizer(context), clock: context.clock,
    maxRuntimeMs: options.maxRuntimeMs ?? 1000, maxOutputBytes: options.maxOutputBytes ?? 65536 });
  return { packet, driver, server, opens, terminals, notify, revoke() { live = false; },
    get stops() { return stops; }, get checks() { return checks; } };
}
