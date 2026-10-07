import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexDriver } from '../agent-drivers/codex.js';
import { JsonlRpc } from '../agent-drivers/jsonl-rpc.js';
import { PassThroughContextOptimizer } from '../context-engine/optimizer.js';
import { MemoryOriginalStore } from '../context-engine/originals.js';
import type { OptimizationInput } from '../context-engine/contracts.js';
import { digest, serialize } from '../context-engine/validation.js';

const content = 'INFO build started\nFATAL E42 failed compile';
const packet: OptimizationInput = { schemaVersion: 1, scope: { tenantId: 'demo', principalId: 'owner', projectId: 'demo', taskId: 'ticket',
  invocationId: 'coder', sessionId: 'demo-session', policyVersion: 'v1', sourceSnapshot: digest(content) },
  protected: { objective: 'Diagnose E42', acceptanceCriteria: ['Preserve E42'], permissions: [], policy: 'Read-only', checkpoint: 'Reproduced' },
  evidence: [{ id: 'log', sourceUri: 'artifact:log', sourceVersion: 'v1', content, contentDigest: digest(content), compressible: false }],
  budget: { maxBytes: 4096 }, expiresAt: Date.now() + 10000 };
const originals = new MemoryOriginalStore({ ttlMs: 10000, maxBytes: 65536 });
const optimizer = new PassThroughContextOptimizer({ originals, authority: { async authorize(access) {
  const allowed = serialize(access.scope) === serialize(packet.scope) && access.evidence.every(e => e.id === 'log' &&
    e.contentDigest === digest(content) && e.sourceUri === 'artifact:log' && e.sourceVersion === 'v1' && e.compressible === false);
  return { allowed, receiptId: `demo-${access.phase}` };
} } });
let stopped = false;
const workspaceRoot = realpathSync(process.cwd());
const driver = new CodexDriver({ workspaceRoot, model: 'fixture-model', effort: 'high', optimizer,
  maxRuntimeMs: 5000, maxOutputBytes: 65536, host: { async open(intent, signal) {
    signal.throwIfAborted(); assert.equal(intent.model, 'fixture-model'); assert.equal(intent.mode, 'read-only');
    const child = spawn(process.execPath, [fileURLToPath(new URL('./codex-fixture-server.js', import.meta.url))], {
      cwd: workspaceRoot, env: process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}, stdio: ['pipe', 'pipe', 'ignore'], shell: false,
    });
    const exit = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    const rpc = new JsonlRpc(child.stdout, child.stdin, { timeoutMs: 1000, maxLineBytes: 8192, maxTotalBytes: 65536 });
    return { rpc, receiptId: 'fixture-process-reservation', async check(current) { current.throwIfAborted(); },
      async stop() { child.kill('SIGKILL'); await exit; stopped = true; },
      async finish(terminal) { assert.equal(stopped, true); return `fixture-terminal-${terminal.status}`; } };
  } } });
try {
  const result = await driver.run(packet);
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'Fixture diagnosis: E42 retained');
  console.log(JSON.stringify({ scenario: 'deterministic stdio subprocess', status: result.status, output: result.output,
    viewDigest: result.viewDigest, outputDigest: result.outputDigest, receipts: result.receipts, processReaped: stopped,
    nativeCodexTurns: 0, providerCalls: 0 }, null, 2));
} finally { originals.clear(); }
