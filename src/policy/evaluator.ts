import type { ActionRequest, Capability, TaskGrant } from './contracts.js';

export function contains(capabilities: Capability[], wanted: Capability): boolean {
  return capabilities.some(c => c.action === wanted.action && c.resource === wanted.resource);
}
/** Pure policy evaluation. An allow result alone is not an execution capability. */
export function evaluate(chain: TaskGrant[], request: ActionRequest, context: {
  principalId: string; sessionId: string; policyVersion: string; repositoryId: string;
  workspaceRoot: string; invocationId: string; now: number; sourceSnapshot: string;
  budgetReserved?: boolean;
}): string | undefined {
  if (chain.length === 0) return 'unknown-grant';
  if (chain[0]!.invocationId !== context.invocationId) return 'invocation-mismatch';
  for (const grant of chain) {
    if (grant.principalId !== context.principalId || grant.sessionId !== context.sessionId) return 'stale-session';
    if (grant.repositoryId !== context.repositoryId || grant.workspaceRoot !== context.workspaceRoot) return 'workspace-mismatch';
    if (grant.policyVersion !== context.policyVersion) return 'stale-policy';
    if (grant.revoked) return 'revoked-grant';
    if (grant.expiresAt <= context.now) return 'expired-grant';
    if (!context.budgetReserved && grant.usedActions >= grant.maxActions) return 'action-budget-exhausted';
    if (!contains(grant.capabilities, request)) return 'outside-grant';
  }
  if (request.sourceSnapshot !== context.sourceSnapshot) return 'stale-source';
  return undefined;
}
