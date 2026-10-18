import { randomUUID } from 'node:crypto';
import { dataSnapshot, freeze, object } from '../context-engine/validation.js';
import type { ExternalReservation, TaskGrant } from '../policy/contracts.js';
import { LocalPolicyRuntime } from '../policy/runtime.js';
import { text } from '../policy/validation.js';
import type { ContinuationCheckpoint, ResumeBinding, ResumeLease, ResumeTarget } from './continuation-contracts.js';
import { ContinuationStore } from './continuation-store.js';
import { digestText, hash, remainingBudget, subset, validateTarget } from './continuation-validation.js';

/** This exact envelope is an operation to prepare a handoff, never a native inference command. */
export function handoffEnvelope(digest: string, checkpoint: Readonly<ContinuationCheckpoint>, target: ResumeTarget): Readonly<Record<string, unknown>> {
  digestText(digest);
  return freeze({ schemaVersion: 1, operation: 'continuation.prepare', checkpointDigest: digest,
    projectId: checkpoint.projectId, root: checkpoint.root, taskId: checkpoint.taskId,
    sourceIdentity: checkpoint.sourceIdentity, policyVersion: checkpoint.policyVersion, target: dataSnapshot(target),
    remainingBudget: remainingBudget(checkpoint) });
}
export function handoffResource(digest: string, checkpoint: Readonly<ContinuationCheckpoint>, target: ResumeTarget): string {
  return `host:${hash(handoffEnvelope(digest, checkpoint, target))}`;
}
export interface PrepareResumeOptions {
  store: ContinuationStore;
  runtime: LocalPolicyRuntime;
  binding: ResumeBinding;
  /** Host-owned fresh policy retrieval; errors deny. This is not a model-supplied acceptance flag. */
  currentPolicy: () => string;
}
function bindingSnapshot(raw: ResumeBinding, root: string, now: number): Readonly<ResumeBinding> {
  const copy = dataSnapshot(raw);
  object(copy, ['digest', 'projectId', 'root', 'taskId', 'parentGrantId', 'instanceId', 'invocationId', 'target']);
  if (Object.keys(copy).length !== 8) throw new Error('missing resume binding');
  digestText(copy.digest);
  for (const field of ['projectId', 'taskId', 'parentGrantId', 'instanceId', 'invocationId'] as const) text(copy[field], field, 128);
  text(copy.root, 'root', 4096);
  return freeze({ ...copy, target: validateTarget(root, copy.target, now) });
}
/** Consumes historical evidence only after obtaining real current policy authority. No effects are replayed. */
export function prepareResume(options: PrepareResumeOptions): ResumeLease {
  const { store, runtime } = options;
  if (!(runtime instanceof LocalPolicyRuntime) || !(store instanceof ContinuationStore) || typeof options.currentPolicy !== 'function') throw new Error('trusted host ports required');
  const binding = bindingSnapshot(options.binding, store.root, store.now());
  const { checkpoint, digest } = store.inspect(binding.digest);
  const target = binding.target;
  const budget = remainingBudget(checkpoint, true);
  if (binding.projectId !== checkpoint.projectId || binding.taskId !== checkpoint.taskId || binding.root !== checkpoint.root ||
      runtime.workspaceRoot !== checkpoint.root || binding.instanceId === checkpoint.origin.instanceId ||
      target.expiresAt > checkpoint.expiresAt || !subset(target.capabilities, checkpoint.requestCapabilities)) throw new Error('resume binding or ceiling mismatch');
  const envelope = handoffEnvelope(digest, checkpoint, target);
  const resource = handoffResource(digest, checkpoint, target);
  let child: TaskGrant | undefined;
  let reservation: ExternalReservation | undefined;
  let externalFinished = false;
  let fence: number | undefined;
  let prepared = false;
  const live = (grantId: string, invocationId: string): TaskGrant => {
    if (store.currentSource() !== checkpoint.sourceIdentity || options.currentPolicy() !== checkpoint.policyVersion ||
        store.cancelled(checkpoint.taskId) || store.now() >= checkpoint.expiresAt) throw new Error('source, policy, cancellation or expiry changed');
    // Runtime receipts and grants are re-read from its durable owner ledger, not from the envelope.
    const receipts = runtime.receipts();
    if (receipts.findLast(r => r.event === 'session.started')?.sessionId !== runtime.sessionId ||
        receipts.at(-1)?.policyVersion !== checkpoint.policyVersion) throw new Error('stale runtime session or policy');
    let next: string | undefined = grantId;
    let first: TaskGrant | undefined;
    const seen = new Set<string>();
    while (next !== undefined) {
      if (seen.size >= 9 || seen.has(next)) throw new Error('invalid live grant chain');
      seen.add(next);
      const grant = runtime.grant(next);
      if (!grant || grant.revoked || grant.expiresAt <= store.now() || grant.principalId !== runtime.principal.id ||
          grant.sessionId !== runtime.sessionId || grant.policyVersion !== checkpoint.policyVersion ||
          grant.repositoryId !== checkpoint.projectId || grant.workspaceRoot !== checkpoint.root ||
          grant.taskId !== checkpoint.taskId || grant.usedActions >= grant.maxActions) throw new Error('inactive or mismatched grant');
      if (!first) {
        first = grant;
        if (grant.invocationId !== invocationId) throw new Error('invocation mismatch');
      }
      next = grant.parentId;
    }
    if (!first) throw new Error('missing fresh parent');
    return first;
  };
  const parent = live(binding.parentGrantId, runtime.grant(binding.parentGrantId)?.invocationId ?? 'missing');
  if (binding.invocationId === parent.invocationId || !subset(target.capabilities, parent.capabilities)) throw new Error('parent intersection or invocation mismatch');
  try {
    // CAS precedes any external reservation. Failures after this point consume the checkpoint forever.
    fence = store.consume(digest, binding.instanceId);
    live(parent.id, parent.invocationId);
    reservation = runtime.reserveExternal(parent.id, parent.invocationId, {
      requestId: randomUUID(), action: 'command.run', resource, sourceSnapshot: checkpoint.sourceIdentity,
    }, envelope);
    reservation.check();
    store.checkFence(digest, binding.instanceId, fence, true);
    live(parent.id, parent.invocationId);
    child = runtime.issueGrant({ ...target, parentId: parent.id, taskId: checkpoint.taskId, invocationId: binding.invocationId });
    live(child.id, binding.invocationId);
    reservation.check();
    store.checkFence(digest, binding.instanceId, fence, true);
    const finishReceipt = reservation.finish('completed', { viewDigest: hash(envelope) });
    externalFinished = true;
    store.terminalize(digest, binding.instanceId, fence, 'prepared');
    prepared = true;
    const issued = freeze(structuredClone(child));
    const packet = freeze({ digest, checkpoint, instanceId: binding.instanceId, invocationId: binding.invocationId,
      role: target.role, fence, sourceIdentity: checkpoint.sourceIdentity, remainingBudget: budget,
      receiptIds: [reservation.receiptId, finishReceipt] });
    let revoked = false;
    return Object.freeze({ packet, grant: issued,
      check: () => {
        if (revoked) throw new Error('revoked resume lease');
        store.checkFence(digest, binding.instanceId, packet.fence);
        const current = live(issued.id, binding.invocationId);
        if (current.role !== target.role || !subset(current.capabilities, target.capabilities) ||
            !subset(current.capabilities, checkpoint.requestCapabilities)) throw new Error('live grant changed');
      },
      revoke: () => {
        revoked = true;
        // Persist cancellation before revocation; the lease stays denied if either ledger fails.
        try { store.cancel(checkpoint.taskId); } finally {
          try { runtime.revoke(issued.id); } catch (error) { runtime.close(); throw error; }
        }
      },
    });
  } catch (error) {
    const failures: unknown[] = [error];
    // Never leave an issued child usable when either receipt or continuation settlement fails.
    if (child) {
      try { runtime.revoke(child.id); } catch (cleanup) { failures.push(cleanup); runtime.close(); }
    }
    if (reservation && !externalFinished) {
      try { reservation.finish('indeterminate', { viewDigest: hash(envelope) }, 'cleanup-uncertain'); }
      catch (cleanup) { failures.push(cleanup); }
    }
    if (fence !== undefined && !prepared) {
      try { store.terminalize(digest, binding.instanceId, fence, 'failed'); } catch (cleanup) { failures.push(cleanup); }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'continuation preparation failed; checkpoint remains consumed');
    throw error;
  }
}
