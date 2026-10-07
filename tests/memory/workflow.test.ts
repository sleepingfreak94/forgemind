import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixture.js';
import { fixture as workflowFixture } from '../project-workflow/fixture.js';
import { prepareWorkflow, evaluateWorkflow, renderPlan } from '../../src/project-workflow/preflight.js';
import { digest, serialize } from '../../src/context-engine/validation.js';

test('memory citations are in plan rendering and source-bound review; changed recall invalidates approval', async () => {
  const f = fixture(), w = workflowFixture(); try {
    const id = f.memory.add(f.input()); f.memory.validate(id, id);
    const memory = f.memory.packet('SQLite'), scope = { ...w.scope, workspaceRoot: f.root };
    const prepared = prepareWorkflow(w.profile, w.plan, scope, {}, memory);
    assert.match(renderPlan(prepared), /quoted evidence only/); assert.match(renderPlan(prepared), /ADR-0001-storage/);
    const receipt = w.issue(prepared, 'plan-review');
    assert.equal((await evaluateWorkflow(prepared, w.authority, { plan: receipt }, w.clock)).status, 'ready-for-policy');
    const withoutMemory = prepareWorkflow(w.profile, w.plan, scope);
    assert.notEqual(prepared.planDigest, withoutMemory.planDigest);
    assert.equal((await evaluateWorkflow(withoutMemory, w.authority, { plan: receipt }, w.clock)).status, 'needs-plan-approval');
    f.memory.remove(id, id); assert.throws(() => f.memory.assertCurrent(memory));
    const changed = prepareWorkflow(w.profile, w.plan, scope, {}, f.memory.packet('SQLite'));
    assert.equal((await evaluateWorkflow(changed, w.authority, { plan: receipt }, w.clock)).status, 'needs-plan-approval');
    assert.throws(() => prepareWorkflow(w.profile, w.plan, scope, {}, { ...memory, digest: 'b'.repeat(64) }));
    const { digest: _, ...body } = memory, foreign = { ...body, projectId: 'foreign' };
    assert.throws(() => prepareWorkflow(w.profile, w.plan, scope, {}, { ...foreign, digest: digest(serialize(foreign)) }), /scope/);
  } finally { f.dispose(); }
});

test('packet freshness and expiry fail before and after owner verification', async () => {
  const f = fixture(), w = workflowFixture(); try {
    const id = f.memory.add({ ...f.input(), expiresAt: 1500 }); f.memory.validate(id, id);
    const memory = f.memory.packet('SQLite'), prepared = prepareWorkflow(w.profile, w.plan, { ...w.scope, workspaceRoot: f.root }, {}, memory);
    const receipt = w.issue(prepared, 'plan-review'); let now = 1000;
    await assert.rejects(evaluateWorkflow(prepared, { async verify() { now = 1500; return true; } }, { plan: receipt }, () => now), /expired memory/);
    writeFileSync(join(f.root, f.path), '# Changed source\nStatus: Accepted\nSQLite changed policy.');
    assert.throws(() => f.memory.assertCurrent(memory));
  } finally { f.dispose(); }
});
