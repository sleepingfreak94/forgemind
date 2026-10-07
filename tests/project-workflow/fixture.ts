import { realpathSync } from 'node:fs';
import { serialize } from '../../src/context-engine/validation.js';
import type { ImplementationPlan, ProjectProfile, WorkflowAuthority, WorkflowPreparation, WorkflowScope, WorkflowProofRequest } from '../../src/project-workflow/contracts.js';
import { proofRequest } from '../../src/project-workflow/preflight.js';

export function fixture() {
  const profile: ProjectProfile = { schemaVersion: 1, projectId: 'project-a', name: 'Project A',
    documents: { prd: 'docs/PRD.md', srs: 'docs/SRS.md', adrs: 'docs/adr' },
    preferences: { askAt: 'project', draftPr: true, evidence: 'text', planReview: 'approve' } };
  const plan: ImplementationPlan = { schemaVersion: 1, objective: 'Fix the compile failure', changedPaths: ['src/example.ts'],
    steps: ['Reproduce E42', 'Correct the type', 'Validate and independently review'], acceptanceCriteria: ['Build passes without weakening types'],
    checks: ['Typecheck and focused regression'], risks: ['Public API compatibility'], rollback: 'Restore the previous implementation' };
  const scope: WorkflowScope = { projectId: profile.projectId, taskId: 'ticket-a', principalId: 'fixture-owner', workspaceRoot: realpathSync(process.cwd()),
    sourceSnapshot: 'a'.repeat(64), expiresAt: 2000 };
  const verified = new Map<string, string>(); let counter = 0;
  const authority: WorkflowAuthority = { async verify(request, id) { return verified.get(id) === serialize(request); } };
  const issue = (prepared: WorkflowPreparation, kind: WorkflowProofRequest['kind']) => {
    const id = `fixture-${++counter}`; verified.set(id, serialize(proofRequest(prepared, kind))); return id;
  };
  return { profile, plan, scope, authority, issue, clock: () => 1000 };
}
