/* Owner-selected evidence only. These contracts confer no execution authority.
 * Callers must select JSON bodies explicitly; never feed raw RPC, authentication,
 * account, reasoning, or automatic transcript streams into this store. */
import { types } from 'node:util';
export type OwnerJson = null | boolean | number | string | OwnerJson[] | { [key: string]: OwnerJson };
export type OwnerArtifactCode = 'IDENTITY' | 'PATH' | 'PRIVATE' | 'LIMIT' | 'JSON' | 'STATE' | 'INVENTORY' | 'INTEGRITY' | 'IO';
const errorCodes = new Set<string>(['IDENTITY', 'PATH', 'PRIVATE', 'LIMIT', 'JSON', 'STATE', 'INVENTORY', 'INTEGRITY', 'IO']);
const safeErrors = new WeakMap<object, OwnerArtifactCode>();
function validatedCode(code: unknown): OwnerArtifactCode {
  return typeof code === 'string' && errorCodes.has(code) ? code as OwnerArtifactCode : 'IO';
}
export class OwnerArtifactError extends Error {
  readonly code: OwnerArtifactCode;
  constructor(code: OwnerArtifactCode) {
    const validated = validatedCode(code);
    super(`OWNER_ARTIFACT_${validated}`);
    this.code = validated;
    this.name = 'OwnerArtifactError';
    safeErrors.set(this, validated);
  }
}
export function artifactFault(code: OwnerArtifactCode): never { throw new OwnerArtifactError(code); }
/** Never examine properties, prototypes, messages, or coercions of caught values. */
export function safeArtifactError(error: unknown, fallback: OwnerArtifactCode = 'IO'): OwnerArtifactError {
  const code = typeof error === 'object' && error !== null ? safeErrors.get(error) : undefined;
  return new OwnerArtifactError(code ?? validatedCode(fallback));
}
export interface OwnerArtifactLimits {
  artifactBytes: number;
  bundleBytes: number;
  files: number;
  metadataBytes: number;
  progressEvents: number;
  progressBytes: number;
  archiveAttempts: number;
  archiveBytes: number;
}
export const ownerArtifactDefaults: Readonly<OwnerArtifactLimits> = Object.freeze({
  artifactBytes: 2 * 1024 * 1024, bundleBytes: 16 * 1024 * 1024,
  files: 384, metadataBytes: 65536, progressEvents: 256, progressBytes: 65536,
  archiveAttempts: 32, archiveBytes: 512 * 1024 * 1024,
});
export interface OwnerArtifactScope {
  taskId: string;
  sourceSha256: string;
  requestSha256: string;
}
export interface OwnerArtifactDescriptor {
  version: 1;
  id: string;
  project: string;
  scope: OwnerArtifactScope;
  limits: OwnerArtifactLimits;
}
export interface OwnerArtifactReference {
  name: string;
  kind: 'descriptor' | 'artifact' | 'progress';
  bytes: number;
  sha256: string;
}
export interface OwnerArtifactManifest {
  version: 1;
  trust: 'evidence-only';
  attempt: OwnerArtifactDescriptor;
  files: OwnerArtifactReference[];
}
export interface OwnerArtifactProgress {
  stage: 'prepare' | 'execute' | 'validate' | 'persist';
  status: 'running' | 'incomplete';
  completed: number;
  total: number;
}
/** Trusted owner/test hook only; never wire this port to model/runtime input. */
export interface OwnerArtifactFaultPoint {
  operation: 'write' | 'file-sync' | 'directory-sync' | 'publish' | 'published' | 'final-directory-sync' | 'writer-prepare';
  name: string;
}
export interface OwnerArtifactOptions {
  root: string;
  project: string;
  scope: OwnerArtifactScope;
  limits?: OwnerArtifactLimits;
  fault?: (point: OwnerArtifactFaultPoint) => void;
}
export interface OwnerArtifactWriter {
  writeJson(name: string, value: OwnerJson): OwnerArtifactReference;
  progress(event: OwnerArtifactProgress): OwnerArtifactReference;
  accept(): OwnerArtifactManifest;
  incomplete(): void;
}
export type OwnerArtifactInspection = {
  state: 'incomplete';
  reason: 'unaccepted' | 'failed' | 'publication';
  attempt: OwnerArtifactDescriptor;
  names: string[];
} | { state: 'accepted'; manifest: OwnerArtifactManifest };
export interface OwnerArtifactBundle {
  manifest: OwnerArtifactManifest;
  files: ReadonlyMap<string, Buffer>;
}
export function exactKeys(value: object, expected: string): void {
  if (Object.keys(value).sort().join(',') !== expected) artifactFault('JSON');
}
export function artifactId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) artifactFault('PATH');
}
export function artifactName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}\.json$/.test(value) ||
      ['attempt.json', 'accepted.json', 'failure.json', 'accept-temp.json'].includes(value) || value.startsWith('progress-')) artifactFault('PATH');
}
export function validateLimits(value: OwnerArtifactLimits): void {
  exactKeys(value, 'archiveAttempts,archiveBytes,artifactBytes,bundleBytes,files,metadataBytes,progressBytes,progressEvents');
  for (const key of Object.keys(ownerArtifactDefaults) as (keyof OwnerArtifactLimits)[]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > ownerArtifactDefaults[key]) artifactFault('LIMIT');
  }
  if (value.metadataBytes < 1024 || value.progressBytes < 256 || value.progressEvents < 2 ||
      value.files < value.progressEvents + 5 || value.bundleBytes > value.archiveBytes) artifactFault('LIMIT');
}
export function validateScope(value: OwnerArtifactScope): void {
  exactKeys(value, 'requestSha256,sourceSha256,taskId');
  artifactId(value.taskId);
  if (!/^[a-f0-9]{64}$/.test(value.sourceSha256) || !/^[a-f0-9]{64}$/.test(value.requestSha256)) artifactFault('JSON');
}
export function validateProgress(value: OwnerArtifactProgress): void {
  exactKeys(value, 'completed,stage,status,total');
  if (!['prepare', 'execute', 'validate', 'persist'].includes(value.stage) ||
      !['running', 'incomplete'].includes(value.status) || !Number.isSafeInteger(value.completed) ||
      !Number.isSafeInteger(value.total) || value.completed < 0 || value.total < value.completed || value.total > 1000000000) artifactFault('JSON');
}
/** Descriptor traversal avoids getters/toJSON and preserves JSON.stringify's own
 * property order and UTF-8 encoding for the deliberately restricted JSON domain.
 * Proxies are rejected trap-free before any reflection, including prototypes. */
export function encodeOwnerJson(value: unknown, maximum: number): Buffer {
  try {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > ownerArtifactDefaults.bundleBytes) artifactFault('LIMIT');
    const parts: string[] = [], active = new Set<object>();
    let bytes = 0, nodes = 0;
    const emit = (text: string): void => {
      bytes += Buffer.byteLength(text);
      if (bytes > maximum) artifactFault('LIMIT');
      parts.push(text);
    };
    const primitiveString = (text: string): void => {
      if (text.length > maximum) artifactFault('LIMIT');
      emit(JSON.stringify(text));
    };
    const visit = (item: unknown, depth: number): void => {
      if (++nodes > 100000 || depth > 64) artifactFault('LIMIT');
      if (item === null) { emit('null'); return; }
      if (typeof item === 'string') { primitiveString(item); return; }
      if (typeof item === 'boolean') { emit(item ? 'true' : 'false'); return; }
      if (typeof item === 'number' && Number.isFinite(item)) { emit(JSON.stringify(item)); return; }
      if (typeof item !== 'object' || item === null || active.has(item)) artifactFault('JSON');
      if (types.isProxy(item)) artifactFault('JSON');
      const array = Array.isArray(item), prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) artifactFault('JSON');
      // Also reject inherited serialization hooks without invoking them.
      let prototypes = 0;
      for (let p: object | null = item; p !== null; p = Object.getPrototypeOf(p) as object | null) {
        if (++prototypes > 64 || types.isProxy(p)) artifactFault('JSON');
        if (Object.getOwnPropertyDescriptor(p, 'toJSON')) artifactFault('JSON');
      }
      const keys = Reflect.ownKeys(item);
      if (keys.length > 100001) artifactFault('LIMIT');
      const descriptors = new Map<string, PropertyDescriptor>();
      for (const key of keys) {
        if (typeof key !== 'string') artifactFault('JSON');
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor) || (!descriptor.enumerable && !(array && key === 'length'))) artifactFault('JSON');
        descriptors.set(key, descriptor);
      }
      active.add(item);
      emit(array ? '[' : '{');
      const length: unknown = descriptors.get('length')?.value;
      const names = array ? [] : [...descriptors.keys()];
      if (array) {
        if (!Number.isSafeInteger(length) || typeof length !== 'number' || length < 0 || length > 100000 || keys.length !== length + 1) artifactFault('JSON');
        for (let i = 0; i < length; i++) names.push(String(i));
      }
      for (let i = 0; i < names.length; i++) {
        const key = names[i]!, descriptor = descriptors.get(key);
        if (!descriptor) artifactFault('JSON');
        if (i) emit(',');
        if (!array) { primitiveString(key); emit(':'); }
        visit(descriptor.value, depth + 1);
      }
      emit(array ? ']' : '}');
      active.delete(item);
    };
    visit(value, 0);
    return Buffer.from(parts.join(''), 'utf8');
  } catch (error) { throw safeArtifactError(error, 'JSON'); }
}
