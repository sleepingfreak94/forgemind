import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeOwner } from '../../src/live-workflow/native-executor-owner.js';
import { textHash } from '../../src/live-workflow/qualification-validation.js';
import type { NativeTask } from '../../src/live-workflow/native-executor-contracts.js';

/** Structural lifecycle fixture: no launch, account, provider or live certification. */
export function runtimeReceiptFixture(binding: string) {
  const shared = { timestamp: 900, principalId: 'owner', sessionId: 'session', policyVersion: 'local-v1',
    sourceSnapshot: binding, taskId: 'task', grantId: 'runtime-grant', invocationId: 'lease',
    requestId: 'runtime-request', action: 'command.run', resource: 'host:' + textHash('canonical-plan'),
    requestDigest: textHash('runtime-request'), reason: 'executor-terminal' };
  return [
    { ...shared, id: 'runtime-receipt', event: 'external.decided', outcome: 'allow' },
    { ...shared, id: 'runtime-terminal', event: 'external.finished', outcome: 'completed',
      terminalEvidence: { viewDigest: textHash('JSON.stringify(plan)') } },
  ] as const;
}

/** Real NativeOwner SQLite export, using only reserve/finish/phase; never forks. */
export function ownerTransitionFixture(initial: string, final: string) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'qualification-owner-'));
  mkdirSync(join(dir, 'workspace'), { mode: 0o700 });
  const task: NativeTask = { project: 'project', task: 'task', source: initial, root: join(dir, 'workspace'),
    model: 'gpt-6.1-sol', effort: 'medium', readPaths: ['file.ts'], writePaths: ['file.ts'],
    checks: [{ id: 'strict', executable: '/node', args: [], timeoutMs: 100 }],
    budget: { runtimeMs: 5000, turns: null, toolCalls: null, inputBytes: 10000, resultBytes: 10000, wireBytes: 10000, outputBytes: 10000, retries: 0 } };
  let owner: NativeOwner | undefined;
  try {
    owner = new NativeOwner(join(dir, 'ledger'), task, Date.now() + 60000, () => {});
    for (const source of [textHash('intermediate-owner-source'), final]) {
      const before = owner.source, transitionReceiptId = randomUUID();
      const reservation = owner.reserve({ kind: 'artifact', source: before,
        detail: { operation: 'native.source-transition', transitionReceiptId, before, source,
          edits: [{ path: 'file.ts', before: textHash('before'), after: textHash('after') }] } });
      reservation.finish('completed', source);
      owner.phase('native.source-transition', source, { transitionReceiptId, before, source });
    }
    return { task, exported: owner.export() };
  } finally { owner?.close(); rmSync(dir, { recursive: true, force: true }); }
}
