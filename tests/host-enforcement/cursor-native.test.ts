import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CursorDriver } from '../../src/agent-drivers/cursor.js';
import type { CursorIntent } from '../../src/agent-drivers/contracts.js';
import { PassThroughContextOptimizer } from '../../src/context-engine/optimizer.js';
import { MemoryOriginalStore } from '../../src/context-engine/originals.js';
import { digest, serialize } from '../../src/context-engine/validation.js';
import type { OptimizationInput } from '../../src/context-engine/contracts.js';
import { hostResource, prepareHostPlan } from '../../src/host-enforcement/manifest.js';
import { OfflineSeatbeltHost } from '../../src/host-enforcement/host.js';
import { hostFixture } from './fixture.js';

test('Cursor ACP fixture uses real SQLite authorization, strict transport and disposable Seatbelt history', async t => {
  const f = hostFixture(t), content = 'FATAL E42 failed compile';
  const packet: OptimizationInput = { schemaVersion: 1, scope: f.intent.scope, expiresAt: f.intent.expiresAt,
    protected: { objective: 'Diagnose E42', acceptanceCriteria: ['Retain E42'], permissions: [], policy: 'Read-only', checkpoint: 'Reproduced' },
    evidence: [{ id: 'log', sourceUri: 'fixture:log', sourceVersion: 'v1', content, contentDigest: digest(content), compressible: false }], budget: { maxBytes: 4096 } };
  const originals = new MemoryOriginalStore({ ttlMs: 10000, maxBytes: 65536 }); t.after(() => originals.clear());
  const optimizer = new PassThroughContextOptimizer({ originals, authority: { async authorize(access) {
    return { allowed: serialize(access.scope) === serialize(packet.scope) && access.evidence.every(e => e.id === 'log' && e.contentDigest === digest(content)),
      receiptId: `fixture-packet-${access.phase}` }; // Packet authority is synthetic; process authorization is real.
  } } });
  const view = await optimizer.optimize(packet);
  const intent: CursorIntent = { driver: 'cursor', scope: packet.scope, expiresAt: packet.expiresAt, workspaceRoot: f.intent.workspaceRoot,
    model: 'fixture', provider: 'cursor', cliVersion: '2026.07.09-a3815c0', protocolVersion: 1, sessionMode: 'ask', mode: 'read-only',
    ephemeral: false, persistence: 'private-scratch', configuration: { modelOptionId: 'fixture-model', modeOptionId: 'fixture-mode',
      options: [{ configId: 'fixture-model', value: 'fixture' }, { configId: 'fixture-mode', value: 'ask' }] },
    viewDigest: view.viewDigest, maxRuntimeMs: f.intent.maxRuntimeMs, maxOutputBytes: f.intent.maxOutputBytes };
  const script = fileURLToPath(new URL('../../src/local-runtime/cursor-fixture-server.js', import.meta.url));
  const plan = prepareHostPlan({ intent, executable: process.execPath, args: [script], readFiles: [...f.plan.readFiles.map(file => file.path), script], supervisor: f.plan.supervisor.path });
  const grant = f.runtime.issueGrant({ taskId: 'ticket', invocationId: 'worker', role: 'coder', capabilities: [{ action: 'command.run', resource: hostResource(plan) }],
    expiresAt: intent.expiresAt, remainingDepth: 0, maxActions: 1, maxChildren: 0 });
  const host = new OfflineSeatbeltHost({ runtime: f.runtime, grantId: grant.id, plan, scratchRoot: join(f.base, 'scratch') });
  const driver = new CursorDriver({ host, optimizer, workspaceRoot: intent.workspaceRoot, model: intent.model, configuration: intent.configuration,
    maxRuntimeMs: intent.maxRuntimeMs, maxOutputBytes: intent.maxOutputBytes });
  const result = await driver.run(packet), receipt = f.runtime.receipts().at(-1)!;
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'Fixture diagnosis: E42 retained');
  assert.equal(grant.usedActions, 0); assert.equal(f.runtime.grant(grant.id)!.usedActions, 1);
  assert.equal(receipt.outcome, 'completed'); assert.equal(receipt.terminalEvidence!.outputDigest, result.outputDigest);
  assert.deepEqual(readdirSync(join(f.base, 'scratch')), []); assert.equal(f.runtime.fake.calls.length, 0);
});
