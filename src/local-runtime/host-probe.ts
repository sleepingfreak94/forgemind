import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalPolicyRuntime } from '../policy/runtime.js';
import { OfflineSeatbeltHost } from '../host-enforcement/host.js';
import { hostResource, prepareHostPlan } from '../host-enforcement/manifest.js';
import { snapshotWorkspace } from '../host-enforcement/workspace.js';
import { initializeParams, record } from '../agent-drivers/codex-wire.js';
import type { DriverIntent } from '../agent-drivers/contracts.js';

// Explicit binary, offline initialize only. Never starts a model thread or turn.
const binary = process.argv[2];
if (!binary || !isAbsolute(binary)) throw new Error('provide an absolute Codex 0.160.0 executable');
const base = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-host-probe-')));
for (const dir of ['source', 'stage', 'scratch']) mkdirSync(join(base, dir), { mode: 0o700 });
const workspace = snapshotWorkspace(join(base, 'source'), join(base, 'stage'), []);
const runtime = LocalPolicyRuntime.open({ stateDirectory: join(base, 'policy'), repositoryId: 'probe', workspaceRoot: workspace.workspaceRoot,
  sourceSnapshot: () => workspace.sourceSnapshot });
const intent: DriverIntent = { driver: 'codex', scope: { tenantId: 'local', principalId: runtime.principal.id, projectId: 'probe', taskId: 'initialize', invocationId: 'worker',
  sessionId: runtime.sessionId, policyVersion: 'local-v1', sourceSnapshot: workspace.sourceSnapshot }, workspaceRoot: workspace.workspaceRoot,
  expiresAt: Date.now() + 10000, model: 'not-invoked', provider: 'openai', effort: 'high', cliVersion: '0.160.0', mode: 'read-only', ephemeral: true,
  viewDigest: '0'.repeat(64), maxRuntimeMs: 5000, maxOutputBytes: 65536 };
try {
  const plan = prepareHostPlan({ intent, executable: binary, args: ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false'], readFiles: [],
    supervisor: fileURLToPath(new URL('../host-enforcement/supervisor.js', import.meta.url)) });
  const grant = runtime.issueGrant({ taskId: 'initialize', invocationId: 'worker', role: 'coder', capabilities: [{ action: 'command.run', resource: hostResource(plan) }],
    expiresAt: intent.expiresAt, remainingDepth: 0, maxActions: 1, maxChildren: 0 });
  const host = new OfflineSeatbeltHost({ runtime, grantId: grant.id, plan, scratchRoot: join(base, 'scratch') });
  const lease = await host.open(intent, new AbortController().signal);
  let status: 'completed' | 'failed' = 'failed';
  try {
    const response = record(await lease.rpc.request('initialize', initializeParams));
    if (typeof response.userAgent !== 'string' || !response.userAgent.includes('0.160.0')) throw new Error('CLI version mismatch');
    await lease.rpc.notify('initialized', {}); await lease.check(new AbortController().signal); status = 'completed';
  } finally { lease.rpc.close(); await lease.stop(); await lease.finish({ status, viewDigest: intent.viewDigest }); }
  console.log(JSON.stringify({ scenario: 'native Codex initialize inside enforced offline host', status, cliVersion: '0.160.0',
    executableDigest: plan.executable.digest, supervisorDigest: plan.supervisor.digest, launchResource: hostResource(plan),
    sandbox: plan.version, credentialInheritance: false, networkAllowed: false, sourceWritesAllowed: false,
    workerReaped: true, nativeModelTurns: 0, providerCalls: 0, receipts: runtime.receipts().filter(r => r.event.startsWith('external.')) }, null, 2));
} catch {
  console.error(JSON.stringify({ scenario: 'native Codex initialize inside enforced offline host', status: 'blocked',
    reason: 'native-initialize-failed-under-offline-profile', targetCliVersion: '0.160.0', liveCodingEnabled: false,
    nativeModelTurns: 0, providerCalls: 0, receipts: runtime.receipts().filter(r => r.event.startsWith('external.')) }, null, 2));
  process.exitCode = 1;
} finally {
  const uncertain = runtime.receipts().some(r => r.outcome === 'indeterminate');
  runtime.close();
  if (uncertain) console.error(JSON.stringify({ retainedPrivateState: base, reason: 'cleanup-indeterminate' }));
  else rmSync(base, { recursive: true, force: true });
}
