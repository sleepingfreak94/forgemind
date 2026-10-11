import { dataSnapshot, object, string, serialize } from '../context-engine/validation.js';
import { relativePath } from '../project-workflow/validation.js';
import { hash } from './validation.js';
import type { TerminalRunInput } from './run-contracts.js';

function oneOf(value: unknown, choices: readonly string[]): asserts value is string {
  if (typeof value !== 'string' || !choices.includes(value)) throw new Error('invalid run enum');
}
function slug(value: unknown): asserts value is string {
  string(value, 128); if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) throw new Error('invalid run identifier');
}
function integer(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('invalid run integer');
}
function list(value: unknown, max: number): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('invalid run list');
}
/** Immutable copy; validates evidence structure without authenticating artifacts or providers. */
export function terminalRun(raw: unknown): TerminalRunInput {
  const value = dataSnapshot(raw);
  object(value, ['schemaVersion', 'runId', 'taskId', 'execution', 'startedAt', 'endedAt', 'outcome', 'lastPhase',
    'baselineSource', 'candidateSource', 'changedPaths', 'checks', 'review', 'terminalReceiptSha256']);
  if (value.schemaVersion !== 1 || Buffer.byteLength(serialize(value)) > 32768) throw new Error('invalid run envelope');
  hash(value.runId); slug(value.taskId); hash(value.baselineSource); hash(value.terminalReceiptSha256);
  oneOf(value.execution, ['fixture', 'authenticated']);
  oneOf(value.outcome, ['completed', 'failed', 'blocked', 'indeterminate']);
  oneOf(value.lastPhase, ['setup', 'planning', 'approval', 'baseline', 'coding', 'candidate', 'review', 'delivery', 'publication', 'terminal']);
  integer(value.startedAt); integer(value.endedAt);
  if (value.startedAt < 0 || value.endedAt < value.startedAt) throw new Error('invalid run timestamps');
  if (value.candidateSource !== undefined) hash(value.candidateSource);
  list(value.changedPaths, 100); value.changedPaths.forEach(relativePath);
  if (new Set(value.changedPaths).size !== value.changedPaths.length) throw new Error('duplicate run path');
  list(value.checks, 24);
  const ids = new Set<string>(); let candidateCount = 0; let candidatesPassed = true;
  for (const check of value.checks) {
    object(check, ['phase', 'id', 'outcome', 'exitCode', 'source', 'evidenceSha256']);
    oneOf(check.phase, ['baseline', 'candidate']); slug(check.id);
    oneOf(check.outcome, ['passed', 'failed', 'indeterminate']); hash(check.source); hash(check.evidenceSha256);
    if (check.exitCode !== null) integer(check.exitCode);
    if (check.outcome === 'passed' && check.exitCode !== 0 || check.outcome === 'failed' && (check.exitCode === null || check.exitCode === 0) ||
        check.outcome === 'indeterminate' && check.exitCode !== null) throw new Error('contradictory run check');
    if (check.source !== (check.phase === 'baseline' ? value.baselineSource : value.candidateSource)) throw new Error('run check source mismatch');
    const id = `${check.phase}:${check.id}`;
    if (ids.has(id)) throw new Error('duplicate run check'); ids.add(id);
    if (check.phase === 'candidate') { candidateCount++; candidatesPassed = candidatesPassed && check.outcome === 'passed'; }
  }
  let passReview = false;
  if (value.review !== undefined) {
    const review = value.review; object(review, ['outcome', 'source', 'evidenceSha256']);
    oneOf(review.outcome, ['pass', 'revise', 'blocked']); hash(review.source); hash(review.evidenceSha256);
    if (review.source !== value.candidateSource) throw new Error('run review source mismatch');
    passReview = review.outcome === 'pass';
  }
  if (value.outcome === 'completed' && (!value.candidateSource || !candidateCount || !candidatesPassed || !passReview)) throw new Error('incomplete completed run');
  return value as unknown as TerminalRunInput;
}
