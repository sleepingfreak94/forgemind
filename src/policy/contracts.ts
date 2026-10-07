export const actions = [
  'file.read', 'file.write', 'command.run', 'network.request',
  'git.commit', 'git.push', 'pr.draft', 'git.merge', 'release',
] as const;
export type Action = typeof actions[number];
export type Role = 'lead' | 'researcher' | 'architect' | 'coder' | 'qa' | 'reviewer';

export interface LocalPrincipal {
  readonly id: string;
  readonly osUid: number;
}

/** Exact resources only; no glob, shell, URL-prefix, or directory expansion. */
export interface Capability { action: Action; resource: string }
export interface GrantInput {
  taskId: string;
  invocationId: string;
  role: Role;
  capabilities: Capability[];
  expiresAt: number;
  remainingDepth: number;
  maxActions: number;
  maxChildren: number;
  parentId?: string;
}
export interface TaskGrant extends GrantInput {
  id: string;
  principalId: string;
  sessionId: string;
  repositoryId: string;
  workspaceRoot: string;
  policyVersion: string;
  issuedAt: number;
  usedActions: number;
  revoked: boolean;
}

/** Received as JSON; no identity, grant, approval or executable shell fields. */
export interface ActionRequest {
  requestId: string;
  action: Action;
  resource: string;
  sourceSnapshot: string;
  content?: string;
}
export interface InvocationContext { grantId: string; invocationId: string }
export interface PolicyDecision {
  receiptId: string;
  outcome: 'allow' | 'deny' | 'approval-required';
  reason: string;
}
export interface Receipt {
  id: string;
  event: string;
  timestamp: number;
  principalId: string;
  sessionId: string;
  policyVersion: string;
  sourceSnapshot: string;
  grantId?: string;
  taskId?: string;
  invocationId?: string;
  requestId?: string;
  requestDigest?: string;
  action?: Action;
  resource?: string;
  outcome: string;
  reason: string;
  terminalEvidence?: { viewDigest: string; outputDigest?: string };
}
export interface ExecutionResult {
  decision: PolicyDecision;
  status: 'blocked' | 'succeeded' | 'failed';
}
export interface Approval {
  digest: string;
  grantId: string;
  expiresAt: number;
  consumed: boolean;
}

/** Host-only capability for a real, durably reserved command envelope. */
export interface ExternalReservation {
  receiptId: string;
  check(): void;
  finish(status: 'completed' | 'failed' | 'interrupted' | 'denied' | 'cancelled' | 'timed-out' | 'indeterminate', evidence?: { viewDigest: string; outputDigest?: string }, reason?: string): string;
}
export interface ExternalAttempt {
  context: InvocationContext;
  intent: ActionRequest;
  digest: string;
  sessionId: string;
  status: string;
  terminalEvidence?: { viewDigest: string; outputDigest?: string };
  envelopeJson?: string;
}
