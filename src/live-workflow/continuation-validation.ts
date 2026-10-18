import { isAbsolute, resolve } from 'node:path';
import { dataSnapshot, digest, freeze, object, serialize, string } from '../context-engine/validation.js';
import { capability, grantInput, integer, text } from '../policy/validation.js';
import type { Capability, Role } from '../policy/contracts.js';
import { budgetKeys, validateBudget } from './native-executor-contracts.js';
import { continuationSchema, maxCheckpointBytes } from './continuation-contracts.js';
import type { ContinuationCheckpoint, OwnerPolicyDescriptor, RemainingBudget, ResumeTarget } from './continuation-contracts.js';

export { serialize };
export function hash(value: unknown): string { return digest(serialize(value)); }
export function digestText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid digest');
}
export function role(value: unknown): asserts value is Role {
  if (!['lead', 'researcher', 'architect', 'coder', 'qa', 'reviewer'].includes(value as string)) throw new Error('invalid role');
}
function list(value: unknown, max = 64): asserts value is string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('invalid bounded list');
  value.forEach(item => string(item, 2048));
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  object(value, keys);
  if (Object.keys(value).length !== keys.length) throw new Error('missing fields');
}
export function capabilities(root: string, value: unknown): Capability[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('invalid capabilities');
  const seen = new Set<string>();
  return value.map(raw => {
    exact(raw, ['action', 'resource']);
    const cap = capability(root, raw);
    // The existing validator canonicalizes file paths and URLs. Portable input must already be exact.
    if (cap.resource !== raw.resource || /[*?\[\]{}]/.test(cap.resource)) throw new Error('non-exact capability');
    const key = serialize(cap);
    if (seen.has(key)) throw new Error('duplicate capability');
    seen.add(key);
    return cap;
  });
}
export function subset(caps: readonly Capability[], ceiling: readonly Capability[]): boolean {
  return caps.every(c => ceiling.some(p => p.action === c.action && p.resource === c.resource));
}
export function validateTarget(root: string, input: unknown, now: number): ResumeTarget {
  const raw = dataSnapshot(input);
  exact(raw, ['role', 'capabilities', 'expiresAt', 'remainingDepth', 'maxActions', 'maxChildren']);
  const caps = capabilities(root, raw.capabilities);
  const grant = grantInput(root, { ...raw, capabilities: caps, taskId: 'validation', invocationId: 'validation' }, now);
  return freeze({ role: grant.role, capabilities: caps, expiresAt: grant.expiresAt,
    remainingDepth: grant.remainingDepth, maxActions: grant.maxActions, maxChildren: grant.maxChildren });
}
export function validateOwnerPolicy(root: string, input: unknown, now: number): OwnerPolicyDescriptor {
  const raw = dataSnapshot(input);
  exact(raw, ['policyVersion', 'parent', 'target']);
  text(raw.policyVersion, 'policy version', 128);
  return freeze({ policyVersion: raw.policyVersion, parent: validateTarget(root, raw.parent, now), target: validateTarget(root, raw.target, now) });
}
export function validateCheckpoint(input: unknown): Readonly<ContinuationCheckpoint> {
  const raw = dataSnapshot(input);
  exact(raw, ['schemaVersion', 'projectId', 'root', 'taskId', 'sourceIdentity', 'policyVersion', 'objective',
    'acceptanceCriteria', 'evidence', 'decisions', 'hypotheses', 'failedApproaches', 'nextSteps', 'origin',
    'parentDigest', 'createdAt', 'expiresAt', 'budget', 'requestCapabilities', 'status', 'pendingEffects', 'reconciliation']);
  if (raw.schemaVersion !== continuationSchema || Buffer.byteLength(serialize(raw)) > maxCheckpointBytes) throw new Error('invalid checkpoint schema or size');
  text(raw.projectId, 'project', 128); text(raw.taskId, 'task', 128); text(raw.policyVersion, 'policy', 128);
  text(raw.root, 'root', 4096);
  if (!isAbsolute(raw.root) || resolve(raw.root) !== raw.root) throw new Error('noncanonical root');
  digestText(raw.sourceIdentity);
  string(raw.objective, 8192);
  for (const key of ['acceptanceCriteria', 'decisions', 'hypotheses', 'failedApproaches', 'nextSteps']) list(raw[key]);
  if (!(raw.acceptanceCriteria as string[]).length) throw new Error('missing acceptance criteria');
  exact(raw.origin, ['instanceId', 'role']); text(raw.origin.instanceId, 'origin instance', 128); role(raw.origin.role);
  if (raw.parentDigest !== null) digestText(raw.parentDigest);
  integer(raw.createdAt, 'creation', 1); integer(raw.expiresAt, 'expiry', raw.createdAt + 1);
  exact(raw.budget, ['limit', 'used']);
  validateBudget(raw.budget.limit as ContinuationCheckpoint['budget']['limit']);
  exact(raw.budget.used, [...budgetKeys]);
  const limits = raw.budget.limit as ContinuationCheckpoint['budget']['limit'];
  for (const key of budgetKeys) {
    integer(raw.budget.used[key], 'counter');
    if (limits[key] !== null && raw.budget.used[key] > limits[key]!) throw new Error('budget exceeded');
  }
  capabilities(raw.root, raw.requestCapabilities);
  if (!['ready', 'completed', 'cancelled', 'indeterminate'].includes(raw.status as string)) throw new Error('invalid status');
  if (!Array.isArray(raw.evidence) || raw.evidence.length > 128) throw new Error('invalid evidence');
  const ids = new Set<string>();
  const reconciliationIds = new Set<string>();
  for (const item of raw.evidence) {
    exact(item, ['id', 'kind', 'source', 'sourceIdentity', 'digest', 'epistemic', 'result', 'summary']);
    text(item.id, 'evidence ID', 128); string(item.source, 2048); string(item.summary, 4096);
    digestText(item.sourceIdentity); digestText(item.digest);
    if (ids.has(item.id) || !['artifact', 'check', 'observation', 'reconciliation'].includes(item.kind as string) ||
        !['observed', 'claimed'].includes(item.epistemic as string) || !['passed', 'failed', 'unknown', 'recorded'].includes(item.result as string)) throw new Error('invalid evidence');
    ids.add(item.id);
    if (item.kind === 'reconciliation' && item.epistemic === 'observed' && item.sourceIdentity === raw.sourceIdentity) reconciliationIds.add(item.id);
  }
  const references = (value: unknown, reconciliation = false) => {
    list(value);
    if (value.some(id => !(reconciliation ? reconciliationIds : ids).has(id))) throw new Error('missing evidence reference');
  };
  if (!Array.isArray(raw.pendingEffects) || raw.pendingEffects.length > 64) throw new Error('invalid effects');
  const effects = new Set<string>();
  for (const effect of raw.pendingEffects) {
    exact(effect, ['id', 'description', 'status', 'evidenceIds']);
    text(effect.id, 'effect ID', 128); string(effect.description, 2048);
    if (effects.has(effect.id) || !['pending', 'indeterminate', 'reconciled'].includes(effect.status as string)) throw new Error('invalid effect');
    effects.add(effect.id); references(effect.evidenceIds, effect.status === 'reconciled');
    if (effect.status === 'reconciled' && !(effect.evidenceIds as string[]).length) throw new Error('missing effect reconciliation');
  }
  exact(raw.reconciliation, ['status', 'evidenceIds', 'invalidatedAssumptions']);
  if (!['none', 'required', 'owner-reconciled'].includes(raw.reconciliation.status as string)) throw new Error('invalid reconciliation');
  references(raw.reconciliation.evidenceIds, true); list(raw.reconciliation.invalidatedAssumptions);
  if (raw.reconciliation.status === 'owner-reconciled' && (!(raw.reconciliation.evidenceIds as string[]).length ||
      !(raw.reconciliation.invalidatedAssumptions as string[]).length)) throw new Error('missing owner reconciliation evidence');
  return freeze(raw) as unknown as Readonly<ContinuationCheckpoint>;
}
export function remainingBudget(checkpoint: Readonly<ContinuationCheckpoint>, runnable = false): RemainingBudget {
  return Object.fromEntries(budgetKeys.map(key => {
    const limit = checkpoint.budget.limit[key];
    const left = limit === null ? null : limit - checkpoint.budget.used[key];
    if (left !== null && (left < 0 || (runnable && key !== 'retries' && left === 0))) throw new Error('exhausted cumulative budget');
    return [key, left];
  })) as RemainingBudget;
}
