import { isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { ProjectMemory } from '../memory/service.js';
import { SemanticMemory } from '../memory/semantic.js';
import { createLocalEmbeddingProvider, localEmbeddingConfig, readLocalEmbeddingConfig } from '../memory/local-embedding.js';

const usage = [
  'Explicit local-owner embeddings (default off; no downloads):',
  '  embedding-cli.js config --runtime /private/install/node_modules/@huggingface/transformers --model /private/models/Xenova/all-MiniLM-L6-v2',
  '  embedding-cli.js status [--config /private/embedding.json]',
  '  embedding-cli.js recall --workspace /canonical/project --state-dir /private/memory --query "durable checkpoints" [--config /private/embedding.json] [--mode semantic|hybrid] [--limit 1..10]',
  'Config prints verified JSON to stdout; save outside the project with mode 0600.',
  'Recall uses only current, owner-validated ProjectMemory. No ingestion or validation.',
  'Without --config, recall reports provider-needed. No global activation.', ''
].join('\n');
async function main(): Promise<void> {
  const [command, ...raw] = process.argv.slice(2);
  if (command === '--help') { process.stdout.write(usage); return; }
  const options: Record<string, string[]> = { config: ['runtime', 'model'], status: ['config'],
    recall: ['config', 'workspace', 'state-dir', 'query', 'mode', 'limit'] };
  if (!command || !Object.hasOwn(options, command)) throw new Error('unknown embedding command');
  const args: Record<string, string> = {};
  for (let i = 0; i < raw.length; i += 2) {
    const token = raw[i]!, key = token.slice(2), value = raw[i + 1];
    if (token !== '--' + key || !options[command]!.includes(key) || key in args || !value || value.startsWith('--')) throw new Error('invalid embedding arguments');
    args[key] = value;
  }
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (command === 'config') {
    if (!args.runtime || !args.model) throw new Error('missing explicit runtime/model paths');
    output(localEmbeddingConfig(args.runtime, args.model)); return;
  }
  let config;
  try { config = args.config === undefined ? undefined : readLocalEmbeddingConfig(args.config); }
  catch {
    output({ status: 'provider-needed', reason: 'Pinned local configuration/cache unavailable or invalid',
      action: 'Use config with an existing trusted Transformers 4.3.1 installation and pinned MiniLM cache; save private JSON and pass --config. No downloads attempted.' });
    process.exitCode = 2; return;
  }
  const provider = createLocalEmbeddingProvider(config);
  if (command === 'status') {
    output({ status: provider ? 'ready' : 'provider-needed', provider: provider?.identity ?? null,
      inspection: 'artifact-pins-only; inference not run', action: provider ? 'Pass this config to recall' : 'Create explicit private config; pass --config. No global activation.' }); return;
  }
  if (!args.workspace || !args['state-dir'] || !args.query || !isAbsolute(args.workspace) || !isAbsolute(args['state-dir'])) throw new Error('explicit absolute workspace and state directory required');
  if (args.mode !== undefined && !['semantic', 'hybrid'].includes(args.mode) || args.limit !== undefined && !/^(?:[1-9]|10)$/.test(args.limit)) throw new Error('invalid recall mode/limit');
  // Baseline exposes ProjectMemory, not a currentProjectMemory factory.
  const currentProjectMemory = new ProjectMemory(args['state-dir'], realpathSync(args.workspace));
  try {
    output(await new SemanticMemory(currentProjectMemory, provider).search(args.query,
      args.mode === 'semantic' ? 'semantic' : 'hybrid', Number(args.limit ?? 10)));
  } finally { currentProjectMemory.close(); }
}
try { await main(); }
catch {
  process.stderr.write('Embedding command failed. Check explicit arguments, current project sources, private state and pinned offline CPU runtime. Use --help.\n');
  process.exitCode = 2;
}
