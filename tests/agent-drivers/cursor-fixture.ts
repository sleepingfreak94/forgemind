import { CursorDriver } from '../../src/agent-drivers/cursor.js';
import { realpathSync } from 'node:fs';
import type { CursorConfiguration, DriverHost, DriverIntent, DriverTerminal } from '../../src/agent-drivers/contracts.js';
import { DriverError } from '../../src/agent-drivers/contracts.js';
import { PassThroughContextOptimizer } from '../../src/context-engine/optimizer.js';
import { hostFixture, input } from '../context-engine/fixture.js';
import { rpcFixture } from './fixture.js';
export const selection: CursorConfiguration = { modelOptionId: 'model-choice', modeOptionId: 'mode-choice',
  options: [{ configId: 'model-choice', value: 'fixture-model' }, { configId: 'mode-choice', value: 'ask' }] };
export function configOptions(model = 'fixture-model', mode = 'agent') {
  return [{ id: 'model-choice', name: 'Model', type: 'select', currentValue: model, options: [{ name: 'Fixture', value: 'fixture-model' }] },
    { id: 'mode-choice', name: 'Mode', type: 'select', currentValue: mode, options: [{ name: 'Ask', value: 'ask' }, { name: 'Agent', value: 'agent' }] }];
}
export interface CursorFixtureOptions {
  onRequest?: (request: Record<string, unknown>, server: ReturnType<typeof rpcFixture>) => boolean;
  stopReason?: string; stopFails?: boolean; finishFails?: boolean; openDelayMs?: number;
  afterCheck?: (count: number) => void; maxOutputBytes?: number; maxRuntimeMs?: number;
}
export function cursorFixture(options: CursorFixtureOptions = {}) {
  const packet = input(), context = hostFixture(packet);
  const server = rpcFixture({ timeoutMs: 50, maxLineBytes: 65536, maxTotalBytes: 1024 * 1024, strictJsonrpc: true });
  const receive = (message: unknown) => server.receive({ jsonrpc: '2.0', ...(message as object) });
  const update = (kind: string, fields: Record<string, unknown> = {}, sessionId = 'cursor-session') => receive({ method: 'session/update', params: { sessionId, update: { sessionUpdate: kind, ...fields } } });
  let config = configOptions(), checks = 0, stopped = 0, revoked = false;
  const terminals: DriverTerminal[] = [], opens: DriverIntent[] = [];
  server.handle(request => {
    if (options.onRequest?.(request, server)) return;
    if (request.id === undefined) return;
    const reply = (result: unknown) => receive({ id: request.id, result });
    const params = request.params as Record<string, unknown>;
    switch (request.method) {
      case 'initialize': reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }] }); break;
      case 'session/new': reply({ sessionId: 'cursor-session', configOptions: config }); break;
      case 'session/set_config_option':
        config = config.map(option => option.id === params.configId ? { ...option, currentValue: params.value as string } : option);
        reply({ configOptions: config }); break;
      case 'session/prompt':
        update('agent_thought_chunk', { content: { type: 'text', text: 'private reasoning' } });
        update('agent_message_chunk', { content: { type: 'text', text: 'Diagnosed ' } });
        update('agent_message_chunk', { content: { type: 'text', text: 'E42 ✓' } });
        reply({ stopReason: options.stopReason ?? 'end_turn' }); break;
      default: receive({ id: request.id, error: { code: -32601, message: 'Unsupported fixture method' } });
    }
  });
  const host: DriverHost = { async open(intent, signal) {
    signal.throwIfAborted(); if (options.openDelayMs) await new Promise(resolve => setTimeout(resolve, options.openDelayMs));
    opens.push(structuredClone(intent));
    return { rpc: server.rpc, receiptId: 'fixture-cursor-reservation', async check(current) {
      current.throwIfAborted(); options.afterCheck?.(++checks); if (revoked) throw new DriverError('denied');
    }, async stop() { stopped++; server.close(); if (options.stopFails) throw new Error('unreaped'); },
    async finish(terminal) { terminals.push(structuredClone(terminal)); if (options.finishFails) throw new Error('storage'); return 'fixture-cursor-terminal'; } };
  } };
  const driver = new CursorDriver({ workspaceRoot: realpathSync(process.cwd()), model: 'fixture-model', configuration: selection, host,
    optimizer: new PassThroughContextOptimizer(context), maxRuntimeMs: options.maxRuntimeMs ?? 1000,
    maxOutputBytes: options.maxOutputBytes ?? 65536, clock: context.clock });
  return { packet, context, server, receive, update, host, driver, terminals, opens, revoke() { revoked = true; }, get stopped() { return stopped; } };
}
