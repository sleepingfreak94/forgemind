import { dataSnapshot, digest, freeze, object, positive, serialize } from '../context-engine/validation.js';
import { relativePath } from '../project-workflow/validation.js';
import { hash, text } from './validation.js';

export interface OrganizationProjectSource {
  projectId: string;
  workspaceIdentity: string;
  recordId: string;
  recordDigest: string;
  path: string;
  sourceDigest: string;
  sourceStatus: string;
}
/** These are evidence claims only. No field authenticates a principal or validator. */
export interface OrganizationEvidenceBinding {
  evidenceDigest: string;
  projectId: string;
  recordDigest: string;
  sourceDigest: string;
  independenceDomain: string;
}
export interface OrganizationCandidate {
  schemaVersion: 1;
  candidateId: string;
  organizationId: string;
  kind: 'decision' | 'lesson' | 'pattern';
  summary: string;
  applicability: string;
  exclusions: string;
  sources: OrganizationProjectSource[];
  evidence: OrganizationEvidenceBinding[];
  provenance: { taskId: string; packetDigest: string; workflowVersion: string };
  createdAt: number;
  digest: string;
}
export interface OrganizationValidationRequirements {
  schemaVersion: 1;
  trustedPrincipalAndGroupMapping: 'required-unconfigured';
  aclPolicy: 'required-unconfigured';
  validatorAndQuorum: 'required-unconfigured';
  independentEvidenceBindings: 'required-unconfigured';
}
export type OrganizationOperation = 'write' | 'read' | 'share' | 'promote';
export interface OrganizationDecisionReceipt {
  schemaVersion: 1;
  operation: OrganizationOperation;
  decision: 'denied';
  status: 'blocked-policy-unconfigured';
  trust: 'evidence-only';
  candidateDigest: string | null;
  input: 'well-formed-evidence' | 'malformed';
  missing: readonly string[];
  digest: string;
}
const missing = Object.freeze(['trusted-principal/group-mapping', 'ACL-policy', 'validator/quorum', 'independent-evidence-bindings']);
export function organizationRequirements(): Readonly<OrganizationValidationRequirements> {
  return freeze({ schemaVersion: 1, trustedPrincipalAndGroupMapping: 'required-unconfigured', aclPolicy: 'required-unconfigured',
    validatorAndQuorum: 'required-unconfigured', independentEvidenceBindings: 'required-unconfigured' });
}
/** Structural conformance ONLY; even a passing candidate is untrusted evidence. */
export function validateOrganizationCandidate(raw: unknown): Readonly<OrganizationCandidate> {
  const value = dataSnapshot(raw);
  object(value, ['schemaVersion', 'candidateId', 'organizationId', 'kind', 'summary', 'applicability', 'exclusions', 'sources', 'evidence', 'provenance', 'createdAt', 'digest']);
  if (value.schemaVersion !== 1 || !['decision', 'lesson', 'pattern'].includes(value.kind as string)) throw new Error('invalid organization candidate');
  hash(value.candidateId); hash(value.digest); text(value.organizationId, 256);
  for (const key of ['summary', 'applicability', 'exclusions'] as const) text(value[key], 2048);
  positive(value.createdAt);
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 16 ||
      !Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 32) throw new Error('organization evidence required');
  const sources: OrganizationProjectSource[] = [];
  for (const source of value.sources as unknown[]) {
    object(source, ['projectId', 'workspaceIdentity', 'recordId', 'recordDigest', 'path', 'sourceDigest', 'sourceStatus']);
    text(source.projectId, 256); relativePath(source.path); text(source.sourceStatus, 256);
    for (const key of ['workspaceIdentity', 'recordId', 'recordDigest', 'sourceDigest'] as const) hash(source[key]);
    sources.push(source as unknown as OrganizationProjectSource);
  }
  if (new Set(sources.map(source => serialize(source))).size !== sources.length) throw new Error('duplicate organization source');
  const evidence: OrganizationEvidenceBinding[] = [];
  for (const binding of value.evidence as unknown[]) {
    object(binding, ['evidenceDigest', 'projectId', 'recordDigest', 'sourceDigest', 'independenceDomain']);
    hash(binding.evidenceDigest); hash(binding.recordDigest); hash(binding.sourceDigest);
    text(binding.projectId, 256); text(binding.independenceDomain, 256);
    if (!sources.some(source => source.projectId === binding.projectId && source.recordDigest === binding.recordDigest && source.sourceDigest === binding.sourceDigest)) throw new Error('mismatched organization evidence');
    evidence.push(binding as unknown as OrganizationEvidenceBinding);
  }
  if (new Set(evidence.map(binding => binding.evidenceDigest)).size !== evidence.length ||
      sources.some(source => !evidence.some(binding => binding.projectId === source.projectId && binding.recordDigest === source.recordDigest && binding.sourceDigest === source.sourceDigest))) throw new Error('unbound organization provenance');
  object(value.provenance, ['taskId', 'packetDigest', 'workflowVersion']);
  text(value.provenance.taskId, 256); hash(value.provenance.packetDigest); text(value.provenance.workflowVersion, 256);
  const { digest: stored, ...body } = value;
  if (stored !== digest(serialize(body)) || Buffer.byteLength(serialize(value)) > 24000) throw new Error('organization candidate digest or budget mismatch');
  return value as unknown as Readonly<OrganizationCandidate>;
}
/** No store, capabilities, principal adapter, policy configuration or promotion implementation. */
export class OrganizationMemory {
  status(): Readonly<{ status: 'blocked-policy-unconfigured'; enabled: false; trust: 'evidence-only'; missing: readonly string[] }> {
    return freeze({ status: 'blocked-policy-unconfigured', enabled: false, trust: 'evidence-only', missing });
  }
  decide(operation: OrganizationOperation, raw: unknown): Readonly<OrganizationDecisionReceipt> {
    if (!['write', 'read', 'share', 'promote'].includes(operation)) throw new Error('invalid organization operation');
    let candidateDigest: string | null = null;
    let input: OrganizationDecisionReceipt['input'] = 'malformed';
    try { candidateDigest = validateOrganizationCandidate(raw).digest; input = 'well-formed-evidence'; } catch { /* Never echo malformed/protected input. */ }
    const body = { schemaVersion: 1 as const, operation, decision: 'denied' as const, status: 'blocked-policy-unconfigured' as const,
      trust: 'evidence-only' as const, candidateDigest, input, missing };
    return freeze({ ...body, digest: digest(serialize(body)) });
  }
  write(raw: unknown): Readonly<OrganizationDecisionReceipt> { return this.decide('write', raw); }
  read(raw: unknown): Readonly<OrganizationDecisionReceipt> { return this.decide('read', raw); }
  share(raw: unknown): Readonly<OrganizationDecisionReceipt> { return this.decide('share', raw); }
  promote(raw: unknown): Readonly<OrganizationDecisionReceipt> { return this.decide('promote', raw); }
}
