import type { ArtifactProjection, QualificationEvidence } from './qualification-contracts.js';
import { assertJson, exact, record, identifier, digest, integer, list, boolean, sameSource, receipts, phases, artifact, projectChecks, reviewResult, unavailable, qualificationError } from './qualification-validation.js';

/** Imports RunAuthority.export(), never creates or consults a live authority. */
export function qualifySupervised(raw: unknown): QualificationEvidence {
  assertJson(raw);
  const input = exact(raw, ['schema', 'taskId', 'projectId', 'source', 'fixture', 'requiredChecks', 'receipt', 'artifacts']);
  const taskId = identifier(input.taskId), source = digest(input.source), fixture = boolean(input.fixture);
  const classification = fixture ? 'fixture' as const : 'imported' as const;
  const exported = exact(input.receipt, ['taskId', 'run', 'phases', 'receipts']);
  const run = exact(exported.run, ['id', 'status', 'requests', 'input_bytes']);
  if (exported.taskId !== taskId || run.id !== taskId || !['completed', 'failed', 'blocked', 'running'].includes(String(run.status))) qualificationError();
  integer(run.requests); integer(run.input_bytes);
  const history = phases(exported.phases), rows = receipts(exported.receipts);
  if (new Set(history.map(p => p.name)).size !== history.length) qualificationError();
  const worktree = history.find(p => p.name === 'worktree'), candidate = history.find(p => p.name === 'candidate'), reviewed = history.find(p => p.name === 'reviewed');
  if ((candidate && (!worktree || candidate.seq <= worktree.seq)) || (reviewed && (!candidate || reviewed.seq <= candidate.seq))) qualificationError();
  if (candidate) sameSource(candidate.source, source);
  else if (worktree) sameSource(worktree.source, source);
  const started = rows.filter(r => r.event === 'session.started');
  const sourceBound = candidate !== undefined || worktree !== undefined || started.some(r => r.sourceSnapshot === source && (r.taskId === undefined || r.taskId === taskId));
  if (reviewed) sameSource(reviewed.source, source);
  const imported = list(input.artifacts, 3).map(artifact);
  if (new Set(imported.map(a => a.descriptor.name)).size !== imported.length) qualificationError();
  const pins: ArtifactProjection[] = [];
  let checks: QualificationEvidence['checks'] = [], baselineChecks: QualificationEvidence['baselineChecks'] = [];
  let reviewedVerdict: QualificationEvidence['reviewedVerdict'] = null;
  for (const a of imported) {
    const d = a.descriptor;
    if (d.name === 'before-checks.json') {
      if (!worktree) qualificationError();
      sameSource(d.source, worktree.source);
      baselineChecks = projectChecks(a.value, worktree.source, taskId, classification, rows);
    } else if (d.name === 'after-checks.json') {
      if (!candidate) qualificationError();
      sameSource(d.source, candidate.source);
      checks = projectChecks(a.value, source, taskId, classification, rows);
    } else {
      if (!reviewed) qualificationError();
      sameSource(d.source, reviewed.source);
      reviewedVerdict = reviewResult(a.value, source);
      if (reviewed.data.verdict !== reviewedVerdict) qualificationError();
    }
    pins.push({ name: d.name, source: d.source, digest: d.sha256, classification });
  }
  return { fixture, checks, baselineChecks, artifacts: pins.sort((a, b) => a.name.localeCompare(b.name, 'en')), native: unavailable(), reviewedVerdict,
    execution: { classification, status: run.status as 'completed' | 'failed' | 'blocked' | 'running', sourceBound,
      cleanup: run.status === 'completed' && candidate !== undefined ? 'reported-settled' : 'unavailable' } };
}
