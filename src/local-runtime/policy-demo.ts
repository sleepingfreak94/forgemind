import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPolicyRuntime } from '../policy/runtime.js';
import type { ActionRequest } from '../policy/contracts.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-policy-demo-')));
const workspaceRoot = join(base, 'workspace');
mkdirSync(workspaceRoot);
const sourceSnapshot = `sha256:${createHash('sha256').update('empty-demo-workspace').digest('hex')}`;
let id = 0;
const options = { workspaceRoot, stateDirectory: join(base, 'state'), repositoryId: 'demo-repo',
  sourceSnapshot: () => sourceSnapshot, clock: () => 1000, newId: () => `demo-${++id}` };
let runtime = LocalPolicyRuntime.open(options);
try {
  const parent = runtime.issueGrant({ taskId: 'demo-ticket', invocationId: 'lead', role: 'lead',
    capabilities: [{ action: 'file.write', resource: 'example.ts' }], expiresAt: 10000,
    remainingDepth: 1, maxActions: 5, maxChildren: 1 });
  const child = runtime.issueGrant({ taskId: parent.taskId, invocationId: 'coder', role: 'coder',
    parentId: parent.id, capabilities: parent.capabilities, expiresAt: 9000,
    remainingDepth: 0, maxActions: 2, maxChildren: 0 });
  const execute = runtime.bind(child.id, 'coder').execute;
  const intent = (requestId: string, resource = 'example.ts'): ActionRequest => ({ requestId,
    action: 'file.write', resource, content: 'export const works = true;', sourceSnapshot });
  const allowed = execute(intent('allowed'));
  const outside = execute(intent('outside', '../outside.ts'));
  runtime.revoke(parent.id);
  const revoked = execute(intent('revoked'));
  const calls = runtime.fake.calls.length;
  const owner = runtime.principal.id;
  runtime.close();
  runtime = LocalPolicyRuntime.open(options);
  const restarted = runtime.bind(child.id, 'coder').execute(intent('restart'));
  assert.equal(allowed.status, 'succeeded');
  assert.equal(outside.decision.outcome, 'deny');
  assert.equal(revoked.decision.reason, 'revoked-grant');
  assert.equal(restarted.decision.reason, 'stale-session');
  assert.equal(runtime.principal.id, owner);
  assert.equal(calls, 1);
  console.log(JSON.stringify({ adapter: 'deterministic-fake', allowed: allowed.status,
    outsideWorkspace: outside.decision.outcome, afterParentRevocation: revoked.decision.reason,
    afterRestart: restarted.decision.reason, fakeCallsBeforeRestart: calls,
    principalPreserved: runtime.principal.id === owner, durableReceipts: runtime.receipts().length,
    realFileWrites: 0, providerCalls: 0 }, null, 2));
} finally { runtime.close(); rmSync(base, { recursive: true, force: true }); }
