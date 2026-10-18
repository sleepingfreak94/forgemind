import { dataSnapshot, digest, freeze, object, positive, serialize } from '../context-engine/validation.js';
import { hash, text } from './validation.js';

export interface SessionEvidenceRef { id: string; sha256: string }
export interface SessionFields {
  sessionId: string;
  taskId: string;
  sourceSnapshot: string;
  evidenceRefs: SessionEvidenceRef[];
  completedStepIds: string[];
  nextStepIds: string[];
  hypothesesSummary: string;
}
export interface SessionRecord extends SessionFields {
  schemaVersion: 1;
  projectId: string;
  workspaceRoot: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  digest: string;
}
export interface SessionExpectation { expectedDigest: string; expectedRevision: number }
export interface SessionPacket {
  schemaVersion: 1;
  trust: 'evidence-only';
  record: SessionRecord;
  digest: string;
}
export const sessionLimits = Object.freeze({
  ttlSeconds: 7 * 24 * 60 * 60, records: 256, ids: 10000, list: 50, packetBytes: 16000
});
const fieldKeys = ['sessionId', 'taskId', 'sourceSnapshot', 'evidenceRefs', 'completedStepIds', 'nextStepIds', 'hypothesesSummary'];
export function sessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error('invalid session/step identifier');
}
function checkFields(value: SessionFields): void {
  sessionId(value.sessionId); sessionId(value.taskId); hash(value.sourceSnapshot);
  text(value.hypothesesSummary, 2048);
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 32) throw new Error('invalid session evidence');
  for (const ref of value.evidenceRefs) { object(ref, ['id', 'sha256']); hash(ref.id); hash(ref.sha256); }
  if (new Set(value.evidenceRefs.map(ref => ref.id)).size !== value.evidenceRefs.length) throw new Error('duplicate evidence reference');
  for (const key of ['completedStepIds', 'nextStepIds'] as const) {
    const list = value[key];
    if (!Array.isArray(list) || list.length > 64) throw new Error('invalid session steps');
    list.forEach(sessionId);
    if (new Set(list).size !== list.length) throw new Error('duplicate session step');
  }
  if (value.nextStepIds.some(id => value.completedStepIds.includes(id))) throw new Error('completed step cannot be next');
}
export function sessionFields(raw: SessionFields): Readonly<SessionFields> {
  const value = dataSnapshot(raw); object(value, fieldKeys); checkFields(value); return value;
}
export function sessionExpectation(raw: SessionExpectation): Readonly<SessionExpectation> {
  const value = dataSnapshot(raw); object(value, ['expectedDigest', 'expectedRevision']);
  hash(value.expectedDigest); positive(value.expectedRevision, Number.MAX_SAFE_INTEGER - 1); return value;
}
export function sessionTime(value: unknown): asserts value is number { positive(value); }
export function sessionRecord(raw: SessionRecord): Readonly<SessionRecord> {
  const value = dataSnapshot(raw);
  object(value, [...fieldKeys, 'schemaVersion', 'projectId', 'workspaceRoot', 'revision', 'createdAt', 'updatedAt', 'expiresAt', 'digest']);
  checkFields(value); text(value.projectId, 1024); text(value.workspaceRoot, 4096);
  positive(value.revision, Number.MAX_SAFE_INTEGER - 1);
  for (const key of ['createdAt', 'updatedAt', 'expiresAt'] as const) sessionTime(value[key]);
  if (value.schemaVersion !== 1 || value.updatedAt < value.createdAt || value.expiresAt <= value.updatedAt ||
      value.expiresAt - value.createdAt > sessionLimits.ttlSeconds * 1000) throw new Error('invalid session lifetime');
  hash(value.digest);
  const { digest: stored, ...body } = value;
  if (stored !== digest(serialize(body))) throw new Error('session digest mismatch');
  return value;
}
export function sessionPacket(record: Readonly<SessionRecord>): Readonly<SessionPacket> {
  const checked = sessionRecord(record);
  const body = { schemaVersion: 1 as const, trust: 'evidence-only' as const, record: checked };
  const packet = { ...body, digest: digest(serialize(body)) };
  if (Buffer.byteLength(serialize(packet)) > sessionLimits.packetBytes) throw new Error('session packet budget exceeded');
  return freeze(packet);
}
