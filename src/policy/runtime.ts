import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { FakeAdapter } from '../agent-drivers/fake.js';
import type { ActionRequest, ExecutionResult, ExternalReservation, GrantInput, InvocationContext, LocalPrincipal, PolicyDecision, Receipt, TaskGrant } from './contracts.js';
import { contains, evaluate } from './evaluator.js';
import { PolicyStore } from './store.js';
import { grantInput, inside, request, text } from './validation.js';
import { dataSnapshot, object, serialize } from '../context-engine/validation.js';

export interface RuntimeOptions {
  stateDirectory: string;
  workspaceRoot: string;
  repositoryId: string;
  /** Host-owned immutable source identity, including dirty/untracked inputs. */
  sourceSnapshot: () => string;
  clock?: () => number;
  newId?: () => string;
}

/** Privileged host facade. An agent receives only a bound execute endpoint over IPC. */
export class LocalPolicyRuntime {
  readonly principal: LocalPrincipal;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly #options: RuntimeOptions;
  readonly #store: PolicyStore;
  readonly #clock: () => number;
  readonly #id: () => string;
  readonly #adapter = new FakeAdapter();
  #closed = false;

  static open(options: RuntimeOptions): LocalPolicyRuntime { return new LocalPolicyRuntime(options); }
  private constructor(options: RuntimeOptions) {
    this.#options = { ...options };
    this.#clock = options.clock ?? Date.now;
    this.#id = options.newId ?? randomUUID;
    text(options.repositoryId, 'repository ID', 128);
    this.workspaceRoot = realpathSync(options.workspaceRoot);
    const state = resolve(options.stateDirectory);
    if (inside(this.workspaceRoot, state)) throw new Error('state directory must be outside agent workspace');
    if (!process.getuid) throw new Error('local owner mode currently requires a POSIX user identity');
    this.#store = new PolicyStore(state, process.getuid());
    try {
      const boot = this.#store.transaction(() => {
        const stored = this.#store.meta('principal');
        const principal: LocalPrincipal = stored ? JSON.parse(stored) as LocalPrincipal : { id: this.#id(), osUid: process.getuid!() };
        if (principal.osUid !== process.getuid!()) throw new Error('owner mismatch');
        const registration = JSON.stringify({ repositoryId: options.repositoryId, workspaceRoot: this.workspaceRoot });
        const existing = this.#store.meta('registration');
        if (existing && existing !== registration) throw new Error('state belongs to another workspace');
        this.#store.setMeta('registration', registration);
        this.#store.setMeta('principal', JSON.stringify(principal));
        if (!this.#store.meta('policyVersion')) this.#store.setMeta('policyVersion', 'local-v1');
        this.#store.setMeta(`seenVersion:${this.#store.meta('policyVersion')}`, 'yes');
        const sessionId = this.#id();
        this.#store.setMeta('activeSession', sessionId);
        return { principal, sessionId };
      });
      this.principal = Object.freeze(boot.principal);
      this.sessionId = boot.sessionId;
      this.#store.transaction(() => this.#receipt('session.started', 'allow', 'trusted-local-launch'));
      this.#store.transaction(() => {
        for (const attempt of this.#store.pendingExternal()) {
          attempt.status = 'indeterminate'; this.#store.saveExternal(attempt);
          this.#receipt('external.recovered', 'indeterminate', 'previous-host-session', attempt.context, attempt.intent, attempt.digest);
        }
      });
    } catch (error) { this.#store.close(); throw error; }
  }
  get fake(): Pick<FakeAdapter, 'calls' | 'read'> {
    return Object.freeze({ calls: this.#adapter.calls, read: (path: string) => this.#adapter.read(path) });
  }
  receipts(): Receipt[] { return this.#store.receipts(); }
  grant(id: string): TaskGrant | undefined { return this.#store.grant(id); }
  close(): void { if (!this.#closed) { this.#store.close(); this.#closed = true; } }
  #active(): void {
    if (this.#store.meta('activeSession') !== this.sessionId) throw new Error('stale-session');
  }
  #source(): string {
    const source = this.#options.sourceSnapshot();
    text(source, 'trusted source snapshot', 256);
    return source;
  }
  #chain(id: string): TaskGrant[] {
    const chain: TaskGrant[] = [];
    let next: string | undefined = id;
    while (next) {
      if (chain.length > 8 || chain.some(g => g.id === next)) throw new Error('invalid grant ancestry');
      const grant = this.#store.grant(next);
      if (!grant) { if (chain.length) throw new Error('missing grant ancestor'); return []; }
      chain.push(grant);
      next = grant.parentId;
    }
    return chain;
  }
  #live(chain: TaskGrant[], invocationId: string, intent: ActionRequest, reserved = false): string | undefined {
    if (this.#store.meta('activeSession') !== this.sessionId) return 'stale-session';
    return evaluate(chain, intent, {
      principalId: this.principal.id, sessionId: this.sessionId,
      policyVersion: this.#store.meta('policyVersion')!, repositoryId: this.#options.repositoryId,
      workspaceRoot: this.workspaceRoot, invocationId, now: this.#clock(), sourceSnapshot: this.#source(),
      budgetReserved: reserved,
    });
  }
  #receipt(event: string, outcome: string, reason: string, context?: InvocationContext, intent?: ActionRequest, digest?: string, terminalEvidence?: Receipt['terminalEvidence']): string {
    const id = this.#id();
    const grant = context ? this.#store.grant(context.grantId) : undefined;
    this.#store.append({ id, event, outcome, reason, timestamp: this.#clock(),
      principalId: this.principal.id, sessionId: this.sessionId,
      policyVersion: this.#store.meta('policyVersion')!, sourceSnapshot: this.#source(),
      ...(context ? { grantId: context.grantId, invocationId: context.invocationId } : {}),
      ...(grant ? { taskId: grant.taskId } : {}),
      ...(intent ? { requestId: intent.requestId, action: intent.action, resource: intent.resource } : {}),
      ...(digest ? { requestDigest: digest } : {}),
      ...(terminalEvidence ? { terminalEvidence } : {}),
    });
    return id;
  }
  #digest(context: InvocationContext, intent: ActionRequest): string {
    return createHash('sha256').update(JSON.stringify({ context, intent,
      sessionId: this.sessionId, policyVersion: this.#store.meta('policyVersion') })).digest('hex');
  }
  #ownerOperation<T>(event: string, work: () => T): T {
    try { return this.#store.transaction(() => { this.#active(); return work(); }); }
    catch (error) {
      this.#store.transaction(() => this.#receipt(`${event}.denied`, 'deny', 'invalid-owner-operation'));
      throw error;
    }
  }

  /** Owner-only operation. Delegation must retain task scope and reduce every limit. */
  issueGrant(input: GrantInput): TaskGrant {
    try {
      return this.#store.transaction(() => {
        this.#active();
        const value = grantInput(this.workspaceRoot, input, this.#clock());
        if (value.parentId) {
          const chain = this.#chain(value.parentId);
          const parent = chain[0];
          if (!parent) throw new Error('unknown parent');
          for (const ancestor of chain) {
            if (ancestor.revoked || ancestor.expiresAt <= this.#clock() || ancestor.sessionId !== this.sessionId ||
                ancestor.policyVersion !== this.#store.meta('policyVersion')) throw new Error('inactive parent');
          }
          if (value.taskId !== parent.taskId || value.expiresAt > parent.expiresAt ||
              value.remainingDepth >= parent.remainingDepth || value.maxActions > parent.maxActions - parent.usedActions ||
              value.maxChildren > parent.maxChildren || this.#store.childCount(parent.id) >= parent.maxChildren ||
              value.capabilities.some(c => !contains(parent.capabilities, c))) throw new Error('child grant escalation');
        }
        const grant: TaskGrant = { ...value, id: this.#id(), principalId: this.principal.id,
          sessionId: this.sessionId, repositoryId: this.#options.repositoryId, workspaceRoot: this.workspaceRoot,
          policyVersion: this.#store.meta('policyVersion')!, issuedAt: this.#clock(), usedActions: 0, revoked: false };
        this.#store.insertGrant(grant);
        this.#receipt('grant.issued', 'allow', 'owner-scoped-grant', { grantId: grant.id, invocationId: grant.invocationId });
        return structuredClone(grant);
      });
    } catch (error) {
      this.#store.transaction(() => this.#receipt('grant.denied', 'deny', 'invalid-or-escalating-grant'));
      throw error;
    }
  }

  updatePolicyVersion(version: string): void {
    text(version, 'policy version', 128);
    this.#ownerOperation('policy.change', () => {
      if (this.#store.meta(`seenVersion:${version}`)) throw new Error('policy version cannot be reused');
      this.#store.setMeta('policyVersion', version);
      this.#store.setMeta(`seenVersion:${version}`, 'yes');
      this.#receipt('policy.changed', 'allow', 'owner-policy-change');
    });
  }
  revoke(grantId: string): void {
    this.#ownerOperation('grant.revoke', () => {
      const grant = this.#store.grant(grantId);
      if (!grant) throw new Error('unknown grant');
      grant.revoked = true;
      this.#store.saveGrant(grant);
      this.#receipt('grant.revoked', 'allow', 'owner-revocation', { grantId, invocationId: grant.invocationId });
    });
  }
  /** Owner-only, exact-intent, single-use approval; never broadens the grant. */
  approve(grantId: string, invocationId: string, raw: unknown): void {
    this.#ownerOperation('approval', () => {
      const intent = request(this.workspaceRoot, raw);
      const context = { grantId, invocationId };
      const chain = this.#chain(grantId);
      const reason = this.#live(chain, invocationId, intent);
      if (reason || this.#store.attempted(intent.requestId)) throw new Error(reason ?? 'replayed-request');
      if (!['git.merge', 'release'].includes(intent.action)) throw new Error('action does not require approval');
      const digest = this.#digest(context, intent);
      this.#store.saveApproval({ digest, grantId, expiresAt: Math.min(this.#clock() + 300000, ...chain.map(g => g.expiresAt)), consumed: false });
      this.#receipt('approval.granted', 'allow', 'owner-exact-intent-approval', context, intent, digest);
    });
  }
  /** Bind from trusted invocation registration; never take this context from model JSON. */
  bind(grantId: string, invocationId: string): { execute: (raw: unknown) => ExecutionResult } {
    text(grantId, 'grant ID', 128); text(invocationId, 'invocation ID', 128);
    const context = Object.freeze({ grantId, invocationId });
    return Object.freeze({ execute: (raw: unknown) => this.#execute(context, raw) });
  }
  /** Privileged host API, not the worker endpoint. Authorizes no effects by itself.
   * A real executor must enforce the sealed resource and reap before finishing.
   */
  reserveExternal(grantId: string, invocationId: string, raw: unknown, envelope?: unknown): ExternalReservation {
    text(grantId, 'grant ID', 128); text(invocationId, 'invocation ID', 128);
    const context = Object.freeze({ grantId, invocationId });
    const intent = request(this.workspaceRoot, raw);
    if (intent.action !== 'command.run') throw new Error('external executor requires command envelope');
    const envelopeJson = envelope === undefined ? undefined : serialize(dataSnapshot(envelope));
    if (envelopeJson && intent.resource !== `host:${createHash('sha256').update(envelopeJson).digest('hex')}`) throw new Error('envelope digest mismatch');
    const digest = this.#digest(context, intent);
    const decision = this.#store.transaction(() => {
      const chain = this.#chain(grantId);
      let reason = this.#live(chain, invocationId, intent);
      if (!reason && this.#store.attempted(intent.requestId)) reason = 'replayed-request';
      const receiptId = this.#receipt('external.decided', reason ? 'deny' : 'allow', reason ?? 'within-grant', context, intent, digest);
      if (!reason) {
        this.#store.reserve(intent.requestId, digest);
        for (const grant of chain) { grant.usedActions++; this.#store.saveGrant(grant); }
        this.#store.saveExternal({ context, intent, digest, sessionId: this.sessionId, status: 'reserved', ...(envelopeJson ? { envelopeJson } : {}) });
      }
      return { receiptId, reason };
    });
    if (decision.reason) throw new Error(decision.reason);
    return Object.freeze({ receiptId: decision.receiptId,
      check: () => this.#store.transaction(() => {
        const attempt = this.#store.external(intent.requestId);
        const reason = this.#live(this.#chain(grantId), invocationId, intent, true);
        if (!attempt || attempt.digest !== digest || attempt.status !== 'reserved' || reason) throw new Error(reason ?? 'inactive-reservation');
      }),
      finish: (status: Parameters<ExternalReservation['finish']>[0], rawEvidence?: Receipt['terminalEvidence'], executorReason = 'executor-terminal') => {
        if (!['executor-terminal', 'host-enforcement', 'source-or-runtime-drift', 'cancelled', 'deadline', 'worker-exit', 'output-limit', 'sandbox-unavailable', 'spawn-failed', 'cleanup-uncertain'].includes(executorReason)) throw new Error('invalid executor reason');
        const evidence = rawEvidence ? dataSnapshot(rawEvidence) : undefined;
        if (evidence) {
          object(evidence, ['viewDigest', 'outputDigest']);
          for (const value of Object.values(evidence)) if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid terminal digest');
          if (!evidence.viewDigest) throw new Error('missing terminal view');
        }
        const terminal = this.#store.transaction(() => {
        if (!['completed', 'failed', 'interrupted', 'denied', 'cancelled', 'timed-out', 'indeterminate'].includes(status)) throw new Error('invalid terminal status');
        const attempt = this.#store.external(intent.requestId);
        if (!attempt || attempt.digest !== digest || attempt.status !== 'reserved') throw new Error('inactive-reservation');
        const reason = this.#live(this.#chain(grantId), invocationId, intent, true);
        if (status === 'completed' && reason) status = 'denied';
        const receiptId = this.#receipt('external.finished', status, reason ?? executorReason, context, intent, digest, evidence);
        if (evidence) attempt.terminalEvidence = evidence;
        attempt.status = status; this.#store.saveExternal(attempt);
        return { receiptId, denied: status === 'denied' ? reason : undefined };
        });
        if (terminal.denied) throw new Error(terminal.denied);
        return terminal.receiptId;
      },
    });
  }
  #execute(context: InvocationContext, raw: unknown): ExecutionResult {
    let intent: Readonly<ActionRequest>;
    try { intent = request(this.workspaceRoot, raw); }
    catch {
      const receiptId = this.#store.transaction(() => this.#receipt('action.decided', 'deny', 'invalid-request', context));
      return { decision: { receiptId, outcome: 'deny', reason: 'invalid-request' }, status: 'blocked' };
    }
    const digest = this.#digest(context, intent);
    const decision = this.#store.transaction((): PolicyDecision => {
      const chain = this.#chain(context.grantId);
      let reason = this.#live(chain, context.invocationId, intent);
      if (!reason && this.#store.attempted(intent.requestId)) reason = 'replayed-request';
      let outcome: PolicyDecision['outcome'] = reason ? 'deny' : 'allow';
      const approval = this.#store.approval(digest);
      if (!reason && ['git.merge', 'release'].includes(intent.action) &&
          (!approval || approval.consumed || approval.expiresAt <= this.#clock())) {
        outcome = 'approval-required'; reason = 'owner-approval-required';
      }
      reason ??= 'within-grant';
      const receiptId = this.#receipt('action.decided', outcome, reason, context, intent, digest);
      if (outcome === 'allow') {
        this.#store.reserve(intent.requestId, digest);
        for (const grant of chain) { grant.usedActions++; this.#store.saveGrant(grant); }
        if (approval) { approval.consumed = true; this.#store.saveApproval(approval); }
      }
      return { receiptId, outcome, reason };
    });
    if (decision.outcome !== 'allow') return { decision, status: 'blocked' };
    // Durable reservation precedes dispatch. A later crash/receipt failure cannot replay it.
    return this.#store.transaction(() => {
      let reason: string | undefined;
      try { request(this.workspaceRoot, intent); reason = this.#live(this.#chain(context.grantId), context.invocationId, intent, true); }
      catch { reason = 'invalid-resource-at-dispatch'; }
      if (!reason && ['git.merge', 'release'].includes(intent.action)) {
        const approval = this.#store.approval(digest);
        if (!approval || approval.expiresAt <= this.#clock()) reason = 'approval-expired-at-dispatch';
      }
      if (reason) {
        const receiptId = this.#receipt('execution.blocked', 'deny', reason, context, intent, digest);
        return { decision: { receiptId, outcome: 'deny', reason }, status: 'blocked' };
      }
      try { this.#adapter.execute(intent); }
      catch {
        this.#receipt('execution.failed', 'allow', 'adapter-failed', context, intent, digest);
        return { decision, status: 'failed' };
      }
      this.#receipt('execution.succeeded', 'allow', 'fake-adapter-completed', context, intent, digest);
      return { decision, status: 'succeeded' };
    });
  }
}
