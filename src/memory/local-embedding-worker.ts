import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localEmbeddingLimits, verifyLocalEmbedding } from './local-embedding.js';
import { normalizeVector } from './semantic.js';

// Separate permission process: no network grant, writes or subprocess execution.
async function main(): Promise<void> {
  if (!process.permission || process.permission.has('net') || process.permission.has('fs.write') || process.permission.has('child')) {
    throw new Error('offline embedding permission boundary unavailable');
  }
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > localEmbeddingLimits.transportBytes) throw new Error('embedding input budget exceeded');
  }
  const { config: raw, text } = JSON.parse(input) as { config: unknown; text: unknown };
  const config = verifyLocalEmbedding(raw);
  if (typeof text !== 'string' || !text.trim() || text.includes('\0') || Buffer.byteLength(text) > localEmbeddingLimits.recordTextBytes) throw new Error('invalid embedding text');
  globalThis.fetch = async () => { throw new Error('embedding network prohibited'); };
  const { env, pipeline } = await import(pathToFileURL(join(config.runtimeDirectory, 'dist/transformers.node.mjs')).href);
  env.allowRemoteModels = false; env.allowLocalModels = true;
  env.localModelPath = dirname(dirname(config.modelDirectory)) + '/';
  env.useFSCache = false; env.useBrowserCache = false;
  const extractor = await pipeline('feature-extraction', config.model, { revision: config.revision,
    local_files_only: true, device: 'cpu', dtype: 'q8',
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } });
  try {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    if (output.data.length !== 384) throw new Error('embedding output dimension mismatch');
    const vector = normalizeVector(Array.from(output.data) as number[], 384);
    verifyLocalEmbedding(config);
    process.stdout.write(JSON.stringify(vector));
  } finally { await extractor.dispose(); }
}
try { await main(); }
catch (error) {
  const reason = error instanceof Error && error.message === 'offline embedding permission boundary unavailable'
    ? 'permission boundary unavailable' : 'cache integrity or CPU runtime failure';
  process.stderr.write('Pinned offline embedding failed: ' + reason + '.\n'); process.exitCode = 2;
}
