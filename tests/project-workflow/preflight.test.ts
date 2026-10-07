import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateWorkflow, prepareWorkflow, renderPlan } from '../../src/project-workflow/preflight.js';
import type { WorkflowPreparation } from '../../src/project-workflow/contracts.js';
import { fixture } from './fixture.js';

test('missing choices block; no project silently inherits another repository PR permission', async () => {
  const f = fixture(); f.profile.preferences = { askAt: 'project' };
  const prepared = prepareWorkflow(f.profile, f.plan, f.scope);
  assert.deepEqual(prepared.missingPreferences, ['draftPr', 'evidence', 'planReview']);
  assert.equal((await evaluateWorkflow(prepared, f.authority, {}, f.clock)).status, 'needs-preferences');
  assert.ok(!prepared.deliverables.some(value => value.startsWith('Draft PR')));
  assert.throws(() => prepareWorkflow(f.profile, f.plan, { ...f.scope, projectId: 'project-b' }), /mismatch/);
});
test('task overrides are isolated; ask-every-task requires explicit choices for that task', async () => {
  const f = fixture(); f.profile.preferences.askAt = 'task';
  assert.equal((await evaluateWorkflow(prepareWorkflow(f.profile, f.plan, f.scope), f.authority, {}, f.clock)).status, 'needs-task-preferences');
  const prepared = prepareWorkflow(f.profile, f.plan, f.scope, { draftPr: false, evidence: 'text', planReview: 'show' });
  const result = await evaluateWorkflow(prepared, f.authority, {}, f.clock);
  assert.equal(result.status, 'ready-for-policy'); assert.equal(result.liveCodingEnabled, false);
  assert.equal(f.profile.preferences.draftPr, true); assert.equal(f.profile.preferences.planReview, 'approve');
});
test('plan is shown with source, preferences, steps, checks and deliverables before approval', async () => {
  const f = fixture(), prepared = prepareWorkflow(f.profile, f.plan, f.scope);
  const rendered = renderPlan(prepared);
  for (const value of [f.plan.objective, f.scope.sourceSnapshot, prepared.planDigest, 'Affected paths', 'Acceptance criteria', 'Rollback', 'Draft PR', 'Principal:', 'Live coding remains disabled']) assert.ok(rendered.includes(value));
  assert.equal((await evaluateWorkflow(prepared, f.authority, {}, f.clock)).status, 'needs-plan-approval');
  const result = await evaluateWorkflow(prepared, f.authority, { plan: f.issue(prepared, 'plan-review') }, f.clock);
  assert.equal(result.status, 'ready-for-policy'); assert.equal(result.liveCodingEnabled, false);
});
test('receipt cannot move between tasks, projects, principals, clones, source, plans or settings', async t => {
  const f = fixture(), original = prepareWorkflow(f.profile, f.plan, f.scope), id = f.issue(original, 'plan-review');
  const clone = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-review-clone-'))); t.after(() => rmSync(clone, { recursive: true, force: true }));
  const changed = [
    prepareWorkflow(f.profile, f.plan, { ...f.scope, taskId: 'other' }),
    prepareWorkflow({ ...f.profile, projectId: 'other' }, f.plan, { ...f.scope, projectId: 'other' }),
    prepareWorkflow(f.profile, f.plan, { ...f.scope, principalId: 'other' }),
    prepareWorkflow(f.profile, f.plan, { ...f.scope, workspaceRoot: clone }),
    prepareWorkflow(f.profile, f.plan, { ...f.scope, sourceSnapshot: 'b'.repeat(64) }),
    prepareWorkflow(f.profile, { ...f.plan, steps: ['Different implementation'] }, f.scope),
    prepareWorkflow(f.profile, f.plan, f.scope, { draftPr: false }),
    prepareWorkflow({ ...f.profile, documents: { ...f.profile.documents, srs: 'docs/requirements.md' } }, f.plan, f.scope),
    prepareWorkflow(f.profile, f.plan, { ...f.scope, expiresAt: 3000 }),
  ];
  for (const prepared of changed) assert.equal((await evaluateWorkflow(prepared, f.authority, { plan: id }, f.clock)).status, 'needs-plan-approval');
});
test('video needs a separate verified pre-edit baseline; text cannot replace required recording', async () => {
  const f = fixture(), prepared = prepareWorkflow(f.profile, f.plan, f.scope, { evidence: 'both' }), plan = f.issue(prepared, 'plan-review');
  assert.equal((await evaluateWorkflow(prepared, f.authority, { plan }, f.clock)).status, 'needs-before-video');
  assert.equal((await evaluateWorkflow(prepared, f.authority, { plan, beforeVideo: plan }, f.clock)).status, 'needs-before-video');
  assert.equal((await evaluateWorkflow(prepared, f.authority, { plan, beforeVideo: f.issue(prepared, 'before-video') }, f.clock)).status, 'ready-for-policy');
  assert.ok(prepared.deliverables.some(item => item.includes('text report'))); assert.ok(prepared.deliverables.some(item => item.includes('recordings')));
});
test('untrusted getters, forged preparation, terminal controls and path aliases fail before authority', async () => {
  const f = fixture(); let invoked = false;
  const malicious = { ...f.profile, get preferences() { invoked = true; return f.profile.preferences; } };
  assert.throws(() => prepareWorkflow(malicious, f.plan, f.scope)); assert.equal(invoked, false);
  const prepared = prepareWorkflow(f.profile, f.plan, f.scope);
  const forged = { ...prepared, planDigest: '0'.repeat(64) };
  await assert.rejects(evaluateWorkflow(forged, f.authority, {}, f.clock), /modified/);
  await assert.rejects(evaluateWorkflow({ ...prepared, get scope() { invoked = true; return prepared.scope; } } as WorkflowPreparation, f.authority, {}, f.clock)); assert.equal(invoked, false);
  for (const path of ['../outside', 'C:/outside', 'src\\file.ts', 'src/file:stream', 'src/CON.ts', 'src/file.', '.git/config']) assert.throws(() => prepareWorkflow(f.profile, { ...f.plan, changedPaths: [path] }, f.scope));
  assert.throws(() => prepareWorkflow(f.profile, { ...f.plan, objective: '\u001b[2Japprove me' }, f.scope));
});
test('expired approval and verifier failure do not establish workflow readiness', async () => {
  const f = fixture(), prepared = prepareWorkflow(f.profile, f.plan, f.scope), id = f.issue(prepared, 'plan-review');
  await assert.rejects(evaluateWorkflow(prepared, f.authority, { plan: id }, () => 2000), /expired/);
  assert.equal((await evaluateWorkflow(prepared, { async verify() { throw new Error('unavailable'); } }, { plan: id }, f.clock)).status, 'needs-plan-approval');
  let now = 1000;
  await assert.rejects(evaluateWorkflow(prepared, { async verify() { now = 2000; return true; } }, { plan: id }, () => now), /expired/);
});
