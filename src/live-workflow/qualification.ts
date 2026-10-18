import { qualificationSchema } from './qualification-contracts.js';
import type { QualificationOptions, QualificationReport, QualificationVerification, QualificationFinding, ReviewProjection, UnavailableEvidence, ArtifactProjection } from './qualification-contracts.js';
import { qualifyNative } from './qualification-native.js';
import { qualifySupervised } from './qualification-supervised.js';
import { assertJson, canonical, qualificationHash, textHash, parseQualificationJson, record, exact, identifier, digest, integer, boolean, choice, list, checkIds, sameSource, lifetime, validateBuild, validateReview, independentActors, unavailable, freezeQualification, qualificationError, diagnostic, failureCodes, failurePhases, tokenKeys } from './qualification-validation.js';

const limitations: QualificationReport['limitations'] = Object.freeze({ hardBillingCap: 'unavailable', accountEntitlement: 'unavailable', billingSettings: 'unavailable',
  hardProviderRequestCount: 'unavailable', fullNativePromptBytes: 'unavailable', rawProviderResponseBytes: 'unavailable',
  tokenUsage: 'reported-observation-only', productionApproval: 'unavailable', deployment: 'unqualified' });
type ReportBody = Omit<QualificationReport, 'digest'>;
type DerivationInput = Pick<QualificationReport, 'mode' | 'fixture' | 'source' | 'createdAt' | 'requiredChecks' | 'checks' | 'review' | 'native' | 'execution'>;
function derive(body: DerivationInput, now: number): Pick<ReportBody, 'executionConsistent' | 'outcome' | 'findings'> {
  const classification = body.fixture ? 'fixture' as const : 'imported' as const;
  const passed = body.checks.length > 0 && body.checks.every(c => c.source === body.source && c.passed && c.exitCode === 0 && c.receiptBound) &&
    body.requiredChecks.every(id => body.checks.filter(c => c.id === id).length === 1);
  const failed = body.checks.some(c => !c.passed);
  const executionConsistent = body.execution.status === 'completed' && body.execution.sourceBound && body.execution.cleanup === 'reported-settled' && passed &&
    (body.mode === 'supervised' || (body.native.classification !== 'unavailable' && body.native.completed));
  const review = body.review;
  const reviewed = review.classification !== 'unavailable' && review.verdict === 'pass' && review.independent &&
    review.createdAt <= body.createdAt && review.createdAt <= now && review.expiresAt > now && review.expiresAt > body.createdAt;
  const findings: QualificationFinding[] = [
    { category: 'fixture-conformance', classification: body.fixture ? 'fixture' : 'unavailable', status: body.fixture && executionConsistent ? 'consistent' : 'unqualified', code: body.fixture ? 'offline-fixture-history' : 'fixture-evidence-unavailable' },
    { category: 'protocol', classification, status: executionConsistent ? 'consistent' : failed || body.execution.status === 'failed' ? 'failed' : 'incomplete', code: executionConsistent ? 'execution-bindings-consistent' : 'execution-evidence-incomplete' },
    { category: 'sandbox', classification: body.mode === 'native' && body.native.classification !== 'unavailable' && body.native.runtimeBinding.classification !== 'unavailable' ? classification : 'unavailable', status: body.mode === 'native' && executionConsistent ? 'consistent' : 'incomplete', code: body.mode === 'native' ? 'imported-runtime-history-only' : 'sandbox-evidence-unavailable' },
    { category: 'account', classification: 'unavailable', status: 'unqualified', code: 'no-current-account-authority' },
    { category: 'inference', classification, status: executionConsistent ? 'consistent' : 'incomplete', code: body.fixture ? 'fixture-only-no-live-inference' : 'imported-execution-only' },
    { category: 'review', classification: review.classification, status: reviewed ? 'consistent' : review.classification !== 'unavailable' && review.verdict !== 'pass' ? 'failed' : 'incomplete', code: reviewed ? 'independent-review-consistent' : 'independent-review-incomplete' },
    { category: 'deployment', classification: 'unavailable', status: 'unqualified', code: 'deployment-unqualified' },
  ];
  return { executionConsistent, outcome: executionConsistent && reviewed ? 'completed-scoped' : 'partial', findings };
}
/** Pure offline import. Build/source pins are reported bindings, not filesystem attestation. */
export function createQualificationReport(options: QualificationOptions): Readonly<QualificationReport> {
  assertJson(options);
  record(options, ['mode', 'input', 'build', 'review', 'expectedSource', 'createdAt', 'expiresAt', 'now', 'rawInput']);
  if (options.mode !== 'native' && options.mode !== 'supervised') qualificationError();
  const source = digest(options.expectedSource);
  lifetime(options.createdAt, options.expiresAt, options.now);
  const input = record(options.input);
  if (input.schema !== 'qualification-input-v1') qualificationError();
  const taskId = identifier(input.taskId), projectId = identifier(input.projectId);
  sameSource(input.source, source); boolean(input.fixture);
  const requiredChecks = checkIds(input.requiredChecks);
  const build = validateBuild(options.build, source);
  const evidence = options.mode === 'native' ? qualifyNative(options.input) : qualifySupervised(options.input);
  let inputDigest = qualificationHash(input);
  if (options.rawInput !== undefined) {
    const parsed = parseQualificationJson(options.rawInput);
    if (canonical(parsed) !== canonical(input)) qualificationError();
    inputDigest = textHash(options.rawInput);
  }
  const classification = evidence.fixture ? 'fixture' as const : 'imported' as const;
  let review: ReviewProjection | UnavailableEvidence = unavailable();
  const artifacts: ArtifactProjection[] = [...evidence.artifacts];
  if (options.review !== undefined) {
    const validated = validateReview(options.review, taskId, source), r = validated.review;
    const existing = artifacts.find(a => a.name === 'review.json');
    if (existing && (existing.digest !== r.artifact.sha256 || existing.source !== source || evidence.reviewedVerdict !== validated.verdict)) qualificationError();
    // Supervised reviews must also be present in the corresponding reviewed phase bundle.
    if (options.mode === 'native' || existing) {
      review = { classification, reviewer: r.reviewer, implementer: r.implementer, verdict: validated.verdict, source,
        digest: r.artifact.sha256, createdAt: r.createdAt, expiresAt: r.expiresAt, independent: independentActors(r.reviewer, r.implementer) };
      if (!existing) artifacts.push({ name: 'review.json', source, digest: r.artifact.sha256, classification });
    }
  }
  const base = { schema: qualificationSchema, scope: 'historical-evidence-consistency' as const, authority: 'none' as const,
    mode: options.mode, taskId, projectId, source, createdAt: options.createdAt, expiresAt: options.expiresAt,
    input: { digest: inputDigest, encoding: options.rawInput === undefined ? 'canonical-json' as const : 'utf8-json' as const, classification: 'imported' as const },
    build: { ...build, digest: qualificationHash(build), classification: 'reported' as const }, fixture: evidence.fixture, requiredChecks,
    checks: evidence.checks, baselineChecks: evidence.baselineChecks, artifacts: artifacts.sort((a, b) => a.name.localeCompare(b.name, 'en')),
    execution: evidence.execution, review, native: evidence.native, limitations };
  const body: ReportBody = { ...base, ...derive(base, options.now) };
  const report: QualificationReport = { ...body, digest: qualificationHash(body) };
  // The creator uses exactly the same structural/semantic boundary as an importer.
  verifyQualificationReport(report, source, options.now);
  return freezeQualification(report);
}
function unavailableValue(raw: unknown): void {
  const r = exact(raw, ['classification', 'value']);
  if (r.classification !== 'unavailable' || r.value !== 'unavailable') qualificationError();
}
function pin(raw: unknown, classification: string): void {
  const r = record(raw);
  if (r.classification === 'unavailable') return unavailableValue(r);
  exact(r, ['classification', 'digest']);
  if (r.classification !== classification) qualificationError(); digest(r.digest);
}
function validateNativeProjection(raw: unknown, classification: string, execution: Record<string, unknown>): void {
  const n = exact(raw, ['classification', 'reportedQualification', 'checkpointStatus', 'pending', 'retries', 'runtimeBinding', 'executable', 'profile', 'config', 'catalog', 'platform', 'model', 'effort', 'cleanup', 'cleanupProof', 'completed', 'failure', 'observedTokens']);
  if (n.classification !== classification) qualificationError();
  choice(n.reportedQualification, ['native-seatbelt', 'offline-fixture', 'unavailable']);
  const checkpointStatus = choice(n.checkpointStatus, ['ready', 'running', 'completed', 'stopped', 'indeterminate', 'unavailable']);
  if ((classification === 'fixture') !== (n.reportedQualification === 'offline-fixture')) qualificationError();
  boolean(n.pending); boolean(n.completed); integer(n.retries, 0, 2);
  for (const key of ['runtimeBinding', 'executable', 'profile']) pin(n[key], classification);
  for (const key of ['config', 'catalog', 'platform', 'model', 'effort', 'cleanupProof']) unavailableValue(n[key]);
  choice(n.cleanup, ['reported-settled', 'unavailable']);
  if (n.cleanup !== execution.cleanup) qualificationError();
  if (n.cleanup === 'reported-settled' && (n.pending || !['stopped', 'completed', 'ready'].includes(checkpointStatus) || record(n.runtimeBinding).classification === 'unavailable')) qualificationError();
  if (n.failure !== null) {
    const failure = exact(n.failure, ['phase', 'code', 'diagnostic']);
    choice(failure.phase, failurePhases); choice(failure.code, failureCodes); diagnostic(failure.diagnostic);
    if (execution.status !== 'failed' || n.completed) qualificationError();
  }
  if (n.completed && (execution.status !== 'completed' || !execution.sourceBound || n.pending || n.cleanup !== 'reported-settled' || n.failure !== null || n.reportedQualification === 'unavailable' ||
      ['runtimeBinding', 'executable', 'profile'].some(key => record(n[key]).classification === 'unavailable'))) qualificationError();
  const observed = record(n.observedTokens);
  for (const [key, value] of Object.entries(observed)) {
    if (!(tokenKeys as readonly string[]).includes(key) && !['total', 'last'].some(scope => (tokenKeys as readonly string[]).some(k => key === scope + '.' + k))) qualificationError();
    integer(value);
  }
}
/** A valid rehash remains imported history with authority:none. */
export function verifyQualificationReport(raw: unknown, expectedSource: string, now: number): QualificationVerification {
  const value = typeof raw === 'string' ? parseQualificationJson(raw) : raw;
  assertJson(value);
  const r = exact(value, ['schema', 'scope', 'authority', 'mode', 'taskId', 'projectId', 'source', 'createdAt', 'expiresAt', 'input', 'build', 'fixture', 'requiredChecks', 'checks', 'baselineChecks', 'artifacts', 'execution', 'review', 'native', 'executionConsistent', 'outcome', 'findings', 'limitations', 'digest']);
  if (r.schema !== qualificationSchema || r.scope !== 'historical-evidence-consistency' || r.authority !== 'none') qualificationError();
  choice(r.mode, ['native', 'supervised']);
  const source = sameSource(r.source, digest(expectedSource));
  identifier(r.taskId); identifier(r.projectId); lifetime(r.createdAt, r.expiresAt, now);
  const { digest: reportDigest, ...body } = r;
  if (digest(reportDigest) !== qualificationHash(body)) qualificationError();
  const input = exact(r.input, ['digest', 'encoding', 'classification']);
  digest(input.digest); choice(input.encoding, ['utf8-json', 'canonical-json']);
  if (input.classification !== 'imported') qualificationError();
  const b = exact(r.build, ['schema', 'source', 'artifacts', 'digest', 'classification']);
  const normalizedBuild = validateBuild({ schema: b.schema, source: b.source, artifacts: b.artifacts }, source);
  if (b.classification !== 'reported' || digest(b.digest) !== qualificationHash(normalizedBuild) || canonical(b.artifacts) !== canonical(normalizedBuild.artifacts)) qualificationError();
  const classification = boolean(r.fixture) ? 'fixture' : 'imported';
  checkIds(r.requiredChecks);
  for (const key of ['checks', 'baselineChecks']) {
    const seen = new Set<string>();
    for (const item of list(r[key], 128)) {
      const c = exact(item, ['id', 'source', 'classification', 'passed', 'exitCode', 'digest', 'receiptBound']);
      const id = identifier(c.id); if (seen.has(id)) qualificationError(); seen.add(id);
      digest(c.source); digest(c.digest); boolean(c.receiptBound);
      if (c.exitCode !== null) integer(c.exitCode, -2147483648, 2147483647);
      if (c.classification !== classification || boolean(c.passed) !== (c.exitCode === 0)) qualificationError();
      if (key === 'checks') sameSource(c.source, source);
    }
  }
  const artifactNames = new Set<string>();
  const artifacts = list(r.artifacts, 3).map(item => {
    const a = exact(item, ['classification', 'digest', 'name', 'source']);
    const name = choice(a.name, ['before-checks.json', 'after-checks.json', 'review.json']);
    if (a.classification !== classification || artifactNames.has(name)) qualificationError();
    artifactNames.add(name); digest(a.digest); digest(a.source);
    if (name !== 'before-checks.json') sameSource(a.source, source);
    return a;
  });
  const execution = exact(r.execution, ['classification', 'status', 'sourceBound', 'cleanup']);
  if (execution.classification !== classification) qualificationError();
  choice(execution.status, ['completed', 'failed', 'blocked', 'running']); choice(execution.cleanup, ['reported-settled', 'unavailable']);
  boolean(execution.sourceBound);
  if (r.mode === 'native') {
    validateNativeProjection(r.native, classification, execution);
    if (list(r.baselineChecks).length || [...artifactNames].some(name => name !== 'review.json')) qualificationError();
  } else {
    unavailableValue(r.native);
    if (execution.cleanup === 'reported-settled' && execution.status !== 'completed') qualificationError();
    if (list(r.checks).length && !artifactNames.has('after-checks.json')) qualificationError();
    const before = artifacts.find(a => a.name === 'before-checks.json');
    for (const c of list(r.baselineChecks)) if (!before || record(c).source !== before.source) qualificationError();
  }
  const review = record(r.review);
  if (review.classification === 'unavailable') unavailableValue(review);
  else {
    exact(review, ['classification', 'reviewer', 'implementer', 'verdict', 'source', 'digest', 'createdAt', 'expiresAt', 'independent']);
    if (review.classification !== classification) qualificationError(); choice(review.verdict, ['pass', 'revise', 'blocked']);
    const reviewer = identifier(review.reviewer), implementer = review.implementer === null ? null : identifier(review.implementer);
    sameSource(review.source, source); digest(review.digest);
    if (integer(review.expiresAt, 1) <= integer(review.createdAt, 1) || boolean(review.independent) !== independentActors(reviewer, implementer)) qualificationError();
    const reviewPin = artifacts.find(a => a.name === 'review.json');
    if (!reviewPin || reviewPin.digest !== review.digest || reviewPin.source !== review.source) qualificationError();
  }
  if (canonical(r.limitations) !== canonical(limitations)) qualificationError();
  const derived = derive(r as unknown as QualificationReport, now);
  if (r.executionConsistent !== derived.executionConsistent || r.outcome !== derived.outcome || canonical(r.findings) !== canonical(derived.findings)) qualificationError();
  return freezeQualification({ integrity: 'consistent', classification: 'imported', authority: 'none', source, digest: reportDigest as string, outcome: derived.outcome });
}
export const validateQualificationReport = verifyQualificationReport;
export { qualificationHash, parseQualificationJson } from './qualification-validation.js';
