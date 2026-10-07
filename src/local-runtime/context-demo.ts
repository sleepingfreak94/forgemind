import assert from 'node:assert/strict';
import { PassThroughContextOptimizer } from '../context-engine/optimizer.js';
import { MemoryOriginalStore } from '../context-engine/originals.js';
import type { OptimizationInput } from '../context-engine/contracts.js';
import { digest, serialize } from '../context-engine/validation.js';

// Synthetic, host-owned fixture; this is not a production authorization implementation.
const content = 'INFO build started\nFATAL E42 failed compile';
const packet: OptimizationInput = {
  schemaVersion: 1,
  scope: { tenantId: 'demo-local', principalId: 'demo-owner', projectId: 'demo-project', taskId: 'demo-task',
    invocationId: 'demo-coder', sessionId: 'demo-session', policyVersion: 'demo-v1', sourceSnapshot: `sha256:${digest(content)}` },
  protected: { objective: 'Diagnose E42', policy: 'No release', permissions: ['artifact:build-log:read'],
    acceptanceCriteria: ['Preserve exact error code'], checkpoint: 'Build failure reproduced' },
  evidence: [{ id: 'build-log', sourceUri: 'artifact:build-log', sourceVersion: 'demo-v1',
    content, contentDigest: digest(content), compressible: true }],
  budget: { maxBytes: 4096 }, expiresAt: Date.now() + 60000,
};
const originals = new MemoryOriginalStore({ ttlMs: 60000, maxBytes: 65536 });
let decisions = 0;
const optimizer = new PassThroughContextOptimizer({ originals, authority: {
  async authorize(access) {
    const allowed = serialize(access.scope) === serialize(packet.scope) && access.evidence.every(e =>
      e.id === 'build-log' && e.contentDigest === digest(content) && e.sourceUri === 'artifact:build-log' &&
      e.sourceVersion === 'demo-v1' && e.compressible === true);
    return { allowed, receiptId: `demo-authority-${++decisions}` };
  },
} });
try {
  const result = await optimizer.optimize(packet);
  const restored = await optimizer.recover(packet.scope, result.view.evidence[0]!.originalReference);
  assert.deepEqual(result.view.protected, packet.protected);
  assert.equal(restored.content, content);
  assert.equal(result.beforeBytes, result.afterBytes);
  console.log(JSON.stringify({ mode: result.optimizerId, protectedSectionsPreserved: true,
    evidencePreserved: true, originalRecovered: true, viewDigest: result.viewDigest,
    beforeBytes: result.beforeBytes, afterBytes: result.afterBytes, hostFixtureDecisions: decisions,
    headroomRequests: 0, providerCalls: 0 }, null, 2));
} finally { originals.clear(); }
