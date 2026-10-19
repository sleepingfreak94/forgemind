/** Lossless selected evidence only; hashes prove structure, never authenticity. */
import { createHash } from 'node:crypto';
import { artifactFault, encodeOwnerJson, exactKeys, ownerArtifactDefaults, safeArtifactError,
  validateLimits } from './owner-artifact-contracts.js';
import type { OwnerArtifactBundle, OwnerArtifactReference, OwnerArtifactWriter, OwnerJson } from './owner-artifact-contracts.js';

const legacyName = 'terminal.json', indexName = 'terminal-index.json';
const schema = 'native-owner-capture-chunks';
// A base64 JSON string includes its two quotes. Never discount stored bytes.
const chunkBytes = 3 * Math.floor((ownerArtifactDefaults.artifactBytes - 2) / 4);
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const chunkName = (index: number): string => `terminal-chunk-${String(index).padStart(3, '0')}.json`;
interface Chunk {
  name: string;
  bytes: number;
  sha256: string;
  storedBytes: number;
  storedSha256: string;
}
interface Index {
  schema: typeof schema;
  version: 1;
  encoding: 'base64';
  bytes: number;
  sha256: string;
  chunks: Chunk[];
}
/** The existing writer accounts for all stored files, metadata and progress
 * reservations. A partial write is never an accepted capture. */
export function writeNativeCapture(writer: OwnerArtifactWriter, value: OwnerJson): void {
  try {
    const bytes = encodeOwnerJson(value, ownerArtifactDefaults.bundleBytes);
    if (bytes.length <= ownerArtifactDefaults.artifactBytes) {
      writer.writeJson(legacyName, value);
      return;
    }
    const index: Index = { schema, version: 1, encoding: 'base64', bytes: bytes.length,
      sha256: digest(bytes), chunks: [] };
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const body = bytes.subarray(offset, offset + chunkBytes);
      const ref = writer.writeJson(chunkName(index.chunks.length), body.toString('base64'));
      index.chunks.push({ name: ref.name, bytes: body.length, sha256: digest(body),
        storedBytes: ref.bytes, storedSha256: ref.sha256 });
    }
    writer.writeJson(indexName, index as unknown as OwnerJson);
  } catch (error) {
    try { writer.incomplete(); } catch { /* Failed writer already retains its veto. */ }
    throw safeArtifactError(error);
  }
}
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) artifactFault('INTEGRITY');
  exactKeys(value, keys);
  return value as Record<string, unknown>;
}
function count(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) artifactFault('INTEGRITY');
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) artifactFault('INTEGRITY');
  return value;
}
function parse(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { return artifactFault('JSON'); }
}
/** Read with readOwnerArtifactBundle first. This checks codec semantics as well
 * as references: the public bundle is evidence, not an execution capability.
 * Returns original JSON UTF-8 bytes, preserving order without reserialization. */
export function decodeNativeCapture(bundle: OwnerArtifactBundle): Buffer {
  try {
    const { manifest, files } = bundle, limits = manifest.attempt.limits;
    validateLimits(limits);
    if (manifest.version !== 1 || manifest.trust !== 'evidence-only' || manifest.files.length > limits.files - 1) artifactFault('INTEGRITY');
    const refs = new Map<string, OwnerArtifactReference>();
    let stored = encodeOwnerJson(manifest, limits.metadataBytes).length;
    for (const ref of manifest.files) {
      if (refs.has(ref.name)) artifactFault('INTEGRITY');
      const body = files.get(ref.name);
      const maximum = ref.kind === 'artifact' ? limits.artifactBytes : ref.kind === 'progress' ? 256 : limits.metadataBytes;
      if (!body || body.length !== count(ref.bytes, maximum) || digest(body) !== hash(ref.sha256)) artifactFault('INTEGRITY');
      stored += body.length;
      refs.set(ref.name, ref);
    }
    if (stored > limits.bundleBytes || files.size !== refs.size || [...files.keys()].some(name => !refs.has(name))) artifactFault('INTEGRITY');
    const artifacts = manifest.files.filter(ref => ref.kind === 'artifact');
    const codec = artifacts.filter(ref => ref.name === legacyName || ref.name === indexName || ref.name.startsWith('terminal-chunk-'));
    const legacy = files.get(legacyName);
    if (legacy) {
      if (codec.length !== 1 || codec[0]?.name !== legacyName) artifactFault('INTEGRITY');
      // Validate the restricted JSON domain, but return the original bytes.
      const clean = encodeOwnerJson(parse(legacy), limits.artifactBytes);
      if (!clean.equals(legacy)) artifactFault('INTEGRITY');
      return Buffer.from(legacy);
    }
    const indexBody = files.get(indexName);
    if (!indexBody || refs.get(indexName)?.kind !== 'artifact') artifactFault('INVENTORY');
    const index = object(parse(indexBody), 'bytes,chunks,encoding,schema,sha256,version');
    if (index.schema !== schema || index.version !== 1 || index.encoding !== 'base64') artifactFault('INTEGRITY');
    const total = count(index.bytes, limits.bundleBytes), wholeHash = hash(index.sha256);
    if (total <= ownerArtifactDefaults.artifactBytes || !Array.isArray(index.chunks) ||
        index.chunks.length !== Math.ceil(total / chunkBytes) || index.chunks.length + 1 !== codec.length) artifactFault('INTEGRITY');
    const chunks: Buffer[] = []; let recovered = 0;
    for (let i = 0; i < index.chunks.length; i++) {
      const chunk = object(index.chunks[i], 'bytes,name,sha256,storedBytes,storedSha256');
      const name = chunkName(i), ref = refs.get(name), body = files.get(name);
      const length = count(chunk.bytes, chunkBytes);
      if (chunk.name !== name || codec[i]?.name !== name || ref?.kind !== 'artifact' || !body ||
          body.length !== count(chunk.storedBytes, limits.artifactBytes) || digest(body) !== hash(chunk.storedSha256) ||
          length !== Math.min(chunkBytes, total - recovered)) artifactFault('INTEGRITY');
      const base64 = parse(body);
      if (typeof base64 !== 'string' || base64.length !== 4 * Math.ceil(length / 3)) artifactFault('INTEGRITY');
      const raw = Buffer.from(base64, 'base64');
      if (raw.length !== length || raw.toString('base64') !== base64 || digest(raw) !== hash(chunk.sha256) ||
          !encodeOwnerJson(base64, limits.artifactBytes).equals(body)) artifactFault('INTEGRITY');
      recovered += raw.length; chunks.push(raw);
    }
    if (codec.at(-1)?.name !== indexName || recovered !== total) artifactFault('INTEGRITY');
    const bytes = Buffer.concat(chunks, total);
    if (digest(bytes) !== wholeHash || !encodeOwnerJson(parse(bytes), limits.bundleBytes).equals(bytes)) artifactFault('INTEGRITY');
    return bytes;
  } catch (error) { throw safeArtifactError(error, 'INTEGRITY'); }
}
