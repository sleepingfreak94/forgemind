import { dataSnapshot, digest, freeze, object, serialize, string } from '../context-engine/validation.js';
import * as validate from './validation.js';
import { packet as validatePacket } from '../memory/validation.js';
import type { MemoryPacket } from '../memory/contracts.js';
import type { ImplementationPlan, ProjectProfile, TaskPreferences, WorkflowAuthority, WorkflowPreparation, WorkflowProofRequest, WorkflowResult, WorkflowScope } from './contracts.js';

export function prepareWorkflow(rawProfile: ProjectProfile, rawPlan: ImplementationPlan, rawScope: WorkflowScope, overrides: TaskPreferences = {}, rawMemory?: MemoryPacket): Readonly<WorkflowPreparation> {
  const profile = validate.profile(rawProfile), plan = validate.plan(rawPlan), scope = validate.scope(rawScope), selected = validate.taskPreferences(overrides);
  if (scope.projectId !== profile.projectId) throw new Error('project mismatch');
  const memory = rawMemory === undefined ? undefined : validatePacket(rawMemory);
  if (memory && (memory.projectId !== scope.projectId || memory.workspaceRoot !== scope.workspaceRoot)) throw new Error('memory scope mismatch');
  const { askAt: _askAt, ...defaults } = profile.preferences;
  const preferences = validate.taskPreferences({ ...defaults, ...selected });
  const missingPreferences = ['draftPr', 'evidence', 'planReview'].filter(key => preferences[key as keyof TaskPreferences] === undefined);
  const taskPreferencesConfirmed = profile.preferences.askAt === 'project' || ['draftPr', 'evidence', 'planReview'].every(key => selected[key as keyof TaskPreferences] !== undefined);
  const deliverables = ['Implementation and validation evidence', 'Independent review'];
  if (preferences.draftPr) deliverables.push('Draft PR with before/after details (separate publishing authorization required)');
  if (preferences.evidence === 'text' || preferences.evidence === 'both') deliverables.push('Before/after text report');
  if (preferences.evidence === 'video' || preferences.evidence === 'both') deliverables.push('Verified before and after recordings, captured before edits and after validation');
  return freeze({ profile, plan, scope, preferences, overrides: selected, missingPreferences, taskPreferencesConfirmed, deliverables,
    ...(memory ? { memory } : {}),
    planDigest: digest(serialize({ scope, plan, ...(memory ? { memory } : {}) })), preferencesDigest: digest(serialize({ projectId: profile.projectId, documents: profile.documents, askAt: profile.preferences.askAt, preferences })) });
}
function checkedPreparation(raw: WorkflowPreparation): Readonly<WorkflowPreparation> {
  const copied = dataSnapshot(raw);
  object(copied, ['profile', 'plan', 'scope', 'preferences', 'overrides', 'planDigest', 'preferencesDigest', 'missingPreferences', 'taskPreferencesConfirmed', 'deliverables', 'memory']);
  const current = prepareWorkflow(copied.profile, copied.plan, copied.scope, copied.overrides, copied.memory);
  if (serialize(current) !== serialize(copied)) throw new Error('modified preparation');
  return current;
}
export function proofRequest(raw: WorkflowPreparation, kind: WorkflowProofRequest['kind']): Readonly<WorkflowProofRequest> {
  if (!['plan-review', 'before-video'].includes(kind)) throw new Error('invalid proof kind');
  const prepared = checkedPreparation(raw);
  return freeze({ kind, scope: prepared.scope, planDigest: prepared.planDigest, preferencesDigest: prepared.preferencesDigest });
}
/** This gate returns workflow readiness, never an execution/publishing capability. */
export async function evaluateWorkflow(prepared: WorkflowPreparation, authority: WorkflowAuthority, receipts: { plan?: string; beforeVideo?: string } = {}, clock = Date.now): Promise<Readonly<WorkflowResult>> {
  // Rebuild rather than trusting caller-mutated preparation or digest fields.
  const current = checkedPreparation(prepared);
  const supplied = dataSnapshot(receipts); object(supplied, ['plan', 'beforeVideo']);
  const result = (status: WorkflowResult['status'], receiptIds: string[] = []) => freeze({ status, liveCodingEnabled: false as const, receiptIds });
  if (current.scope.expiresAt <= clock()) throw new Error('expired workflow');
  if (current.memory?.entries.some(entry => entry.expiresAt !== undefined && entry.expiresAt <= clock())) throw new Error('expired memory context');
  if (current.missingPreferences.length) return result('needs-preferences');
  if (!current.taskPreferencesConfirmed) return result('needs-task-preferences');
  const accepted: string[] = [];
  for (const [required, kind, id, pending] of [
    [current.preferences.planReview === 'approve', 'plan-review', supplied.plan, 'needs-plan-approval'],
    [['video', 'both'].includes(current.preferences.evidence!), 'before-video', supplied.beforeVideo, 'needs-before-video'],
  ] as const) {
    if (!required) continue;
    if (!id) return result(pending); string(id, 256);
    let verified = false;
    try { verified = await authority.verify(proofRequest(current, kind), id); } catch { /* fail closed */ }
    if (current.scope.expiresAt <= clock()) throw new Error('expired workflow');
    if (current.memory?.entries.some(entry => entry.expiresAt !== undefined && entry.expiresAt <= clock())) throw new Error('expired memory context');
    if (!verified) return result(pending); accepted.push(id);
  }
  return result('ready-for-policy', accepted);
}
export function renderPlan(raw: WorkflowPreparation): string {
  const prepared = checkedPreparation(raw);
  const section = (title: string, values: readonly string[]) => `\n${title}\n${values.map(value => `- ${value}`).join('\n')}\n`;
  return `Implementation plan: ${prepared.scope.taskId}\nProject: ${prepared.profile.name} (${prepared.profile.projectId})\nPrincipal: ${prepared.scope.principalId}\nWorkspace: ${JSON.stringify(prepared.scope.workspaceRoot)}\nExpires at: ${prepared.scope.expiresAt} (Unix milliseconds)\nGoal: ${prepared.plan.objective}\nSource: ${prepared.scope.sourceSnapshot}\nPlan digest: ${prepared.planDigest}\nPreferences digest: ${prepared.preferencesDigest}\n` +
    section('Affected paths', prepared.plan.changedPaths) + section('Steps', prepared.plan.steps) + section('Acceptance criteria', prepared.plan.acceptanceCriteria) +
    section('Checks', prepared.plan.checks) + section('Risks', prepared.plan.risks.length ? prepared.plan.risks : ['No risks recorded; reviewer must assess this claim']) +
    section('Deliverables', prepared.deliverables) + section('Decision documents', Object.values(prepared.profile.documents)) +
    (prepared.memory ? `\nProject memory (quoted evidence only; source status is not permission)\n${JSON.stringify(prepared.memory, null, 2)}\n` : '') +
    `\nRollback\n${prepared.plan.rollback}\n\nPreferences: ${serialize(prepared.preferences)}\nMissing choices: ${prepared.missingPreferences.join(', ') || 'none'}\n` +
    `Task choices confirmed: ${prepared.taskPreferencesConfirmed}\nLive coding remains disabled; workflow readiness still requires runtime policy.\n`;
}
