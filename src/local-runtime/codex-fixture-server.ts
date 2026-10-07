import { createInterface } from 'node:readline';

// Deterministic subprocess fixture. No model, file tool, network, or credentials.
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line) as { id?: number; method: string; params: Record<string, unknown> };
  if (request.id === undefined) return;
  const reply = (result: unknown) => send({ id: request.id, result });
  switch (request.method) {
    case 'initialize': reply({ userAgent: 'codex/0.160.0 deterministic-fixture' }); break;
    case 'thread/start': reply({ model: request.params.model, modelProvider: 'openai', reasoningEffort: 'high', cwd: process.cwd(),
      approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, serviceTier: 'default',
      instructionSources: [], thread: { id: 'fixture-thread', cliVersion: '0.160.0', ephemeral: true, cwd: process.cwd(), modelProvider: 'openai' } }); break;
    case 'mcpServerStatus/list': reply({ data: [], nextCursor: null }); break;
    case 'turn/start': {
      const view = JSON.parse((request.params.input as { text: string }[])[0]!.text);
      const item = { type: 'agentMessage', id: 'fixture-message', text: `Fixture diagnosis: ${view.evidence[0].content.includes('E42') ? 'E42 retained' : 'missing error'}` };
      reply({ turn: { id: 'fixture-turn', status: 'inProgress', items: [] } });
      send({ method: 'item/completed', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', item } });
      send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed', items: [item] } } }); break;
    }
    case 'turn/interrupt': reply({}); break;
    default: send({ id: request.id, error: { code: -32601, message: 'Unsupported fixture method' } });
  }
});
