import { lstatSync, readFileSync } from 'node:fs';
import { applyEdits } from './edits.js';
import { runChecks } from './checks.js';
import { sourceIdentity } from './repository.js';
import { codingSchema } from './contracts.js';
import { safePath, sha256 } from './validation.js';
import type { CheckRuntime } from './check-runtime.js';
import type { ActionAuthority, CodingResult, LiveTask, ModelPort, ProposedEdit } from './contracts.js';

/** The three host functions a tools-mode coding session may call (ADR-0014 Phase 2). */
export const codingTools = Object.freeze([
  { name: 'host_read', description: 'Read one granted project file. Returns {path, sha256, content}; sha256 and content are null for an absent file.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } } },
  { name: 'host_apply', description: 'Apply validated edits to granted write paths. Same edit formats as the single-call coding answer; beforeSha256 must match the current file.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['summary', 'edits'], properties: codingSchema.properties } },
  { name: 'host_check', description: 'Run one predefined check by id, after the checks listed before it in the task. Returns each check result.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } } },
]);
export type CodingToolName = typeof codingTools[number]['name'];
export interface CodingToolResult { text: string; isError: boolean }
const MAX_CHECK_TEXT = 16384;
const tail = (text: string) => text.length > MAX_CHECK_TEXT ? '…' + text.slice(-MAX_CHECK_TEXT) : text;

/** Host side of one tools-mode coding session. Every call is bound to the exact task grants and
 * receipts; a failure that changed source or lost authority ends the session instead of being retried.
 * The authority, and with it the session's provider receipt, stays bound to the starting source for
 * the whole session: each receipt is reserved against it, and each apply records the tracked tree
 * source, which the host verifies before every call. The orchestrator advances the authority after. */
export class CodingToolHost {
  readonly #session: string;
  #current: string;
  #calls = 0;
  #resultBytes = 0;
  #fatal: Error | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #edits: ProposedEdit[] = [];
  readonly #summaries: string[] = [];
  constructor(readonly options: {
    root: string; task: LiveTask; source: string; checkDirectory: string;
    /** Receipts for every effect; `phase` records each apply, and each check against the tree it ran on. */
    authority: ActionAuthority & { phase(name: string, source: string, data: unknown): void };
    checkRuntime?: CheckRuntime; signal: AbortSignal; boundary: () => void;
  }) {
    if (options.task.codingMode !== 'tools' || !options.task.maxToolCalls) throw new Error('Tools coding mode is not granted');
    this.#session = this.#current = options.source;
  }
  get source(): string { return this.#current; }
  get calls(): number { return this.#calls; }
  get fatal(): Error | undefined { return this.#fatal; }
  /** Applied edits in call order, for the run record; the reviewed result is the Git diff. */
  result(summary: string): CodingResult { return { summary: [summary, ...this.#summaries].join('\n').slice(0, 4000), edits: [...this.#edits] }; }

  /** Calls run one at a time, in arrival order. */
  call(name: string, args: unknown): Promise<CodingToolResult> {
    const next = this.#queue.then(() => this.#call(name, args));
    this.#queue = next.catch(() => undefined);
    return next;
  }
  async #call(name: string, args: unknown): Promise<CodingToolResult> {
    if (this.#fatal) throw this.#fatal;
    const { task, root, signal } = this.options;
    try { signal.throwIfAborted(); this.options.boundary(); this.#assertCurrent(); }
    catch (error) { throw this.#stop(error); }
    if (++this.#calls > task.maxToolCalls!) throw this.#stop(new Error('Tool-call budget exhausted'));
    try {
      const text = await this.#dispatch(name, args);
      this.#charge(text);
      return { text, isError: false };
    } catch (error) {
      // A rejected call that left source and authority intact goes back to the model to correct.
      if (this.#fatal) throw this.#fatal;
      let intact = false;
      try { signal.throwIfAborted(); this.options.boundary(); intact = sourceIdentity(root) === this.#current; } catch {}
      if (!intact) throw this.#stop(error);
      const text = JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 500) : 'rejected' });
      this.#charge(text);
      return { text, isError: true };
    }
  }
  async #dispatch(name: string, args: unknown): Promise<string> {
    const { task, root, authority } = this.options;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Malformed tool arguments');
    const a = args as Record<string, unknown>;
    if (name === 'host_read') {
      if (Object.keys(a).join() !== 'path' || typeof a.path !== 'string' || ![...task.readPaths, ...task.writePaths].includes(a.path))
        throw new Error('Read outside the exact grant');
      const path = safePath(root, a.path, true);
      let content: Buffer | null = null;
      try { if (lstatSync(path).isFile()) content = readFileSync(path); else throw new Error('Not a regular file'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (content && content.length > task.maxPromptBytes) throw new Error('Read result limit');
      const receipt = authority.reserve({ kind: 'artifact', source: this.#session, detail: { operation: 'coding.read', path: a.path, tree: this.#current } });
      receipt.check();
      const digest = content ? sha256(content) : null;
      receipt.finish('completed', digest ?? sha256('absent'));
      return JSON.stringify({ path: a.path, sha256: digest, content: content ? content.toString('utf8') : null });
    }
    if (name === 'host_apply') {
      const before = this.#current;
      const applied = applyEdits(root, this.#session, task.writePaths, a, authority, () => { this.options.boundary(); this.#assertCurrent(); });
      // The edit is on disk now: failing to record or keep it must end the session.
      try {
        this.#current = sourceIdentity(root);
        authority.phase('tool-apply', this.#session, { call: this.#calls, before, after: this.#current,
          summary: applied.summary.slice(0, 500), paths: applied.edits.map(e => e.path) });
        this.#edits.push(...applied.edits); this.#summaries.push(applied.summary);
      } catch (error) { throw this.#stop(error); }
      return JSON.stringify({ applied: applied.edits.map(e => e.path), source: this.#current });
    }
    if (name === 'host_check') {
      const index = task.checks.findIndex(c => c.id === a.id);
      if (Object.keys(a).join() !== 'id' || index < 0) throw new Error('Check outside the exact grant');
      const results = await runChecks(root, this.#session, task.checks.slice(0, index + 1), this.options.checkDirectory, authority,
        this.options.signal, this.options.checkRuntime);
      this.#assertCurrent();
      try {
        authority.phase('tool-check', this.#session, { call: this.#calls, tree: this.#current,
          checks: task.checks.slice(0, index + 1).map(c => c.id),
          results: results.map(r => ({ id: r.id, passed: r.passed, exitCode: r.exitCode })) });
      } catch (error) { throw this.#stop(error); }
      return JSON.stringify(results.map(r => ({ id: r.id, passed: r.passed, exitCode: r.exitCode, stdout: tail(r.stdout), stderr: tail(r.stderr) })));
    }
    throw new Error('Unknown host tool');
  }
  #assertCurrent(): void {
    if (sourceIdentity(this.options.root) !== this.#current) throw new Error('Source changed outside host tools');
  }
  #charge(text: string): void {
    this.#resultBytes += Buffer.byteLength(text);
    if (this.#resultBytes > this.options.task.maxPromptBytes) throw this.#stop(new Error('Tool result byte budget exhausted'));
  }
  #stop(error: unknown): Error {
    this.#fatal ??= error instanceof Error ? error : new Error('Coding session stopped');
    return this.#fatal;
  }
}

const TOOLS_INSTRUCTIONS = [
  'Implement the approved plan with the ForgeMind host tools; the host enforces every grant.',
  'Call one tool at a time. Use host_read for the current content and whole-file sha256 of a granted file before editing it.',
  'host_apply takes {summary, edits}; edits use the same formats as a single-call answer: {path,beforeSha256,format:"text-replacements-v1",replacements:[{before,after}]} or {path,beforeSha256,content} (null digest for a new file, null content deletes it). beforeSha256 is the current whole-file digest.',
  'host_check runs a predefined check by id after the checks listed before it. Run the relevant checks after editing and fix failures within the tool-call budget.',
  'Do not change unrelated paths or weaken tests. When done, answer with a short summary of the change.',
].join('\n');

/** Run one tools-mode coding session and return its applied changes and resulting source. */
export async function runToolCoding(model: ModelPort, options: ConstructorParameters<typeof CodingToolHost>[0] & { input: unknown }):
  Promise<{ changes: CodingResult; source: string }> {
  if (!model.codeWithTools) throw new Error('Tools coding mode requires a route that can drive host tools');
  const host = new CodingToolHost(options);
  const { summary } = await model.codeWithTools({ instructions: TOOLS_INSTRUCTIONS, input: options.input, tools: codingTools,
    call: (name, args) => host.call(name, args), maxToolCalls: options.task.maxToolCalls!,
    assertCurrent: () => { if (host.fatal) throw host.fatal; if (sourceIdentity(options.root) !== host.source) throw new Error('Source changed outside host tools'); } },
    options.signal);
  if (host.fatal) throw host.fatal;
  const changes = host.result(summary);
  if (!changes.edits.length) throw new Error('Tools coding session applied no edits');
  return { changes, source: host.source };
}
