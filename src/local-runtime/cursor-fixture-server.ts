import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Deterministic ACP subprocess. No provider, credentials, network or project tools.
let mode = 'agent';
const configOptions = () => [
  { id: 'fixture-model', name: 'Model', type: 'select', currentValue: 'fixture', options: [{ name: 'Fixture', value: 'fixture' }] },
  { id: 'fixture-mode', name: 'Mode', type: 'select', currentValue: mode, options: [{ name: 'Ask', value: 'ask' }, { name: 'Agent', value: 'agent' }] }
];
const send = (message: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line) as { jsonrpc: string; id?: number; method: string; params: Record<string, unknown> };
  if (request.jsonrpc !== '2.0') throw new Error('Invalid ACP frame');
  if (request.id === undefined) return;
  const reply = (result: unknown) => send({ id: request.id, result });
  switch (request.method) {
    case 'initialize': reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }); break;
    case 'session/new':
      // Exercise session persistence in private HOME rather than promise native ephemeral support.
      writeFileSync(join(process.env.HOME!, 'fixture-history'), 'synthetic session');
      reply({ sessionId: 'fixture-cursor', configOptions: configOptions() }); break;
    case 'session/set_config_option':
      if (request.params.configId !== 'fixture-mode' || request.params.value !== 'ask') throw new Error('Invalid fixture setting');
      mode = 'ask'; reply({ configOptions: configOptions() }); break;
    case 'session/prompt': {
      const view = JSON.parse((request.params.prompt as { text: string }[])[0]!.text);
      const text = `Fixture diagnosis: ${view.evidence[0].content.includes('E42') ? 'E42 retained' : 'missing error'}`;
      send({ method: 'session/update', params: { sessionId: 'fixture-cursor', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      reply({ stopReason: 'end_turn' }); break;
    }
    default: send({ id: request.id, error: { code: -32601, message: 'Unsupported fixture method' } });
  }
});
