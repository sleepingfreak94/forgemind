import { isAbsolute, normalize, parse, sep } from 'node:path';
import { bytes, dataSnapshot, digest, freeze, object, serialize, string } from '../context-engine/validation.js';
import { relativePath } from '../project-workflow/validation.js';
import { terminalRun } from './run-validation.js';
import type { RunRecord } from './run-contracts.js';

const outcomes = ['completed', 'failed', 'blocked', 'indeterminate'] as const;
const phases = ['setup', 'planning', 'approval', 'baseline', 'coding', 'candidate', 'review', 'delivery', 'publication', 'terminal'] as const;
const checkKeys = ['baselinePassed', 'baselineFailed', 'baselineIndeterminate', 'candidatePassed', 'candidateFailed', 'candidateIndeterminate'] as const;
const reviewKeys = ['pass', 'revise', 'blocked', 'absent'] as const;
const checkKey = {
  baseline: { passed: 'baselinePassed', failed: 'baselineFailed', indeterminate: 'baselineIndeterminate' },
  candidate: { passed: 'candidatePassed', failed: 'candidateFailed', indeterminate: 'candidateIndeterminate' }
} as const;
const MAX = Number.MAX_SAFE_INTEGER;
const HASH = '0'.repeat(64);
const SEED = digest(serialize({ domain: 'weekly-summary-dependencies-v1' }));
type Counts<K extends string> = Readonly<Record<K, number>>;
export interface WeeklyCounters {
  readonly runs: number;
  readonly outcomes: Counts<typeof outcomes[number]>;
  readonly phases: Counts<typeof phases[number]>;
  readonly checks: Counts<typeof checkKeys[number]>;
  readonly reviews: Counts<typeof reviewKeys[number]>;
}
export interface WeeklyScope {
  readonly projectId: string; readonly originalRoot: string; readonly dueAt: number;
  readonly lowerExclusive: number; readonly upperInclusive: number;
}
export interface WeeklyOptions { readonly executionSelection?: 'authenticated' | 'all'; readonly maxBytes?: number }
export interface WeeklyExample {
  readonly id: string; readonly runId: string; readonly runDigest: string; readonly sequence: number;
  readonly taskId: string; readonly execution: 'authenticated' | 'fixture';
  readonly baselineSource: string; readonly candidateSource?: string;
  readonly changedPaths: readonly string[]; readonly terminalReceiptSha256: string;
  readonly checks: readonly { readonly phase: 'baseline' | 'candidate'; readonly id: string; readonly source: string; readonly evidenceSha256: string }[];
  readonly review?: { readonly source: string; readonly evidenceSha256: string };
}
/** Serializable evidence only. JSON cannot authenticate origin, sequence metadata,
 * trusted-store cursors, or cross-page RunHistory primary-key uniqueness.
 */
export interface Accumulator extends WeeklyScope {
  readonly schemaVersion: 1; readonly cursor: number; readonly historical: true; readonly trust: 'evidence-only';
  readonly executionSelection: 'authenticated' | 'all'; readonly maxBytes: number;
  readonly authenticated: WeeklyCounters; readonly fixture: WeeklyCounters;
  readonly selectedRuns: number; readonly excludedFixtureCount: number;
  readonly dependencyCount: number; readonly dependencySha256: string;
  readonly examples: readonly WeeklyExample[]; readonly omittedExamples: number;
}
export interface Summary extends Accumulator { readonly id: string; readonly digest: string }
const scopeKeys = ['projectId', 'originalRoot', 'dueAt', 'lowerExclusive', 'upperInclusive'];
const bodyKeys = [...scopeKeys, 'schemaVersion', 'cursor', 'historical', 'trust', 'executionSelection', 'maxBytes',
  'authenticated', 'fixture', 'selectedRuns', 'excludedFixtureCount', 'dependencyCount', 'dependencySha256', 'examples', 'omittedExamples'];
const exampleKeys = ['id', 'runId', 'runDigest', 'sequence', 'taskId', 'execution', 'baselineSource', 'candidateSource',
  'changedPaths', 'terminalReceiptSha256', 'checks', 'review'];
function fail(): never { throw new Error('invalid weekly summary'); }
function shape(v: unknown, keys: readonly string[], optional: readonly string[] = []): asserts v is Record<string, unknown> {
  object(v, keys);
  if (keys.some(k => !optional.includes(k) && !Object.hasOwn(v, k))) fail();
}
function natural(v: unknown): asserts v is number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail();
}
function sha(v: unknown): asserts v is string { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail(); }
function wellFormed(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const code = v.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = v.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function text(v: unknown, limit: number): asserts v is string {
  string(v, limit);
  if (/[\u0000-\u001f\u007f]/.test(v) || !wellFormed(v)) fail();
}
function slug(v: unknown): asserts v is string { text(v, 128); if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v)) fail(); }
function path(v: unknown): asserts v is string { text(v, 512); relativePath(v); }
function list(v: unknown, limit: number): asserts v is unknown[] { if (!Array.isArray(v) || v.length > limit) fail(); }
function add(a: number, b: number): number { natural(a); natural(b); const n = a + b; natural(n); return n; }
function sum(v: Record<string, number>): number { return Object.values(v).reduce(add, 0); }
function blank<K extends string>(keys: readonly K[], n = 0): Record<K, number> {
  return Object.fromEntries(keys.map(k => [k, n])) as Record<K, number>;
}
function counters(n = 0): WeeklyCounters {
  return { runs: n, outcomes: blank(outcomes, n), phases: blank(phases, n), checks: blank(checkKeys, n), reviews: blank(reviewKeys, n) };
}
function scope(v: Record<string, unknown>): WeeklyScope {
  const { projectId, originalRoot, dueAt, lowerExclusive, upperInclusive } = v;
  slug(projectId); text(originalRoot, 1024);
  // Native path semantics only; no realpath, filesystem access, or scope rewriting.
  if (!isAbsolute(originalRoot) || normalize(originalRoot) !== originalRoot ||
      originalRoot !== parse(originalRoot).root && originalRoot.endsWith(sep) ||
      originalRoot.split(sep === '\\' ? /[\\/]/ : /\//).some(p => p === '.' || p === '..')) fail();
  if (sep === '\\') {
    if (originalRoot.includes('/') || !/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/.test(originalRoot) ||
        /[<>"|?*]/.test(originalRoot) || originalRoot.slice(2).includes(':')) fail();
  } else if (originalRoot.includes('\\')) fail();
  natural(dueAt); natural(lowerExclusive); natural(upperInclusive);
  if (lowerExclusive > upperInclusive) fail();
  return { projectId, originalRoot, dueAt, lowerExclusive, upperInclusive };
}
function validateCounters(raw: unknown): WeeklyCounters {
  shape(raw, ['runs', 'outcomes', 'phases', 'checks', 'reviews']); natural(raw.runs);
  for (const [name, keys] of [['outcomes', outcomes], ['phases', phases], ['checks', checkKeys], ['reviews', reviewKeys]] as const) {
    const values = raw[name]; shape(values, keys); Object.values(values).forEach(natural);
  }
  const v = raw as unknown as WeeklyCounters;
  if (sum(v.outcomes) !== v.runs || sum(v.phases) !== v.runs || sum(v.reviews) !== v.runs || Math.ceil(sum(v.checks) / 24) > v.runs) fail();
  return v;
}
function validateExample(raw: unknown, state: Accumulator): WeeklyExample {
  shape(raw, exampleKeys, ['candidateSource', 'review']);
  for (const k of ['id', 'runId', 'runDigest', 'baselineSource', 'terminalReceiptSha256']) sha(raw[k]);
  slug(raw.taskId); natural(raw.sequence);
  if (raw.sequence <= state.lowerExclusive || raw.sequence > state.cursor ||
      raw.execution !== 'authenticated' && raw.execution !== 'fixture' ||
      state.executionSelection === 'authenticated' && raw.execution !== 'authenticated') fail();
  if (raw.id !== digest(serialize({ projectId: state.projectId, workspaceRoot: state.originalRoot, runId: raw.runId }))) fail();
  if (Object.hasOwn(raw, 'candidateSource')) sha(raw.candidateSource);
  list(raw.changedPaths, 100); raw.changedPaths.forEach(path);
  if (new Set(raw.changedPaths).size !== raw.changedPaths.length) fail();
  list(raw.checks, 24); const ids = new Set<string>();
  for (const check of raw.checks) {
    shape(check, ['phase', 'id', 'source', 'evidenceSha256']); slug(check.id); sha(check.source); sha(check.evidenceSha256);
    if (check.phase !== 'baseline' && check.phase !== 'candidate' ||
        check.source !== (check.phase === 'baseline' ? raw.baselineSource : raw.candidateSource)) fail();
    const key = `${check.phase}:${check.id}`; if (ids.has(key)) fail(); ids.add(key);
  }
  if (Object.hasOwn(raw, 'review')) {
    shape(raw.review, ['source', 'evidenceSha256']); sha(raw.review.source); sha(raw.review.evidenceSha256);
    if (raw.review.source !== raw.candidateSource) fail();
  }
  if (bytes(serialize(raw)) > 4096) fail();
  return raw as unknown as WeeklyExample;
}
/** Reserve worst-case metadata widths and both final hashes. Admission never
 * depends on current count digits or where the caller partitions pages.
 */
function reservation(state: Accumulator): number {
  return bytes(serialize({ ...state, cursor: MAX, dueAt: MAX, lowerExclusive: MAX, upperInclusive: MAX,
    maxBytes: MAX, authenticated: counters(MAX), fixture: counters(MAX), selectedRuns: MAX,
    excludedFixtureCount: MAX, dependencyCount: MAX, dependencySha256: HASH, examples: [], omittedExamples: MAX,
    id: HASH, digest: HASH }));
}
function exampleBytes(examples: readonly WeeklyExample[]): number { return bytes(serialize(examples)) - 2; }
function validateState(raw: unknown, final = false): Accumulator {
  const v: unknown = dataSnapshot(raw);
  shape(v, final ? [...bodyKeys, 'id', 'digest'] : bodyKeys);
  const framing = scope(v);
  natural(v.cursor); natural(v.maxBytes);
  if (v.schemaVersion !== 1 || v.historical !== true || v.trust !== 'evidence-only' ||
      v.executionSelection !== 'authenticated' && v.executionSelection !== 'all' ||
      v.maxBytes > 65536 || v.cursor < framing.lowerExclusive || v.cursor > framing.upperInclusive) fail();
  const a = validateCounters(v.authenticated), f = validateCounters(v.fixture);
  for (const k of ['selectedRuns', 'excludedFixtureCount', 'dependencyCount', 'omittedExamples']) natural(v[k]);
  sha(v.dependencySha256);
  const state = v as unknown as Accumulator;
  if (state.dependencyCount !== add(a.runs, f.runs) ||
      state.selectedRuns !== (state.executionSelection === 'all' ? add(a.runs, f.runs) : a.runs) ||
      state.excludedFixtureCount !== (state.executionSelection === 'all' ? 0 : f.runs) ||
      state.dependencyCount > state.cursor - state.lowerExclusive ||
      state.dependencyCount === 0 && state.dependencySha256 !== SEED) fail();
  list(v.examples, 8);
  let previous = state.lowerExclusive; const ids = new Set<string>();
  let authenticatedExamples = 0, fixtureExamples = 0;
  for (const rawExample of v.examples) {
    const e = validateExample(rawExample, state);
    if (e.sequence <= previous || ids.has(e.id)) fail(); previous = e.sequence; ids.add(e.id);
    if (e.execution === 'authenticated') authenticatedExamples++; else fixtureExamples++;
  }
  if (authenticatedExamples > a.runs || fixtureExamples > f.runs ||
      add(state.examples.length, state.omittedExamples) !== state.selectedRuns ||
      reservation(state) + exampleBytes(state.examples) > state.maxBytes) fail();
  if (final) {
    if (state.cursor !== state.upperInclusive) fail();
    sha(v.id); sha(v.digest);
    const { id, digest: claimed, ...body } = v;
    if (id !== digest(serialize(body)) || claimed !== digest(serialize({ ...body, id })) || bytes(serialize(v)) > state.maxBytes) fail();
  }
  return state;
}
export function createWeeklyAccumulator(rawScope: WeeklyScope, rawOptions?: WeeklyOptions): Accumulator {
  const s: unknown = dataSnapshot(rawScope);
  const options: unknown = dataSnapshot(arguments.length < 2 ? {} : rawOptions);
  shape(s, scopeKeys); const framing = scope(s);
  shape(options, ['executionSelection', 'maxBytes'], ['executionSelection', 'maxBytes']);
  const executionSelection = Object.hasOwn(options, 'executionSelection') ? options.executionSelection : 'authenticated';
  const maxBytes = Object.hasOwn(options, 'maxBytes') ? options.maxBytes : 8192;
  if (executionSelection !== 'authenticated' && executionSelection !== 'all') fail();
  natural(maxBytes);
  const state: Accumulator = { ...framing, schemaVersion: 1, cursor: framing.lowerExclusive,
    historical: true, trust: 'evidence-only', executionSelection, maxBytes,
    authenticated: counters(), fixture: counters(), selectedRuns: 0, excludedFixtureCount: 0,
    dependencyCount: 0, dependencySha256: SEED, examples: [], omittedExamples: 0 };
  return freeze(validateState(state));
}
const recordKeys = ['schemaVersion', 'runId', 'taskId', 'execution', 'startedAt', 'endedAt', 'outcome', 'lastPhase',
  'baselineSource', 'candidateSource', 'changedPaths', 'checks', 'review', 'terminalReceiptSha256',
  'projectId', 'workspaceRoot', 'id', 'digest', 'sequence', 'recordedAt'];
function verifyRecord(raw: unknown, state: Accumulator): RunRecord {
  const v: unknown = dataSnapshot(raw); shape(v, recordKeys, ['candidateSource', 'review']);
  sha(v.id); sha(v.digest); natural(v.sequence); natural(v.recordedAt);
  if (v.projectId !== state.projectId || v.workspaceRoot !== state.originalRoot) fail();
  const { projectId, workspaceRoot, id, digest: claimed, sequence, recordedAt, ...input } = v;
  const facts = { ...terminalRun(input), projectId, workspaceRoot };
  if (serialize({ ...input, projectId, workspaceRoot }) !== serialize(facts) ||
      id !== digest(serialize({ projectId, workspaceRoot, runId: facts.runId })) || claimed !== digest(serialize(facts))) fail();
  facts.changedPaths.forEach(path);
  return v as unknown as RunRecord;
}
/** Validate only the bounded outer container; each record gets its own snapshot.
 * A valid batch may exceed the shared snapshot ceiling in aggregate.
 */
function batch(raw: unknown): readonly unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) fail();
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'length');
  if (!descriptor || descriptor.get || descriptor.set) fail();
  const length: unknown = descriptor.value;
  natural(length); if (length > 100) fail();
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== length + 1) fail();
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) fail();
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || d.get || d.set || !d.enumerable) fail();
  }
  // Capture at most 100 proven descriptor values without reading an accessor.
  const values: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const d = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!d || d.get || d.set || !d.enumerable) fail();
    const value: unknown = d.value;
    values.push(value);
  }
  return values;
}
function increment(current: WeeklyCounters, r: RunRecord): WeeklyCounters {
  const checks = { ...current.checks };
  for (const check of r.checks) {
    const key = checkKey[check.phase][check.outcome];
    checks[key] = add(checks[key], 1);
  }
  const review = r.review?.outcome ?? 'absent';
  return { runs: add(current.runs, 1), outcomes: { ...current.outcomes, [r.outcome]: add(current.outcomes[r.outcome], 1) },
    phases: { ...current.phases, [r.lastPhase]: add(current.phases[r.lastPhase], 1) }, checks,
    reviews: { ...current.reviews, [review]: add(current.reviews[review], 1) } };
}
function example(r: RunRecord): WeeklyExample {
  return { id: r.id, runId: r.runId, runDigest: r.digest, sequence: r.sequence, taskId: r.taskId, execution: r.execution,
    baselineSource: r.baselineSource, ...(r.candidateSource === undefined ? {} : { candidateSource: r.candidateSource }),
    changedPaths: r.changedPaths, terminalReceiptSha256: r.terminalReceiptSha256,
    checks: r.checks.map(c => ({ phase: c.phase, id: c.id, source: c.source, evidenceSha256: c.evidenceSha256 })),
    ...(r.review === undefined ? {} : { review: { source: r.review.source, evidenceSha256: r.review.evidenceSha256 } }) };
}
/** Cursor gaps come only from the trusted store. Empty advancing pages do not
 * attest that deleted records were inspected. No cross-page ID set is retained.
 */
export function appendWeeklyRecords(rawState: Accumulator, rawRecords: readonly RunRecord[], rawCursor: number): Accumulator {
  let state = validateState(rawState); natural(rawCursor);
  if (rawCursor <= state.cursor || rawCursor > state.upperInclusive) fail();
  const records = batch(rawRecords), ids = new Set<string>(); let previous = state.cursor;
  for (const raw of records) {
    const r = verifyRecord(raw, state);
    if (r.sequence <= previous || r.sequence > rawCursor || ids.has(r.id)) fail();
    previous = r.sequence; ids.add(r.id);
    const selected = r.execution === 'authenticated' || state.executionSelection === 'all';
    let examples = state.examples, omittedExamples = state.omittedExamples;
    if (selected) {
      const e = example(r), proposed = [...examples, e];
      if (examples.length < 8 && bytes(serialize(e)) <= 4096 && reservation(state) + exampleBytes(proposed) <= state.maxBytes) examples = proposed;
      else omittedExamples = add(omittedExamples, 1);
    }
    state = { ...state, [r.execution]: increment(state[r.execution], r),
      selectedRuns: add(state.selectedRuns, selected ? 1 : 0), excludedFixtureCount: add(state.excludedFixtureCount, selected ? 0 : 1),
      dependencyCount: add(state.dependencyCount, 1),
      dependencySha256: digest(serialize({ domain: 'weekly-summary-dependency-v1', previous: state.dependencySha256,
        id: r.id, digest: r.digest, sequence: r.sequence })), examples, omittedExamples };
  }
  return freeze(validateState({ ...state, cursor: rawCursor }));
}
export function finishWeeklySummary(rawState: Accumulator): Summary {
  const body = validateState(rawState);
  if (body.cursor !== body.upperInclusive) fail();
  const id = digest(serialize(body));
  return validateWeeklySummary({ ...body, id, digest: digest(serialize({ ...body, id })) });
}
/** Historical framing and integrity only; does not authenticate current dependencies. */
export function validateWeeklySummary(raw: unknown): Summary { return freeze(validateState(raw, true) as Summary); }
