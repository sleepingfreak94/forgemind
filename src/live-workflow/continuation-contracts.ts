import type { Capability, Role, TaskGrant } from '../policy/contracts.js';
import type { NativeBudget, NativeCounters, BudgetKey } from './native-executor-contracts.js';

export const continuationSchema = 'forgemind-continuation-v1';
export const maxCheckpointBytes = 262144;
export interface ContinuationEvidence {
  id: string;
  kind: 'artifact' | 'check' | 'observation' | 'reconciliation';
  source: string;
  sourceIdentity: string;
  digest: string;
  epistemic: 'observed' | 'claimed';
  result: 'passed' | 'failed' | 'unknown' | 'recorded';
  summary: string;
}
export interface ContinuationEffect {
  id: string;
  description: string;
  status: 'pending' | 'indeterminate' | 'reconciled';
  evidenceIds: string[];
}
/** Evidence only. No grant, native thread, credential, or callable belongs here. */
export interface ContinuationCheckpoint {
  schemaVersion: typeof continuationSchema;
  projectId: string;
  root: string;
  taskId: string;
  sourceIdentity: string;
  policyVersion: string;
  objective: string;
  acceptanceCriteria: string[];
  evidence: ContinuationEvidence[];
  decisions: string[];
  hypotheses: string[];
  failedApproaches: string[];
  nextSteps: string[];
  origin: { instanceId: string; role: Role };
  parentDigest: string | null;
  createdAt: number;
  expiresAt: number;
  budget: { limit: NativeBudget; used: NativeCounters };
  requestCapabilities: Capability[];
  status: 'ready' | 'completed' | 'cancelled' | 'indeterminate';
  pendingEffects: ContinuationEffect[];
  reconciliation: {
    status: 'none' | 'required' | 'owner-reconciled';
    evidenceIds: string[];
    invalidatedAssumptions: string[];
  };
}
export interface StoredContinuation { digest: string; checkpoint: Readonly<ContinuationCheckpoint> }
export type RemainingBudget = Record<BudgetKey, number | null>;
export interface ResumeTarget {
  role: Role;
  capabilities: Capability[];
  expiresAt: number;
  remainingDepth: number;
  maxActions: number;
  maxChildren: number;
}
/** Host constructs these identities; do not pass model JSON directly to prepareResume. */
export interface ResumeBinding {
  digest: string;
  projectId: string;
  root: string;
  taskId: string;
  parentGrantId: string;
  instanceId: string;
  invocationId: string;
  target: ResumeTarget;
}
export interface ResumePacket extends StoredContinuation {
  instanceId: string;
  invocationId: string;
  role: Role;
  fence: number;
  sourceIdentity: string;
  remainingBudget: RemainingBudget;
  receiptIds: string[];
}
/** Host-only, process-local authority. Never JSON-serialize this object. */
export interface ResumeLease {
  readonly packet: Readonly<ResumePacket>;
  readonly grant: Readonly<TaskGrant>;
  check(): void;
  revoke(): void;
}
export interface OwnerPolicyDescriptor {
  policyVersion: string;
  parent: ResumeTarget;
  target: ResumeTarget;
}
