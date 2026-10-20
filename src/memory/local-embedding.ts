import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { normalizeVector } from './semantic.js';
import type { EmbeddingIdentity, EmbeddingProvider, EmbeddingRequest } from './semantic-contracts.js';

export const localEmbeddingPins = Object.freeze({
  model: 'Xenova/all-MiniLM-L6-v2', revision: 'cb3d680149bf9a3209564e1b27ab3bb355b65707',
  engine: '@huggingface/transformers', engineVersion: '4.3.1', dimensions: 384, device: 'cpu', dtype: 'q8',
  moduleSha256: 'af55cea9ad097b6aaef7e8c8ba8fd3aa6ae383e47584bfa5162e240859b232c3'
} as const);
export const localModelFiles = Object.freeze([
  ['config.json', 650, '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7'],
  ['tokenizer.json', 711661, 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0'],
  ['tokenizer_config.json', 366, '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3'],
  ['special_tokens_map.json', 125, 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3'],
  ['onnx/model_quantized.onnx', 22972370, 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1']
].map(([path, bytes, sha256]) => Object.freeze({ path: path as string, bytes: bytes as number, sha256: sha256 as string })));
// JSON strings expand by at most six bytes per UTF-8 input byte (\u00XX).
const { moduleSha256: _transportPin, ...transportPins } = localEmbeddingPins;
const recordTextBytes = 32768, queryTextBytes = 2048, pathBytes = 4096;
const transportFramingBytes = Buffer.byteLength(JSON.stringify({ config: {
  schemaVersion: 1, enabled: true, ...transportPins, runtimeDirectory: '', modelDirectory: ''
}, text: '' }));
export const localEmbeddingLimits = Object.freeze({ recordTextBytes, queryTextBytes, pathBytes,
  transportFramingBytes, transportBytes: transportFramingBytes + 6 * (recordTextBytes + 2 * pathBytes) });
export interface LocalEmbeddingConfig {
  readonly schemaVersion: 1;
  readonly enabled: true;
  readonly model: typeof localEmbeddingPins.model;
  readonly revision: typeof localEmbeddingPins.revision;
  readonly engine: typeof localEmbeddingPins.engine;
  readonly engineVersion: typeof localEmbeddingPins.engineVersion;
  readonly dimensions: 384;
  readonly device: 'cpu';
  readonly dtype: 'q8';
  /** Explicit trusted owner installation, including native dependencies. */
  readonly runtimeDirectory: string;
  readonly modelDirectory: string;
}
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const artifactDigest = sha(JSON.stringify({ pins: localEmbeddingPins, files: localModelFiles }));
export const localEmbeddingIdentity: Readonly<EmbeddingIdentity> = Object.freeze({
  model: localEmbeddingPins.model,
  version: localEmbeddingPins.revision + ':transformers@4.3.1:q8-cpu:' + artifactDigest, dimensions: 384
});
function plain(raw: unknown): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype || Object.getOwnPropertySymbols(raw).length ||
      Object.values(Object.getOwnPropertyDescriptors(raw)).some(d => d.get || d.set || !d.enumerable)) throw new Error('invalid local embedding configuration');
}
/** Component layout only; canonical paths and owner checks remain separate. */
export function hasLocalEmbeddingLayout(runtimeDirectory: string, modelDirectory: string,
  paths: Readonly<Pick<typeof import('node:path'), 'basename' | 'dirname'>> = { basename, dirname }): boolean {
  const suffix = (path: string, components: readonly string[]): boolean => {
    for (const component of [...components].reverse()) {
      if (paths.basename(path) !== component) return false;
      path = paths.dirname(path);
    }
    return true;
  };
  return suffix(runtimeDirectory, ['node_modules', '@huggingface', 'transformers']) &&
    suffix(modelDirectory, localEmbeddingPins.model.split('/'));
}

function owned(path: string, directory: boolean): void {
  if (typeof process.getuid !== 'function') throw new Error('local embedding ownership checks unavailable');
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error('canonical local embedding path required');
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (stat.mode & 0o022) || stat.uid !== process.getuid()) throw new Error('trusted owner embedding path required');
}
/** Inspection performs no import, download, cache write or environment mutation. */
export function verifyLocalEmbedding(raw: unknown): Readonly<LocalEmbeddingConfig> {
  plain(raw);
  const { moduleSha256: _module, ...pins } = localEmbeddingPins;
  const settings = { schemaVersion: 1, enabled: true, ...pins };
  const keys = [...Object.keys(settings), 'runtimeDirectory', 'modelDirectory'];
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key)) ||
      Object.entries(settings).some(([key, value]) => raw[key] !== value)) throw new Error('local embedding pins/configuration mismatch');
  for (const key of ['runtimeDirectory', 'modelDirectory']) {
    if (typeof raw[key] !== 'string' || !raw[key] || Buffer.byteLength(raw[key]) > localEmbeddingLimits.pathBytes) throw new Error('explicit local embedding paths required');
    owned(raw[key], true);
  }
  const config = Object.freeze({ ...raw }) as unknown as Readonly<LocalEmbeddingConfig>;
  if (!hasLocalEmbeddingLayout(config.runtimeDirectory, config.modelDirectory)) throw new Error('unexpected local embedding layout');
  const module = join(config.runtimeDirectory, 'dist/transformers.node.mjs');
  owned(module, false);
  if (lstatSync(module).size > 16777216 || sha(readFileSync(module)) !== localEmbeddingPins.moduleSha256) throw new Error('local runtime module pin mismatch');
  const packageFile = join(config.runtimeDirectory, 'package.json'); owned(packageFile, false);
  if (lstatSync(packageFile).size > 65536) throw new Error('runtime metadata budget exceeded');
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8')) as { name?: string; version?: string };
  if (pkg.name !== localEmbeddingPins.engine || pkg.version !== localEmbeddingPins.engineVersion) throw new Error('local runtime version mismatch');
  const paths: string[] = [];
  for (const entry of readdirSync(config.modelDirectory)) {
    const path = join(config.modelDirectory, entry);
    if (entry === 'onnx') {
      owned(path, true);
      for (const child of readdirSync(path)) paths.push('onnx/' + child);
    } else paths.push(entry);
  }
  if (JSON.stringify(paths.sort()) !== JSON.stringify(localModelFiles.map(f => f.path).sort())) throw new Error('unexpected model artifacts/custom code');
  for (const file of localModelFiles) {
    const path = join(config.modelDirectory, file.path); owned(path, false);
    if (lstatSync(path).size !== file.bytes || sha(readFileSync(path)) !== file.sha256) throw new Error('local model artifact pin mismatch: ' + file.path);
  }
  return config;
}
export function localEmbeddingConfig(runtimeDirectory: string, modelDirectory: string): Readonly<LocalEmbeddingConfig> {
  const { moduleSha256: _module, ...pins } = localEmbeddingPins;
  return verifyLocalEmbedding({ schemaVersion: 1, enabled: true, ...pins, runtimeDirectory, modelDirectory });
}
export function readLocalEmbeddingConfig(path: string): Readonly<LocalEmbeddingConfig> {
  owned(path, false);
  if ((lstatSync(path).mode & 0o077) || lstatSync(path).size > 16384) throw new Error('embedding configuration must be private and bounded');
  return verifyLocalEmbedding(JSON.parse(readFileSync(path, 'utf8')));
}
export type TrustedEmbeddingBackend = (text: string) => Promise<readonly number[]>;
/** Trusted injection seam. Synthetic tests must not claim real-model quality. */
export function boundLocalEmbeddingBackend(identity: Readonly<EmbeddingIdentity>, backend: TrustedEmbeddingBackend): EmbeddingProvider {
  const fixed = Object.freeze({ ...identity });
  return Object.freeze({ identity: fixed, async embed(request: Readonly<EmbeddingRequest>) {
    if (!request || request.schemaVersion !== 1 || request.indexVersion !== 'project-semantic-v1' ||
        !['query', 'record'].includes(request.purpose) || request.provider.model !== fixed.model ||
        request.provider.version !== fixed.version || request.provider.dimensions !== fixed.dimensions ||
        typeof request.projectId !== 'string' || !request.projectId.trim() || Buffer.byteLength(request.projectId) > 1024 ||
        typeof request.workspaceRoot !== 'string' || !isAbsolute(request.workspaceRoot) || Buffer.byteLength(request.workspaceRoot) > 4096 ||
        typeof request.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(request.bindingDigest) ||
        typeof request.text !== 'string' || !request.text.trim() || request.text.includes('\0') ||
        Buffer.byteLength(request.text) > (request.purpose === 'query' ? localEmbeddingLimits.queryTextBytes : localEmbeddingLimits.recordTextBytes)) throw new Error('invalid bounded embedding request');
    return normalizeVector(await backend(request.text), fixed.dimensions);
  } });
}
function runOffline(config: Readonly<LocalEmbeddingConfig>, text: string): Promise<readonly number[]> {
  const input = JSON.stringify({ config, text });
  if (Buffer.byteLength(input) > localEmbeddingLimits.transportBytes) return Promise.reject(new Error('embedding input budget exceeded'));
  return new Promise((accept, reject) => {
    const worker = fileURLToPath(new URL('./local-embedding-worker.js', import.meta.url));
    const child = spawn(process.execPath, ['--permission', '--allow-addons',
      '--allow-fs-read=' + resolve(dirname(worker), '..'),
      '--allow-fs-read=' + resolve(config.runtimeDirectory, '../..'),
      '--allow-fs-read=' + config.modelDirectory, worker], { stdio: ['pipe', 'pipe', 'pipe'], env: { LANG: 'C.UTF-8', TZ: 'UTC' } });
    let output = '', diagnostics = '', finished = false;
    const finish = (error?: Error, vector?: readonly number[]) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else accept(vector!);
    };
    const timer = setTimeout(() => finish(new Error('offline embedding timed out')), 45000);
    child.on('error', () => finish(new Error('offline embedding process unavailable')));
    child.stdin.on('error', () => finish(new Error('offline embedding input failed')));
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8'); if (Buffer.byteLength(output) > 65536) finish(new Error('offline embedding output budget exceeded'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostics += chunk.toString('utf8'); if (Buffer.byteLength(diagnostics) > 65536) finish(new Error('offline embedding diagnostic budget exceeded'));
    });
    child.on('close', code => {
      if (code !== 0) { finish(new Error('offline embedding failed; verify pinned cache and local CPU runtime')); return; }
      try { finish(undefined, normalizeVector(JSON.parse(output) as number[], 384)); }
      catch { finish(new Error('offline embedding returned invalid vector')); }
    });
    child.stdin.end(input);
  });
}
/** Default off. Missing configuration never substitutes fabricated vectors. */
export function createLocalEmbeddingProvider(raw?: unknown): EmbeddingProvider | undefined {
  if (raw === undefined) return undefined;
  const config = verifyLocalEmbedding(raw);
  return boundLocalEmbeddingBackend(localEmbeddingIdentity, async text => {
    verifyLocalEmbedding(config); return runOffline(config, text);
  });
}
