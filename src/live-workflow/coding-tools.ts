import { lstatSync, readFileSync } from 'node:fs';
import { applyEdits } from './edits.js';
import { runChecks } from './checks.js';
import { sourceIdentity, trackedPaths } from './repository.js';
import { codingSchema } from './contracts.js';
import { safePath, sha256, sourcePath } from './validation.js';
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
const hostListTool = Object.freeze({ name: 'host_list',
  description: 'List tracked, readable repository files whose path starts with prefix (all files if omitted). Returns {paths, truncated}; at most 2000 paths, sorted.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { prefix: { type: 'string' } } } });
const hostSearchTool = Object.freeze({ name: 'host_search',
  description: 'Literal (not regex) case-sensitive substring search, 2-200 characters, over tracked readable text files, optionally only under a path prefix. Returns {matches:[{path,line,text}], truncated}; at most 200 matches, lines trimmed to 200 characters; large (>512 KiB) and binary files are skipped.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' }, path: { type: 'string' } } } });
/** The tools for one task: read-only list and search are added only with repository read scope. */
export function codingToolsFor(task: LiveTask): readonly { name: string; description: string; inputSchema: object }[] {
  return task.readScope === 'repository' ? Object.freeze([...codingTools, hostListTool, hostSearchTool]) : codingTools;
}
/** Whether a tracked path may be read through repository scope. The name rules apply to every
 * path segment (stricter: `secrets/x.ts` is also denied). Case-insensitive. */
export function repositoryReadable(path: string): boolean {
  return !path.split('/').some(part => {
    const p = part.toLowerCase();
    return p === '.git' || /^\.env(\..*)?$/.test(p) || /\.(pem|key|p12|pfx|keystore)$/.test(p) ||
      /^(id_rsa|id_ecdsa|id_ed25519)/.test(p) || p === '.npmrc' || p === '.netrc' || /^(credentials|secrets)/.test(p);
  });
}
const MAX_LIST = 2000, MAX_MATCHES = 200, MAX_FILE = 512 * 1024, MAX_SCANNED = 32 * 1024 * 1024;
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
  /** Tracked readable paths, computed once at construction (later applied files are readable via writePaths only). */
  readonly #readable: ReadonlySet<string> | undefined;
  #current: string;
  #calls = 0;
  #resultBytes = 0;
  #fatal: Error | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #edits: ProposedEdit[] = [];
  readonly #summaries: string[] = [];
  readonly #consulted: string[] = [];
  constructor(readonly options: {
    root: string; task: LiveTask; source: string; checkDirectory: string;
    /** Receipts for every effect; `phase` records each apply, and each check against the tree it ran on. */
    authority: ActionAuthority & { phase(name: string, source: string, data: unknown): void };
    checkRuntime?: CheckRuntime; signal: AbortSignal; boundary: () => void;
  }) {
    if (options.task.codingMode !== 'tools' || !options.task.maxToolCalls) throw new Error('Tools coding mode is not granted');
    this.#session = this.#current = options.source;
    if (options.task.readScope === 'repository') {
      // Also require sourcePath validity so every listed path can pass safePath (excludes dist/, build/, ...).
      const valid = (p: string) => { try { sourcePath(p); return true; } catch { return false; } };
      this.#readable = new Set(trackedPaths(options.root).filter(p => repositoryReadable(p) && valid(p)));
    }
  }
  get source(): string { return this.#current; }
  get calls(): number { return this.#calls; }
  get fatal(): Error | undefined { return this.#fatal; }
  /** Paths host_read returned successfully, in first-read order without duplicates. */
  get consulted(): readonly string[] { return [...this.#consulted]; }
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
      if (Object.keys(a).join() !== 'path' || typeof a.path !== 'string' || !([...task.readPaths, ...task.writePaths].includes(a.path) || this.#readable?.has(a.path)))
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
      if (!this.#consulted.includes(a.path)) this.#consulted.push(a.path);
      return JSON.stringify({ path: a.path, sha256: digest, content: content ? content.toString('utf8') : null });
    }
    if (name === 'host_list' && this.#readable) {
      if (!Object.keys(a).every(k => k === 'prefix') || (a.prefix !== undefined && (typeof a.prefix !== 'string' || Buffer.byteLength(a.prefix) > 1024)))
        throw new Error('Invalid list arguments');
      const prefix = (a.prefix as string | undefined) ?? '';
      const all = [...this.#readable].filter(p => p.startsWith(prefix)).sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
      const receipt = authority.reserve({ kind: 'artifact', source: this.#session, detail: { operation: 'coding.list', tree: this.#current } });
      receipt.check();
      const out = JSON.stringify({ paths: all.slice(0, MAX_LIST), truncated: all.length > MAX_LIST });
      receipt.finish('completed', sha256(out));
      return out;
    }
    if (name === 'host_search' && this.#readable) {
      if (!Object.keys(a).every(k => k === 'text' || k === 'path') || typeof a.text !== 'string' || a.text.length < 2 || a.text.length > 200 ||
          (a.path !== undefined && (typeof a.path !== 'string' || Buffer.byteLength(a.path) > 1024)))
        throw new Error('Invalid search arguments');
      const needle = a.text, prefix = (a.path as string | undefined) ?? '';
      const paths = [...this.#readable].filter(p => p.startsWith(prefix)).sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
      const matches: { path: string; line: number; text: string }[] = [];
      let truncated = false, scanned = 0;
      scan: for (const p of paths) {
        let buffer: Buffer;
        try {
          const file = safePath(root, p);
          const stat = lstatSync(file);
          if (!stat.isFile() || stat.size > MAX_FILE) continue;
          if (scanned + stat.size > MAX_SCANNED) { truncated = true; break; }
          scanned += stat.size;
          buffer = readFileSync(file);
        } catch { continue; }
        if (buffer.includes(0)) continue;
        const lines = buffer.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]!.includes(needle)) continue;
          if (matches.length >= MAX_MATCHES) { truncated = true; break scan; }
          matches.push({ path: p, line: i + 1, text: lines[i]!.slice(0, 200) });
        }
      }
      const receipt = authority.reserve({ kind: 'artifact', source: this.#session, detail: { operation: 'coding.search', tree: this.#current } });
      receipt.check();
      const out = JSON.stringify({ matches, truncated });
      receipt.finish('completed', sha256(out));
      return out;
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

function toolsInstructions(tools: readonly { name: string }[]): string {
  if (!tools.some(t => t.name === 'host_list' || t.name === 'host_search')) return TOOLS_INSTRUCTIONS;
  return TOOLS_INSTRUCTIONS + '\nhost_list lists tracked readable repository files by path prefix and host_search finds a literal string in them; use them to explore before editing. host_read accepts any listed path. Writes remain limited to the granted write paths.';
}

/** Run one tools-mode coding session and return its applied changes and resulting source. */
export async function runToolCoding(model: ModelPort, options: ConstructorParameters<typeof CodingToolHost>[0] & { input: unknown }):
  Promise<{ changes: CodingResult; source: string; consulted: readonly string[] }> {
  if (!model.codeWithTools) throw new Error('Tools coding mode requires a route that can drive host tools');
  const host = new CodingToolHost(options);
  const tools = codingToolsFor(options.task);
  const { summary } = await model.codeWithTools({ instructions: toolsInstructions(tools), input: options.input, tools,
    call: (name, args) => host.call(name, args), maxToolCalls: options.task.maxToolCalls!,
    assertCurrent: () => { if (host.fatal) throw host.fatal; if (sourceIdentity(options.root) !== host.source) throw new Error('Source changed outside host tools'); } },
    options.signal);
  if (host.fatal) throw host.fatal;
  const changes = host.result(summary);
  if (!changes.edits.length) throw new Error('Tools coding session applied no edits');
  return { changes, source: host.source, consulted: host.consulted };
}
