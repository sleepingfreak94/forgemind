import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { freeze, object, serialize } from '../context-engine/validation.js';
import { OwnerRunRecorder, privateOwnerPath, readOwnerJSON } from '../memory/run-recording.js';
import type { OwnerArtifactManifest, OwnerReservation } from '../memory/run-recording.js';
import { RunAuthority, privateDirectory } from './authority.js';
import { sourceIdentity } from './repository.js';
import { sha256 } from './validation.js';

export interface HistoryReviewEvidence {
  readonly taskId: string; readonly source: string; readonly sha256: string; readonly path: string;
}
/** Trusted host configuration, never task/model JSON or proof of authentication. */
export interface AutomaticHistoryOptions {
  readonly stateDirectory: string;
  /** Attest reviewer independence for these exact source/artifact bytes. */
  readonly verifyIndependentReview?: (evidence: Readonly<HistoryReviewEvidence>) => boolean;
}
export interface HistoryContext {
  readonly workspace: string; readonly runDirectory: string; readonly taskId: string;
  readonly execution: 'fixture' | 'authenticated'; readonly maxRuntimeMs: number;
}
export type AutomaticHistoryResult = Readonly<{
  status: 'recorded' | 'incomplete'; runId: string; reservationId: string;
  evidencePath: string; code?: 'review-attestation-needed' | 'history-recording-incomplete';
}>;
function bytes(path: string): Buffer {
  privateOwnerPath(path, false);
  if (lstatSync(path).size > 1048576) throw new Error('History artifact too large');
  const value = readFileSync(path);
  if (value.length > 1048576) throw new Error('History artifact too large');
  readOwnerJSON(path, sha256(value));
  return value;
}
function immutableJson(path: string, value: unknown): void {
  const content = JSON.stringify(value, null, 2) + '\n';
  if (existsSync(path)) {
    if (bytes(path).toString('utf8') !== content) throw new Error('History artifact conflict');
  } else writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
}
/** Automatic import of actual supervised artifacts. Persistence never reruns execution. */
export class AutomaticRunHistory {
  readonly #options: AutomaticHistoryOptions;
  readonly #context: HistoryContext;
  readonly #recorder: OwnerRunRecorder;
  readonly #reservation: OwnerReservation;
  readonly #authority: RunAuthority;
  readonly #source: string;
  readonly #attempt: string;
  readonly #resume: boolean;
  #result: AutomaticHistoryResult | undefined;
  constructor(options: AutomaticHistoryOptions, context: HistoryContext, resume = false) {
    this.#options = options; this.#context = context; this.#resume = resume;
    const directory = privateDirectory(context.runDirectory);
    this.#source = sourceIdentity(context.workspace);
    this.#attempt = join(directory, 'history-authority', randomUUID());
    this.#authority = new RunAuthority(this.#attempt, context.workspace, 'forgemind', {
      schemaVersion: 1, taskId: 'history-' + sha256(directory).slice(0, 32),
      objective: 'Owner-configured automatic history artifact persistence only', readPaths: [], writePaths: [], checks: [],
      model: 'none', effort: 'low', maxModelRequests: 0, maxPromptBytes: 1, maxOutputBytes: 1048576,
      maxRuntimeMs: Math.min(context.maxRuntimeMs + 35000, 2147483647), draftPr: false,
    }, this.#source);
    let recorder: OwnerRunRecorder | undefined;
    try {
      const prepared = this.#artifact('prepare', () => {
        const marker = join(directory, 'history-reservation.json'), id = 'run-' + sha256(directory);
        if (resume !== existsSync(marker)) throw new Error('History invocation requires explicit recovery');
        recorder = new OwnerRunRecorder(options.stateDirectory, context.workspace);
        if (resume && recorder.store.get('reservation:' + id) === undefined) throw new Error('Original reservation missing');
        const reserved = recorder.prepare({ reservationId: id, taskId: context.taskId, execution: context.execution });
        if (resume) {
          if (serialize(readOwnerJSON(marker, sha256(bytes(marker)))) !== serialize(reserved)) throw new Error('History reservation changed');
        } else immutableJson(marker, reserved);
        return reserved;
      });
      this.#recorder = recorder!; this.#reservation = prepared;
    } catch (error) {
      const failures = this.#cleanup(recorder, 'failed');
      if (failures.length) this.#cleanupNote(failures);
      throw error;
    }
  }
  #artifact<T>(operation: string, fn: () => T): T {
    if (sourceIdentity(this.#context.workspace) !== this.#source) throw new Error('Original workspace source changed');
    const receipt = this.#authority.reserve({ kind: 'artifact', source: this.#source,
      detail: { operation: 'automatic-history.' + operation, taskId: this.#context.taskId,
        stateDirectory: this.#options.stateDirectory, runDirectory: this.#context.runDirectory } });
    let attempted = false;
    try { receipt.check(); const result = fn(); attempted = true; receipt.finish('completed'); return result; }
    catch (error) { if (!attempted) { attempted = true; try { receipt.finish('failed'); } catch { /* Reconcile retained reservation. */ } } throw error; }
  }
  #savePolicy(): boolean {
    try { writeFileSync(join(this.#attempt, 'receipt.json'), JSON.stringify(this.#authority.export(), null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return true; }
    catch { return false; }
  }
  #cleanup(recorder: OwnerRunRecorder | undefined, status: 'completed' | 'failed'): string[] {
    const failures: string[] = [];
    try { recorder?.close(); } catch { failures.push('recorder-close'); }
    try { this.#authority.finish(status); } catch { failures.push('authority-finish'); }
    if (!this.#savePolicy()) failures.push('policy-export');
    try { this.#authority.close(); } catch { failures.push('authority-close'); }
    return failures;
  }
  #cleanupNote(failures: string[]): void {
    let authority: RunAuthority | undefined;
    try {
      if (sourceIdentity(this.#context.workspace) !== this.#source) return;
      authority = new RunAuthority(join(this.#attempt, 'cleanup-authority'), this.#context.workspace, 'forgemind', {
        schemaVersion: 1, taskId: 'history-cleanup-' + sha256(this.#attempt).slice(0, 24),
        objective: 'Best-effort fixed history cleanup evidence only', readPaths: [], writePaths: [], checks: [],
        model: 'none', effort: 'low', maxModelRequests: 0, maxPromptBytes: 1, maxOutputBytes: 65536, maxRuntimeMs: 35000, draftPr: false,
      }, this.#source);
      const path = join(this.#attempt, 'history-cleanup.json');
      const receipt = authority.reserve({ kind: 'artifact', source: this.#source,
        detail: { operation: 'automatic-history.cleanup-note', path, taskId: this.#context.taskId } });
      let attempted = false, accepted = false;
      try {
        receipt.check(); immutableJson(path, { schema: 'history-cleanup-v1', taskId: this.#context.taskId,
          failures, disposition: this.#result ?? null, evidence: 'incomplete-no-execution-replay' });
        attempted = true; receipt.finish('completed'); accepted = true;
      } catch {
        if (!attempted) { attempted = true; try { receipt.finish('failed'); } catch { /* Ledger retains uncertainty. */ } }
      }
      try { authority.finish(accepted ? 'completed' : 'failed'); } catch { /* Preserve actual action and incomplete cleanup status. */ }
      try { writeFileSync(join(authority.directory, 'receipt.json'), JSON.stringify(authority.export(), null, 2) + '\n', { flag: 'wx', mode: 0o600 }); } catch { /* Durable ledger remains. */ }
    } catch { /* Evidence failure cannot replace the original task/preparation outcome. */ }
    finally { try { authority?.close(); } catch { /* No recursive cleanup. */ } }
  }
  finish(): AutomaticHistoryResult {
    if (this.#result) return this.#result;
    let code: AutomaticHistoryResult['code'] = 'history-recording-incomplete';
    const evidencePath = join(this.#attempt, 'history-status.json');
    let status: AutomaticHistoryResult['status'] = 'incomplete';
    try {
      const imported = this.#artifact('record', () => {
        const artifacts = join(this.#context.runDirectory, 'artifacts');
        privateOwnerPath(artifacts, true);
        const endedPath = join(this.#context.runDirectory, 'history-ended.json');
        if (!existsSync(endedPath)) {
          if (this.#resume) throw new Error('Original terminal timestamp unavailable');
          immutableJson(endedPath, { endedAt: Date.now() });
        }
        const ended = readOwnerJSON(endedPath, sha256(bytes(endedPath)));
        object(ended, ['endedAt']);
        const receiptPath = join(artifacts, 'receipt.json'), raw = bytes(receiptPath);
        const receipt = readOwnerJSON(receiptPath, sha256(raw));
        object(receipt, ['taskId', 'run', 'phases', 'receipts']);
        if (receipt.taskId !== this.#context.taskId || !Array.isArray(receipt.phases)) throw new Error('Wrong history task');
        const phase = (name: string) => {
          const values = (receipt.phases as unknown[]).filter(p => {
            object(p, ['seq', 'name', 'source', 'data']); return p.name === name;
          });
          if (values.length !== 1) throw new Error('Missing or ambiguous source phase');
          return values[0] as { seq: number; source: string };
        };
        const bindings: Record<string, unknown> = { 'receipt.json': { sha256: sha256(raw) } };
        for (const [file, name] of [['before-checks.json', 'worktree'], ['after-checks.json', 'candidate'], ['review.json', 'reviewed']] as const) {
          const path = join(artifacts, file);
          if (!existsSync(path)) { bindings[file] = null; continue; }
          const pin = sha256(bytes(path)), p = phase(name);
          if (file === 'review.json') {
            const evidence = freeze({ taskId: this.#context.taskId, source: p.source, sha256: pin, path });
            if (this.#options.verifyIndependentReview?.(evidence) !== true) {
              code = 'review-attestation-needed'; throw new Error('Review independence requires owner verification');
            }
          }
          bindings[file] = { sha256: pin, source: p.source, phaseSeq: p.seq, ...(file === 'review.json' ? { independent: true } : {}) };
        }
        const manifest: OwnerArtifactManifest = { schemaVersion: 1, projectId: this.#reservation.projectId,
          originalRoot: this.#reservation.originalRoot, runId: this.#reservation.runId, taskId: this.#context.taskId,
          endedAt: ended.endedAt as number, artifacts: bindings as unknown as OwnerArtifactManifest['artifacts'] };
        const manifestPath = join(artifacts, 'history-manifest.json');
        immutableJson(manifestPath, manifest);
        this.#recorder.record(this.#reservation.reservationId, manifestPath, sha256(bytes(manifestPath)));
        return true;
      });
      if (imported) { status = 'recorded'; code = undefined; }
    } catch { /* Preserve the original task outcome and an explicit incomplete history disposition. */ }
    this.#result = freeze({ status, runId: this.#reservation.runId, reservationId: this.#reservation.reservationId,
      evidencePath, ...(code ? { code } : {}) });
    try { this.#artifact('status', () => immutableJson(evidencePath, this.#result)); } catch { /* Returned status still reports incompleteness. */ }
    const failures = this.#cleanup(this.#recorder, status === 'recorded' ? 'completed' : 'failed');
    if (failures.length) {
      this.#result = freeze({ status: 'incomplete', runId: this.#reservation.runId, reservationId: this.#reservation.reservationId,
        evidencePath: join(this.#attempt, 'history-cleanup.json'), code: 'history-recording-incomplete' });
      this.#cleanupNote(failures);
    }
    return this.#result;
  }
}
/** Reuses the original pre-execution reservation, terminal timestamp and immutable manifest. */
export function recoverAutomaticRunHistory(options: AutomaticHistoryOptions, context: HistoryContext): AutomaticHistoryResult {
  return new AutomaticRunHistory(options, context, true).finish();
}
