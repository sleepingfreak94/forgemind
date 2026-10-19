import { serialize } from '../context-engine/validation.js';
import { sha256 } from './validation.js';
import type { ActionEnvelope } from './contracts.js';
import { assertJson, exact, list, digest, identifier, integer, qualificationError } from './qualification-validation.js';

export interface NativeTransitionBinding {
  transitionReceiptId: string;
  taskBinding: string;
  envelope: ActionEnvelope;
  decisionId: string;
  terminalId: string;
  decisionDigest: string;
  terminalDigest: string;
  digest: string;
}
export const transitionSchema = 'native-transition-bindings-v1';
export function transitionTaskBinding(task: object): string { return sha256(serialize({ ...task, source: null })); }
function uuid(raw: unknown): string {
  const id = identifier(raw);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) qualificationError();
  return id;
}
/** Validate the exact producer view; no plaintext trust marker confers authority. */
export function transitionEnvelope(raw: unknown, before: string, after: string | null, paths: readonly string[]): string {
  assertJson(raw);
  const envelope = exact(raw, ['kind', 'source', 'detail']);
  const detail = exact(envelope.detail, ['operation', 'transitionReceiptId', 'before', 'source', 'edits']);
  if (envelope.kind !== 'artifact' || digest(envelope.source) !== before || detail.operation !== 'native.source-transition' ||
      digest(detail.before) !== before || digest(detail.source) === before || (after !== null && detail.source !== after)) qualificationError();
  const id = uuid(detail.transitionReceiptId), seen = new Set<string>(), edits = list(detail.edits, 512);
  if (!edits.length) qualificationError();
  for (const rawEdit of edits) {
    const edit = exact(rawEdit, ['path', 'before', 'after']);
    if (typeof edit.path !== 'string' || edit.path.length > 4096 || !paths.includes(edit.path) || seen.has(edit.path) ||
        /[\x00-\x1f\x7f\\]/.test(edit.path) || edit.path.split('/').some(p => !p || p === '.' || p === '..')) qualificationError();
    seen.add(edit.path);
    if (edit.before !== null) digest(edit.before);
    if (edit.after !== null) digest(edit.after);
    if (edit.before === null && edit.after === null) qualificationError();
  }
  return id;
}
export function transitionBinding(body: Omit<NativeTransitionBinding, 'digest'>): NativeTransitionBinding {
  return { ...body, digest: sha256(serialize(body)) };
}

/** Returns receipt positions so the caller can enforce one-to-one chain order. */
export function validateTransitionBinding(raw: unknown, rows: readonly Record<string, unknown>[],
  expected: { id: string; before: string; after: string; task: string; taskBinding: string; paths: readonly string[] }): [number, number] {
  assertJson(raw);
  const b = exact(raw, ['transitionReceiptId', 'taskBinding', 'envelope', 'decisionId', 'terminalId', 'decisionDigest', 'terminalDigest', 'digest']);
  const { digest: hash, ...body } = b;
  if (digest(hash) !== sha256(serialize(body)) || digest(b.taskBinding) !== expected.taskBinding ||
      uuid(b.transitionReceiptId) !== expected.id || transitionEnvelope(b.envelope, expected.before, expected.after, expected.paths) !== expected.id) qualificationError();
  const decisionId = uuid(b.decisionId), terminalId = uuid(b.terminalId);
  const di = rows.findIndex(r => r.id === decisionId), ti = rows.findIndex(r => r.id === terminalId);
  if (di < 0 || ti <= di) qualificationError();
  const d = rows[di]!, t = rows[ti]!;
  if (digest(b.decisionDigest) !== sha256(serialize(d)) || digest(b.terminalDigest) !== sha256(serialize(t))) qualificationError();
  const shared = ['principalId', 'sessionId', 'policyVersion', 'grantId', 'invocationId', 'requestId', 'requestDigest', 'taskId', 'sourceSnapshot', 'action', 'resource'];
  if (shared.some(key => typeof d[key] !== 'string' || !d[key] || d[key] !== t[key])) qualificationError();
  for (const key of ['principalId', 'sessionId', 'grantId', 'invocationId', 'requestId']) uuid(d[key]);
  const viewDigest = sha256(serialize(b.envelope));
  if (d.event !== 'external.decided' || d.outcome !== 'allow' || t.event !== 'external.finished' || t.outcome !== 'completed' ||
      d.taskId !== expected.task || d.sourceSnapshot !== expected.before || d.action !== 'command.run' || d.resource !== 'host:' + viewDigest ||
      integer(t.timestamp) < integer(d.timestamp)) qualificationError();
  const terminal = exact(t.terminalEvidence, ['viewDigest', 'outputDigest']);
  if (digest(terminal.viewDigest) !== viewDigest || digest(terminal.outputDigest) !== expected.after) qualificationError();
  // PolicyRuntime hashes this insertion-ordered context and normalized request.
  const context = { grantId: d.grantId, invocationId: d.invocationId };
  const intent = { requestId: d.requestId, action: d.action, resource: d.resource, sourceSnapshot: d.sourceSnapshot };
  const requestDigest = sha256(JSON.stringify({ context, intent, sessionId: d.sessionId, policyVersion: d.policyVersion }));
  if (digest(d.requestDigest) !== requestDigest) qualificationError();
  // A recovered, duplicate or contradictory receipt cannot be hidden by selected IDs.
  const related = rows.filter(r => String(r.event).startsWith('external.') && (r.requestId === d.requestId || r.invocationId === d.invocationId));
  if (related.length !== 2 || !related.includes(d) || !related.includes(t)) qualificationError();
  return [di, ti];
}

export function validateTransitionHistory(raw: unknown, phases: readonly Record<string, unknown>[],
  rows: readonly Record<string, unknown>[], task: object & { task: string; writePaths: readonly string[] }): void {
  const evidence = exact(raw, ['schema', 'bindings']);
  if (evidence.schema !== transitionSchema) qualificationError();
  const bindings = list(evidence.bindings, 4096), used = new Set<string>();
  if (bindings.length !== phases.length) qualificationError();
  let previous = -1;
  bindings.forEach((binding, index) => {
    const phase = phases[index]!, id = identifier(phase.id);
    if (used.has(id)) qualificationError(); used.add(id);
    const [decision, terminal] = validateTransitionBinding(binding, rows, { id, before: digest(phase.before_source), after: digest(phase.after_source),
      task: task.task, taskBinding: transitionTaskBinding(task), paths: task.writePaths });
    if (decision <= previous) qualificationError();
    previous = terminal;
  });
}
