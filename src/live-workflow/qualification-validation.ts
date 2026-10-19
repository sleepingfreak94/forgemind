import { createHash } from 'node:crypto';
import { maxQualificationBytes } from './qualification-contracts.js';
import type { QualificationArtifact, QualificationBuild, QualificationReview, QualificationCheck, UnavailableEvidence, DiagnosticProjection } from './qualification-contracts.js';
export function qualificationError(): never { throw new Error('Invalid historical qualification evidence'); }
export function textHash(text: string | Uint8Array): string { return createHash('sha256').update(text).digest('hex'); }
/** Inspect descriptors before serialization; accessors and toJSON never execute. */
export function assertJson(value: unknown): void {
  let nodes = 0, bytes = 0;
  const stack = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 50000 || depth > 24) qualificationError();
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); if (bytes > maxQualificationBytes) qualificationError(); return; }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER || Object.is(item, -0)) qualificationError(); return; }
    if (!item || typeof item !== 'object' || stack.has(item) || Object.getOwnPropertySymbols(item).length) qualificationError();
    const array = Array.isArray(item), proto: unknown = Object.getPrototypeOf(item);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) qualificationError();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (array && ((item as unknown[]).length > 4096 || Object.keys(item).length !== (item as unknown[]).length)) qualificationError();
    stack.add(item);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      bytes += Buffer.byteLength(key);
      if (bytes > maxQualificationBytes || ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key) ||
          !descriptor.enumerable || descriptor.get || descriptor.set ||
          (array && !/^(0|[1-9][0-9]*)$/.test(key)) || (key === 'productionReady' && descriptor.value === true)) qualificationError();
      visit(descriptor.value, depth + 1);
    }
    stack.delete(item);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxQualificationBytes) qualificationError();
}
export function canonical(value: unknown): string {
  assertJson(value);
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return '[' + item.map(encode).join(',') + ']';
    if (item && typeof item === 'object') {
      const r = item as Record<string, unknown>;
      return '{' + Object.keys(r).sort().map(key => JSON.stringify(key) + ':' + encode(r[key])).join(',') + '}';
    }
    return JSON.stringify(item);
  };
  return encode(value);
}
export function qualificationHash(value: unknown): string { return textHash(canonical(value)); }
export function parseQualificationJson(text: string): unknown {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxQualificationBytes) qualificationError();
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return qualificationError(); }
  assertJson(value); return value;
}
/** Call assertJson at each public input boundary before using these structural helpers. */
export function record(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return qualificationError();
  const result = value as Record<string, unknown>;
  if (allowed && Object.keys(result).some(key => !allowed.includes(key))) qualificationError();
  return result;
}
export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = record(value, keys);
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) qualificationError();
  return result;
}
export function identifier(value: unknown, max = 128): string {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/.test(value)) return qualificationError();
  return value;
}
export function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) return qualificationError();
  return value as T;
}
export function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value) || /^0{64}$/.test(value)) return qualificationError();
  return value;
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < min || value > max) return qualificationError();
  return value;
}
export function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return qualificationError(); return value; }
export function list(value: unknown, max = 256): unknown[] {
  if (!Array.isArray(value) || value.length > max) return qualificationError(); return value;
}
export function checkIds(value: unknown): string[] {
  const ids = list(value, 128).map(item => identifier(item));
  if (!ids.length || new Set(ids).size !== ids.length) qualificationError(); return ids;
}
export function sameSource(value: unknown, expected: string): string {
  const source = digest(value); if (source !== expected) qualificationError(); return source;
}
export function lifetime(createdAt: unknown, expiresAt: unknown, now: unknown): void {
  const created = integer(createdAt, 1), expires = integer(expiresAt, 1), current = integer(now, 1);
  if (created > current || expires <= current || expires <= created) qualificationError();
}
export function freezeQualification<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeQualification); Object.freeze(value); } return value;
}
export function unavailable(): UnavailableEvidence { return { classification: 'unavailable', value: 'unavailable' }; }
export function independentActors(reviewer: string, implementer: string | null): boolean {
  const unknown = ['unknown', 'unavailable', 'unspecified'];
  return implementer !== null && implementer !== reviewer && !unknown.includes(implementer.toLowerCase()) && !unknown.includes(reviewer.toLowerCase());
}
export function validateBuild(raw: unknown, expected: string): QualificationBuild {
  assertJson(raw);
  const build = exact(raw, ['schema', 'source', 'artifacts']);
  if (build.schema !== 'qualification-build-v1') qualificationError();
  sameSource(build.source, expected);
  const artifacts = list(build.artifacts, 32).map(value => {
    const pin = exact(value, ['id', 'path', 'sha256']);
    if (typeof pin.path !== 'string' || pin.path.length > 4096 || !pin.path.startsWith('/') ||
        /[\x00-\x1f\x7f\\]/.test(pin.path) || pin.path.split('/').slice(1).some(part => !part || part === '.' || part === '..')) qualificationError();
    return { id: identifier(pin.id), path: pin.path, sha256: digest(pin.sha256) };
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  if (!artifacts.length || new Set(artifacts.map(pin => pin.id)).size !== artifacts.length || new Set(artifacts.map(pin => pin.path)).size !== artifacts.length) qualificationError();
  return { schema: 'qualification-build-v1', source: expected, artifacts };
}
export function artifact(raw: unknown): { descriptor: QualificationArtifact; value: unknown } {
  assertJson(raw);
  const value = exact(raw, ['name', 'source', 'sha256', 'json']);
  const name = choice(value.name, ['before-checks.json', 'after-checks.json', 'review.json'] as const);
  if (typeof value.json !== 'string') qualificationError();
  const source = digest(value.source), sha256 = digest(value.sha256);
  if (textHash(value.json) !== sha256) qualificationError();
  const parsed = parseQualificationJson(value.json);
  return { descriptor: { name, source, sha256, json: value.json }, value: parsed };
}
export function reviewResult(raw: unknown, source: string): 'pass' | 'revise' | 'blocked' {
  assertJson(raw);
  const result = record(raw, ['verdict', 'findings', 'source', 'acceptance']);
  for (const key of ['verdict', 'findings', 'source']) if (!Object.hasOwn(result, key)) qualificationError();
  sameSource(result.source, source);
  const verdict = choice(result.verdict, ['pass', 'revise', 'blocked'] as const);
  const strings = (items: unknown) => list(items, 128).forEach(item => {
    if (typeof item !== 'string' || Buffer.byteLength(item) > 8192) qualificationError();
  });
  strings(result.findings); if (Object.hasOwn(result, 'acceptance')) strings(result.acceptance);
  return verdict;
}
export function validateReview(raw: unknown, taskId: string, source: string): { review: QualificationReview; verdict: 'pass' | 'revise' | 'blocked' } {
  assertJson(raw);
  const value = record(raw, ['schema', 'taskId', 'source', 'reviewer', 'implementer', 'createdAt', 'expiresAt', 'artifact']);
  if (value.schema !== 'qualification-review-v1' || value.taskId !== taskId) qualificationError();
  sameSource(value.source, source);
  const reviewer = identifier(value.reviewer), implementer = value.implementer === null || value.implementer === undefined ? null : identifier(value.implementer);
  const createdAt = integer(value.createdAt, 1), expiresAt = integer(value.expiresAt, 1);
  if (expiresAt <= createdAt) qualificationError();
  const imported = artifact(value.artifact);
  if (imported.descriptor.name !== 'review.json') qualificationError();
  sameSource(imported.descriptor.source, source);
  return { review: { schema: 'qualification-review-v1', taskId, source, reviewer, implementer, createdAt, expiresAt, artifact: imported.descriptor }, verdict: reviewResult(imported.value, source) };
}
export const receiptKeys = ['id', 'event', 'timestamp', 'principalId', 'sessionId', 'policyVersion', 'sourceSnapshot', 'grantId', 'taskId', 'invocationId', 'requestId', 'requestDigest', 'action', 'resource', 'outcome', 'reason', 'terminalEvidence'] as const;
export function receipts(raw: unknown): Record<string, unknown>[] {
  assertJson(raw);
  const seen = new Set<string>();
  return list(raw, 4096).map(item => {
    const r = record(item, receiptKeys), id = identifier(r.id);
    if (seen.has(id)) qualificationError(); seen.add(id);
    identifier(r.event); identifier(r.outcome); identifier(r.sourceSnapshot, 256); integer(r.timestamp);
    for (const key of ['principalId', 'sessionId', 'policyVersion']) identifier(r[key]);
    for (const key of ['grantId', 'taskId', 'invocationId', 'requestId']) if (r[key] !== undefined) identifier(r[key]);
    if (typeof r.reason !== 'string' || Buffer.byteLength(r.reason) > 8192) qualificationError();
    if (r.action !== undefined) choice(r.action, ['file.read', 'file.write', 'command.run', 'network.request', 'git.commit', 'git.push', 'pr.draft', 'git.merge', 'release']);
    if (r.resource !== undefined && (typeof r.resource !== 'string' || r.resource.length > 8192)) qualificationError();
    if (r.requestDigest !== undefined) digest(r.requestDigest);
    if (r.terminalEvidence !== undefined) {
      const t = record(r.terminalEvidence, ['viewDigest', 'outputDigest']);
      digest(t.viewDigest); if (t.outputDigest !== undefined) digest(t.outputDigest);
    }
    return r;
  });
}
export function terminalBound(rows: readonly Record<string, unknown>[], hash: string, source: string, task: string, passed: boolean): boolean {
  return rows.some(r => r.event === 'external.finished' && r.taskId === task && r.sourceSnapshot === source &&
    r.outcome === (passed ? 'completed' : 'failed') && r.terminalEvidence !== undefined && record(r.terminalEvidence).outputDigest === hash);
}
export function projectChecks(raw: unknown, source: string, task: string, classification: 'imported' | 'fixture', rows: readonly Record<string, unknown>[]): QualificationCheck[] {
  assertJson(raw);
  const seen = new Set<string>();
  return list(raw, 128).map(item => {
    // Hash the complete original CheckResult in insertion order, including compiled stages/manifest.
    const c = record(item, ['id', 'passed', 'exitCode', 'stdout', 'stderr', 'stages', 'artifactManifest']);
    const id = identifier(c.id), passed = boolean(c.passed);
    if (seen.has(id)) qualificationError(); seen.add(id);
    const exitCode = c.exitCode === null ? null : integer(c.exitCode, -2147483648, 2147483647);
    if (typeof c.stdout !== 'string' || typeof c.stderr !== 'string' || passed !== (exitCode === 0)) qualificationError();
    const hash = textHash(JSON.stringify(item));
    return { id, source, classification, passed, exitCode, digest: hash, receiptBound: terminalBound(rows, hash, source, task, passed) };
  });
}
export interface HistoricalPhase { readonly seq: number; readonly name: string; readonly source: string; readonly data: Record<string, unknown> }
export function phases(raw: unknown): HistoricalPhase[] {
  assertJson(raw);
  let previous = 0;
  return list(raw, 4096).map(item => {
    const p = exact(item, ['seq', 'name', 'source', 'data']);
    const seq = integer(p.seq, 1); if (seq <= previous) qualificationError(); previous = seq;
    if (typeof p.data !== 'string') qualificationError();
    return { seq, name: identifier(p.name), source: digest(p.source), data: record(parseQualificationJson(p.data)) };
  });
}
export const diagnosticKinds = ['contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded', 'flexUnavailable', 'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials', 'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'other', 'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts', 'activeTurnNotSteerable', 'unknown'] as const;
export const failurePhases = ['authentication', 'owner-authority', 'runtime-plan', 'native-launch', 'native-turn', 'verification', 'cleanup'] as const;
export const failureCodes = ['cleanup-or-effect-indeterminate', 'cancelled', 'pending-effect', 'native-provider-unauthorized', 'native-provider-rate-limit', 'native-provider-quota', 'native-provider-transport', 'native-provider-policy', 'native-provider-error', 'account-or-authority', 'budget-exhausted', 'runtime-unqualified', 'source-or-checkpoint', 'verification-failed', 'native-execution-failed', 'chatgpt-refresh-deferred'] as const;
export function diagnostic(raw: unknown): DiagnosticProjection | null {
  if (raw === null || raw === undefined) return null;
  assertJson(raw);
  const d = exact(raw, ['kind', 'httpStatusCode', 'willRetry']);
  const kind = choice(d.kind, diagnosticKinds);
  return { kind, httpStatusCode: d.httpStatusCode === null ? null : integer(d.httpStatusCode, 0, 65535),
    willRetry: d.willRetry === null ? null : boolean(d.willRetry) };
}
export const tokenKeys = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const;
export function tokens(raw: unknown): Record<string, number> {
  if (raw === null || raw === undefined) return {};
  assertJson(raw);
  const usage = record(raw), output: Record<string, number> = {};
  for (const scope of ['total', 'last']) {
    if (usage[scope] !== undefined && usage[scope] !== null) {
      const group = record(usage[scope]);
      for (const key of tokenKeys) if (group[key] !== undefined) output[scope + '.' + key] = integer(group[key]);
    }
  }
  for (const key of tokenKeys) if (usage[key] !== undefined) output[key] = integer(usage[key]);
  return output;
}
