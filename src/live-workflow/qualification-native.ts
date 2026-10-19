import { validateTransitionHistory } from './native-transition-evidence.js';
import type { NativeProjection, QualificationEvidence, ImportedPin, UnavailableEvidence } from './qualification-contracts.js';
import { budgetKeys } from './native-executor-contracts.js';
import { assertJson, exact, record, identifier, digest, integer, list, boolean, choice, checkIds, sameSource, textHash, receipts, parseQualificationJson, projectChecks, unavailable, diagnostic, tokens, failureCodes, failurePhases, qualificationError } from './qualification-validation.js';

function nativeTask(raw: unknown, taskId: string, projectId: string): Record<string, unknown> {
  const t = exact(raw, ['project', 'task', 'source', 'root', 'model', 'effort', 'readPaths', 'writePaths', 'checks', 'budget']);
  if (t.task !== taskId || t.project !== projectId || t.model !== 'gpt-6.1-sol') qualificationError();
  choice(t.effort, ['medium', 'high']); digest(t.source);
  if (typeof t.root !== 'string' || t.root.length > 4096 || !t.root.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(t.root) || t.root.split('/').slice(1).some(p => !p || p === '.' || p === '..')) qualificationError();
  for (const key of ['readPaths', 'writePaths']) {
    const paths = list(t[key], 512);
    if (new Set(paths).size !== paths.length) qualificationError();
    paths.forEach(path => {
      if (typeof path !== 'string' || path.length > 4096 || /[\x00-\x1f\x7f\\]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..') || path.startsWith('/')) qualificationError();
    });
  }
  const checks = list(t.checks, 128).map(c => identifier(record(c).id));
  if (!checks.length || new Set(checks).size !== checks.length) qualificationError();
  const budget = exact(t.budget, budgetKeys);
  for (const key of budgetKeys) {
    if ((key === 'turns' || key === 'toolCalls') && budget[key] === null) continue;
    integer(budget[key], key === 'retries' ? 0 : 1, key === 'retries' ? 2 : Number.MAX_SAFE_INTEGER);
  }
  return t;
}
function checkpoint(raw: unknown, task: Record<string, unknown>, parent: string, source: string): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return null;
  const c = exact(raw, ['schema', 'binding', 'source', 'thread', 'stage', 'pending', 'seen', 'counters', 'status']);
  const expected = textHash(JSON.stringify({ ...task, source: undefined, authorityBinding: parent }));
  if (c.schema !== 'native-session-v2' || c.binding !== expected) qualificationError();
  sameSource(c.source, source);
  if (c.thread !== null && (typeof c.thread !== 'string' || c.thread.length > 256)) qualificationError();
  if (typeof c.stage !== 'string' || c.stage.length > 128 || (c.pending !== null && (typeof c.pending !== 'string' || c.pending.length > 256))) qualificationError();
  choice(c.status, ['ready', 'running', 'completed', 'stopped', 'indeterminate']);
  const seen = list(c.seen, 4096).map(s => identifier(s));
  if (new Set(seen).size !== seen.length) qualificationError();
  const counters = exact(c.counters, budgetKeys), budget = record(task.budget);
  for (const key of budgetKeys) {
    const count = integer(counters[key]);
    if (budget[key] !== null && count > (budget[key] as number)) qualificationError();
  }
  return c;
}
/** Legacy phase-only histories cannot establish a policy receipt association. */
function nativeSourceChain(owner: Record<string, unknown> | null, task: Record<string, unknown>, final: string, rows: Record<string, unknown>[]): boolean {
  const initial = digest(task.source);
  if (!owner) return initial === final;
  sameSource(owner.source, final);
  const history = list(owner.phases, 4096), seen = new Set<string>();
  let current = initial;
  for (const raw of history) {
    const p = exact(raw, ['id', 'before_source', 'after_source', 'data']);
    const id = identifier(p.id), before = digest(p.before_source), after = digest(p.after_source);
    if (seen.has(id) || before !== current || before === after || typeof p.data !== 'string') qualificationError();
    seen.add(id);
    const data = exact(parseQualificationJson(p.data), ['transitionReceiptId', 'before', 'source']);
    if (identifier(data.transitionReceiptId) !== id || digest(data.before) !== before || digest(data.source) !== after) qualificationError();
    current = after;
  }
  if (history.length && current !== final) qualificationError();
  if (owner.transitionEvidence !== undefined) {
    validateTransitionHistory(owner.transitionEvidence, history.map(p => record(p)), rows,
      task as Record<string, unknown> & { task: string; writePaths: string[] });
    return current === final;
  }
  return history.length === 0 && initial === final;
}
function finalResultMetadata(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  const f = exact(raw, ['schema', 'trust', 'source', 'turnId', 'messages', 'digest']);
  if (f.schema !== 'native-final-text-v1' || f.trust !== 'evidence-only' || typeof f.source !== 'string' || typeof f.turnId !== 'string') qualificationError();
  digest(f.digest);
  list(f.messages, 4096).forEach(rawMessage => {
    const message = exact(rawMessage, ['id', 'text']);
    if (typeof message.id !== 'string' || typeof message.text !== 'string') qualificationError();
  });
}
function runtimeSettled(rows: Record<string, unknown>[], rowId: unknown, leaseId: unknown, binding: string, taskId: string): boolean {
  const decisions = rows.filter(r => r.event === 'external.decided');
  const terminals = rows.filter(r => r.event === 'external.finished');
  if (decisions.length !== 1 || terminals.length !== 1) return false;
  const decision = decisions[0]!, terminal = terminals[0]!;
  const keys = ['requestId', 'grantId', 'invocationId', 'resource', 'action', 'requestDigest', 'taskId', 'sourceSnapshot', 'principalId', 'sessionId', 'policyVersion'];
  if (keys.some(key => typeof decision[key] !== 'string' || !(decision[key] as string).trim() || decision[key] !== terminal[key])) return false;
  return decision.id === rowId && decision.id !== terminal.id && decision.outcome === 'allow' &&
    decision.invocationId === leaseId && decision.action === 'command.run' &&
    typeof decision.resource === 'string' && /^host:[a-f0-9]{64}$/.test(decision.resource) && !/^host:0{64}$/.test(decision.resource) &&
    typeof decision.requestDigest === 'string' && /^[a-f0-9]{64}$/.test(decision.requestDigest) &&
    decision.taskId === taskId && decision.sourceSnapshot === binding && terminal.outcome === 'completed' &&
    (terminal.timestamp as number) >= (decision.timestamp as number) && terminal.terminalEvidence !== undefined;
}
export function qualifyNative(raw: unknown): QualificationEvidence {
  assertJson(raw);
  const input = exact(raw, ['schema', 'taskId', 'projectId', 'source', 'fixture', 'requiredChecks', 'nativeTask', 'parentBinding', 'result']);
  if (input.schema !== 'qualification-input-v1') qualificationError(); checkIds(input.requiredChecks);
  const taskId = identifier(input.taskId), projectId = identifier(input.projectId), source = digest(input.source);
  const task = nativeTask(input.nativeTask, taskId, projectId), parent = digest(input.parentBinding);
  const result = record(input.result);
  const failed = Object.hasOwn(result, 'phase') || Object.hasOwn(result, 'code');
  if (failed) {
    exact(result, ['phase', 'code', 'receipts']);
    if (typeof result.phase !== 'string' || result.phase.length > 128 || typeof result.code !== 'string' || result.code.length > 128) qualificationError();
  } else {
    record(result, ['taskId', 'status', 'source', 'readiness', 'checks', 'executionLease', 'native', 'owner', 'runtime', 'checkpoint', 'observedTokenUsage', 'nativeDiagnostic', 'unavailable', 'qualification', 'capture', 'checkpointUncertain', 'finalResult']);
    if (result.status !== undefined) choice(result.status, ['completed', 'failed', 'running', 'blocked']);
  }
  if (!failed && result.taskId !== undefined && result.taskId !== taskId) qualificationError();
  if (result.source !== undefined) sameSource(result.source, source);
  if (!failed && result.taskId === undefined && result.checkpoint === undefined) qualificationError();
  const bundle = failed ? record(result.receipts, ['checkpoint', 'executionLease', 'owner', 'runtime', 'nativeDiagnostic', 'checkpointUncertain', 'checks', 'verificationChecks', 'failureContext', 'capture']) : result;
  const native = !failed && result.native !== undefined ? record(result.native, ['checkpoint', 'observedTokenUsage', 'nativeDiagnostic', 'unavailable', 'qualification', 'finalResult', 'checkpointUncertain']) : bundle;
  const nativeUncertain=native.checkpointUncertain===undefined?false:boolean(native.checkpointUncertain);
  const bundleUncertain=bundle.checkpointUncertain===undefined?false:boolean(bundle.checkpointUncertain);
  const checkpointUncertain=nativeUncertain||bundleUncertain;
  finalResultMetadata(native.finalResult);
  const readiness = result.readiness === undefined ? null : record(result.readiness, ['ready', 'qualification', 'acceptedBudget', 'evidence', 'reasons', 'observed', 'unavailable']);
  if (readiness) {
    if (readiness.ready !== undefined) boolean(readiness.ready);
    if (readiness.acceptedBudget !== undefined) boolean(readiness.acceptedBudget);
    if (readiness.qualification !== undefined) choice(readiness.qualification, ['offline-fixture', 'native-seatbelt']);
  }
  const qualification = native.qualification ?? readiness?.qualification;
  const fixture = boolean(input.fixture) || native.qualification === 'offline-fixture' || readiness?.qualification === 'offline-fixture' || result.qualification === 'offline-fixture';
  const classification = fixture ? 'fixture' as const : 'imported' as const;
  if (qualification !== undefined) choice(qualification, ['offline-fixture', 'native-seatbelt']);
  const captured = diagnostic(native.nativeDiagnostic);
  if (!failed && result.status === 'completed' && captured !== null) qualificationError();
  const c = checkpoint(native.checkpoint ?? bundle.checkpoint, task, parent, source);
  const owner = bundle.owner === undefined || bundle.owner === null ? null : record(bundle.owner, ['source', 'phases', 'receipts', 'transitionEvidence']);
  const rows = owner ? receipts(owner.receipts) : [];
  const sourceBound = nativeSourceChain(owner, task, source, rows);
  const checks = projectChecks(result.checks ?? [], source, taskId, classification, rows);
  const declared = list(task.checks).map(c => identifier(record(c).id));
  if (checks.some(c => !declared.includes(c.id))) qualificationError();
  const allDeclaredChecks = declared.every(id => checks.filter(c => c.id === id && c.passed && c.exitCode === 0 && c.receiptBound).length === 1);
  const evidence = readiness?.evidence === undefined || readiness.evidence === null ? null : record(readiness.evidence, ['runtimeBinding', 'executableDigest', 'profileDigest']);
  const pin = (key: string): ImportedPin | UnavailableEvidence => evidence === null || evidence[key] === undefined ? unavailable() : { classification, digest: digest(evidence[key]) };
  const runtimeBinding = pin('runtimeBinding'), executable = pin('executableDigest'), profile = pin('profileDigest');
  const lease = bundle.executionLease === undefined || bundle.executionLease === null ? null : exact(bundle.executionLease, ['id', 'deadline', 'runtime', 'status']);
  if (lease) {
    identifier(lease.id); integer(lease.deadline, 1); if (lease.runtime !== null) digest(lease.runtime);
    choice(lease.status, ['active', 'completed', 'failed', 'indeterminate']);
  }
  const runtime = bundle.runtime === undefined || bundle.runtime === null ? null : exact(bundle.runtime, ['fencingEpoch', 'leaseId', 'runtimes', 'receipts']);
  let settled = false;
  if (runtime) {
    integer(runtime.fencingEpoch, 1); identifier(runtime.leaseId);
    const runtimeRows = list(runtime.runtimes, 128).map(r => {
      const row = exact(r, ['id', 'binding', 'status']); identifier(row.id); digest(row.binding);
      choice(row.status, ['running', 'completed', 'failed', 'indeterminate']); return row;
    });
    if (new Set(runtimeRows.map(r => r.id)).size !== runtimeRows.length) qualificationError();
    const terminals = receipts(runtime.receipts);
    settled = runtimeBinding.classification !== 'unavailable' && lease?.status === 'completed' && lease.runtime === runtimeBinding.digest &&
      runtimeRows.length === 1 && runtimeRows.every(r => r.status === 'completed' && r.binding === runtimeBinding.digest) &&
      runtimeSettled(terminals, runtimeRows[0]!.id, runtime.leaseId, runtimeBinding.digest, taskId);
  }
  const cleanup = !checkpointUncertain && settled && c !== null && c.pending === null && ['stopped', 'completed', 'ready'].includes(c.status as string) ? 'reported-settled' as const : 'unavailable' as const;
  const completed = !failed && result.status === 'completed' && result.taskId === taskId && result.source === source && sourceBound && allDeclaredChecks && qualification !== undefined &&
    cleanup === 'reported-settled' && c !== null && c.pending === null && readiness?.ready === true && readiness.acceptedBudget === true &&
    runtimeBinding.classification !== 'unavailable' && executable.classification !== 'unavailable' && profile.classification !== 'unavailable';
  const failure: NativeProjection['failure'] = failed ? {
    phase: (failurePhases as readonly unknown[]).includes(result.phase) ? result.phase as string : 'native-turn',
    code: (failureCodes as readonly unknown[]).includes(result.code) ? result.code as string : 'native-execution-failed', diagnostic: captured,
  } : null;
  const projection: NativeProjection = { classification, reportedQualification: fixture ? 'offline-fixture' : qualification === 'native-seatbelt' ? 'native-seatbelt' : 'unavailable',
    checkpointStatus: c ? c.status as string : 'unavailable', pending: c ? c.pending !== null : false,
    retries: c ? integer(record(c.counters).retries, 0, 2) : 0, runtimeBinding, executable, profile,
    config: unavailable(), catalog: unavailable(), platform: unavailable(), model: unavailable(), effort: unavailable(),
    cleanup, cleanupProof: unavailable(), completed, failure, observedTokens: tokens(native.observedTokenUsage) };
  return { fixture, checks, baselineChecks: [], artifacts: [], native: projection, reviewedVerdict: null,
    execution: { classification, status: failed || result.status === 'failed' ? 'failed' : result.status === 'completed' ? 'completed' : result.status === 'blocked' ? 'blocked' : 'running', sourceBound, cleanup } };
}
