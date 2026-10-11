import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataSnapshot, object, positive } from '../context-engine/validation.js';
import { sha256, text } from './validation.js';
import type { ActionAuthority, LiveTask } from './contracts.js';

export const BROWSER_QA_MAX_BYTES = 65536;
export const BROWSER_QA_MAX_AGE_MS = 15 * 60 * 1000;
export type BrowserQaPhase = 'baseline' | 'candidate';
export interface BrowserQaRequest {
  phase: BrowserQaPhase;
  workspace: string;
  task: Readonly<LiveTask>;
  scenarioId: string;
  baselineSource: string;
  currentSource: string;
  requestId: string;
  requestedAt: number;
  signal: AbortSignal;
}
export interface BrowserQaReport {
  version: 1;
  phase: BrowserQaPhase;
  workspace: string;
  taskId: string;
  scenarioId: string;
  baselineSource: string;
  currentSource: string;
  requestId: string;
  startedAt: number;
  completedAt: number;
  checks: readonly { id: string; viewportWidth: number; passed: boolean; detail: string }[];
}
/** Trusted host callback. Its result is untrusted JSON until host validation. */
export type BrowserQaAdapter = (request: Readonly<BrowserQaRequest>) => Promise<unknown>;
export interface BrowserQaSetup {
  scenarioId: string;
  adapter: BrowserQaAdapter;
  /** Host-selected command identity, sealed into the durable command receipt. */
  command?: Readonly<{ configPath: string; configSha256: string; executable: string;
    executableSha256: string; args: readonly string[]; timeoutMs: number; maxOutputBytes: number }>;
}
export interface BrowserQaEvidence {
  report: Readonly<BrowserQaReport>;
  artifactPath: string;
  reportSha256: string;
}
function hash(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Browser QA source hash required');
}
export function validateBrowserQaReport(raw: unknown, request: Readonly<BrowserQaRequest>, now = Date.now()): Readonly<BrowserQaReport> {
  const value = dataSnapshot(raw);
  if (Buffer.byteLength(JSON.stringify(value)) > BROWSER_QA_MAX_BYTES) throw new Error('Browser QA report limit');
  object(value, ['version', 'phase', 'workspace', 'taskId', 'scenarioId', 'baselineSource', 'currentSource',
    'requestId', 'startedAt', 'completedAt', 'checks']);
  hash(value.baselineSource); hash(value.currentSource);
  if (value.version !== 1 || value.phase !== request.phase || value.workspace !== request.workspace ||
      value.taskId !== request.task.taskId || value.scenarioId !== request.scenarioId ||
      value.baselineSource !== request.baselineSource || value.currentSource !== request.currentSource ||
      value.requestId !== request.requestId) throw new Error('Browser QA report binding mismatch');
  positive(value.startedAt); positive(value.completedAt);
  if ((value.startedAt as number) < request.requestedAt || (value.completedAt as number) < (value.startedAt as number) ||
      (value.completedAt as number) > now || now - request.requestedAt > BROWSER_QA_MAX_AGE_MS)
    throw new Error('Browser QA report stale or invalid time');
  if (!Array.isArray(value.checks) || !value.checks.length || value.checks.length > 128)
    throw new Error('Browser QA nonempty bounded checks required');
  const keys = new Set<string>();
  for (const check of value.checks) {
    object(check, ['id', 'viewportWidth', 'passed', 'detail']);
    text(check.id, 128); text(check.detail, 2048); positive(check.viewportWidth, 16384);
    const key = JSON.stringify([check.id, check.viewportWidth]);
    if (keys.has(key) || typeof check.passed !== 'boolean') throw new Error('Browser QA invalid or duplicate check');
    keys.add(key);
    if (request.phase === 'candidate' && check.passed !== true) throw new Error('Browser QA candidate checks failed');
  }
  return value as unknown as Readonly<BrowserQaReport>;
}
async function invoke(adapter: BrowserQaAdapter, request: Readonly<BrowserQaRequest>): Promise<unknown> {
  request.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Browser QA handoff cancelled'));
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    Promise.resolve().then(() => { request.signal.throwIfAborted(); return adapter(request); })
      .then(resolve, reject).finally(() => request.signal.removeEventListener('abort', abort));
  });
}

/** Automatically collect both phases and re-read their receipts' artifacts at every gate. */
export class BrowserQaHandoff {
  readonly #reports = new Map<BrowserQaPhase, { evidence: BrowserQaEvidence; request: Readonly<BrowserQaRequest> }>();
  readonly #scenarioId: string;
  readonly #adapter: BrowserQaAdapter;
  readonly #command: BrowserQaSetup['command'];
  constructor(private readonly options: {
    setup: BrowserQaSetup; workspace: string; task: LiveTask; baselineSource: string;
    artifacts: string; authority: ActionAuthority; source: () => string; signal: AbortSignal;
  }) {
    text(options.setup.scenarioId, 128);
    if (typeof options.setup.adapter !== 'function') throw new Error('Browser QA configured adapter required');
    this.#scenarioId = options.setup.scenarioId; this.#adapter = options.setup.adapter;
    this.#command = options.setup.command ? dataSnapshot(options.setup.command) : undefined;
  }
  async capture(phase: BrowserQaPhase): Promise<BrowserQaEvidence> {
    if (this.#reports.has(phase)) throw new Error('Browser QA phase already captured');
    const currentSource = this.options.source();
    if (phase === 'baseline' && currentSource !== this.options.baselineSource) throw new Error('Browser QA baseline source mismatch');
    const request = Object.freeze({ phase, workspace: this.options.workspace, task: dataSnapshot(this.options.task),
      scenarioId: this.#scenarioId, baselineSource: this.options.baselineSource, currentSource,
      requestId: randomUUID(), requestedAt: Date.now(), signal: this.options.signal });
    const { signal: _signal, ...binding } = request;
    const receipt = this.options.authority.reserve({ kind: 'command', source: currentSource,
      detail: { action: 'browser-qa-handoff', ...binding, ...(this.#command ? { command: this.#command } : {}) } });
    try {
      receipt.check();
      const raw = await invoke(this.#adapter, request);
      request.signal.throwIfAborted();
      if (this.options.source() !== currentSource) throw new Error('Browser QA source changed during handoff');
      receipt.check();
      const report = validateBrowserQaReport(raw, request);
      const content = JSON.stringify(report) + '\n';
      if (Buffer.byteLength(content) > BROWSER_QA_MAX_BYTES) throw new Error('Browser QA report artifact limit');
      const artifactPath = join(this.options.artifacts, phase + '-browser-qa.json'), reportSha256 = sha256(content);
      const artifact = this.options.authority.reserve({ kind: 'artifact', source: currentSource,
        detail: { action: 'browser-qa-report', phase, artifactPath, reportSha256, requestId: request.requestId } });
      try {
        artifact.check();
        writeFileSync(artifactPath, content, { flag: 'wx', mode: 0o600 });
        if (this.options.source() !== currentSource) throw new Error('Browser QA source changed during artifact write');
        artifact.check();
        artifact.finish('completed', reportSha256);
      } catch (error) { artifact.finish('failed'); throw error; }
      const evidence = Object.freeze({ report, artifactPath, reportSha256 });
      this.#reports.set(phase, { evidence, request });
      receipt.finish('completed', reportSha256);
      return evidence;
    } catch (error) { receipt.finish('failed'); throw error; }
  }
  assertCurrent(): { baseline: BrowserQaEvidence; candidate: BrowserQaEvidence } {
    this.options.signal.throwIfAborted();
    const source = this.options.source();
    for (const phase of ['baseline', 'candidate'] as const) {
      const stored = this.#reports.get(phase);
      if (!stored) throw new Error('Browser QA missing required report');
      const { evidence, request } = stored;
      if (phase === 'candidate' && request.currentSource !== source) throw new Error('Browser QA stale candidate source');
      if (realpathSync(evidence.artifactPath) !== evidence.artifactPath) throw new Error('Browser QA unsafe artifact path');
      const fd = openSync(evidence.artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > BROWSER_QA_MAX_BYTES || stat.uid !== process.getuid?.() || stat.mode & 0o077)
          throw new Error('Browser QA unsafe artifact');
        const content = readFileSync(fd);
        if (content.length > BROWSER_QA_MAX_BYTES || sha256(content) !== evidence.reportSha256) throw new Error('Browser QA report hash changed');
        validateBrowserQaReport(JSON.parse(content.toString('utf8')), request);
      } finally { closeSync(fd); }
    }
    const baseline = this.#reports.get('baseline')!.evidence, candidate = this.#reports.get('candidate')!.evidence;
    const checks = (report: Readonly<BrowserQaReport>) => report.checks.map(c => JSON.stringify([c.id, c.viewportWidth])).sort();
    if (JSON.stringify(checks(baseline.report)) !== JSON.stringify(checks(candidate.report))) throw new Error('Browser QA scenario check coverage changed');
    return { baseline, candidate };
  }
}
