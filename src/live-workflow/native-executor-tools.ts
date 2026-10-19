import { readFileSync, lstatSync } from 'node:fs';
import { safePath, sha256 } from './validation.js';
import { applyEdits } from './edits.js';
import type { CheckResult } from './checks.js';
import type { NativeTask } from './native-executor-contracts.js';
import type { NativeState } from './native-executor-state.js';
import { assertNativeHost } from './native-executor-host.js';
import type { NativeHost } from './native-executor-host.js';

export interface NativeFailedCheck {
  readonly source: string;
  readonly digest: string;
  readonly summary: Readonly<CheckResult>;
  readonly receiptCompleted: boolean;
  readonly accountingUncertain?: true;
}
const failures = new WeakMap<object, Readonly<NativeFailedCheck>>();
const facts = new WeakMap<object, Readonly<NativeFailedCheck>>();
function key(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}
/** Identity lookups deliberately never inspect the caught value's properties. */
export function nativeCheckFailure(error: unknown): Readonly<NativeFailedCheck> | null {
  return key(error) ? failures.get(error) ?? null : null;
}
export function nativeFailedCheckFacts(error: unknown): Readonly<NativeFailedCheck> | null {
  return key(error) ? facts.get(error) ?? null : null;
}
function failedSummary(text: string, id: string): Readonly<CheckResult> | null {
  const value = JSON.parse(text) as CheckResult | null;
  if (!value || value.passed !== false) return null;
  if (Object.keys(value).sort().join() !== 'exitCode,id,passed,stderr,stdout' || value.id !== id ||
      !(value.exitCode === null || Number.isSafeInteger(value.exitCode)) ||
      typeof value.stdout !== 'string' || typeof value.stderr !== 'string') throw new Error('Invalid native check summary');
  return Object.freeze(value);
}
export const nativeDynamicTools = ['host_read', 'host_apply', 'host_check'].map(name => ({
  type: 'function', name, description: 'Owner bounded ' + name,
  inputSchema: { type: 'object', additionalProperties: false, properties: name === 'host_read' ? { path: { type: 'string' } } : name === 'host_check' ? { id: { type: 'string' } } : { summary: { type: 'string' }, edits: { type: 'array', items: { type: 'object' } } },
} }));
export async function nativeTool(task: NativeTask, state: NativeState, host: NativeHost, tool: string, args: unknown, signal: AbortSignal): Promise<string> {
  assertNativeHost(host);
  host.boundary(); signal.throwIfAborted();
  host.project.assertCurrent(state.value.source);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Malformed tool arguments');
  const a = args as Record<string, unknown>;
  let result: unknown;
  if (tool === 'host_read') {
    if (Object.keys(a).join() !== 'path' || typeof a.path !== 'string' || !task.readPaths.includes(a.path)) throw new Error('Read outside exact grant');
    const path = safePath(task.root, a.path), stat = lstatSync(path);
    if (!stat.isFile() || stat.size > task.budget.resultBytes - state.value.counters.resultBytes) throw new Error('Read result limit');
    const receipt = host.authority.reserve({kind:'artifact', source:state.value.source, detail:{operation:'native.read',path:a.path,maxBytes:stat.size}});
    try { receipt.check(); host.boundary(); const content = readFileSync(path); result = { path: a.path, sha256: sha256(content), content: content.toString('utf8') }; receipt.finish('completed',sha256(content)); } catch(e) { receipt.finish('indeterminate'); throw e; }
  } else if (tool === 'host_apply') {
    state.update({ pending: 'files.apply' });
    const before = state.value.source;
    result = applyEdits(task.root, before, task.writePaths, args, host.authority, () => {
      host.boundary(); signal.throwIfAborted(); host.project.assertCurrent(before);
    });
    const transition = host.project.commitAppliedSource(before, result as import('./contracts.js').CodingResult);
    state.update({ source: transition.source });
  } else if (tool === 'host_check') {
    if (Object.keys(a).join() !== 'id' || typeof a.id !== 'string' || !task.checks.some(c => c.id === a.id)) throw new Error('Check outside exact grant');
    if (state.value.pending) throw new Error('Pending native effect requires reconciliation');
    const source = state.value.source;
    state.update({ pending: 'check' });
    const receipt = host.authority.reserve({kind:'command',source,detail:{operation:'native.predefined-check',command:task.checks.find(c=>c.id===a.id)}});
    let attempted = false, clearing = false, text: string;
    let serialized = false, accountAttempted = false, receiptCompleted = false, bytes = 0, digest = '';
    let summary: Readonly<CheckResult> | null = null, known: Readonly<NativeFailedCheck> | null = null;
    const account = () => {
      if (!serialized || accountAttempted) return;
      accountAttempted = true;
      const before = state.value.counters.resultBytes;
      try { state.charge('resultBytes', bytes); }
      catch (error) {
        // A cap rejection never advances the counter. Persistence failure can
        // follow a valid in-memory charge; keep those bounded facts uncertain.
        if (summary && Number.isSafeInteger(before + bytes) && before + bytes <= task.budget.resultBytes &&
            state.value.counters.resultBytes === before + bytes) {
          known = Object.freeze({source,digest,summary,receiptCompleted,accountingUncertain:true});
        }
        throw error;
      }
      if (summary) known = Object.freeze({source, digest, summary, receiptCompleted});
    };
    try {
      receipt.check(); result = await host.check(a.id, signal);
      text = JSON.stringify(result);
      summary = failedSummary(text, a.id); digest = sha256(text);
      bytes = Buffer.byteLength(text); serialized = true;
      host.boundary(); signal.throwIfAborted(); host.project.assertCurrent(source); receipt.check();
      attempted = true;
      receipt.finish('completed', digest);
      receiptCompleted = true;
      // A later accounting failure cannot change this completed terminal.
      account();
      host.boundary(); signal.throwIfAborted(); host.project.assertCurrent(source);
      if (state.value.source !== source || state.value.pending !== 'check') throw new Error('Native check checkpoint changed');
      clearing = true;
      state.update({ stage: tool, pending: null });
    } catch (error) {
      // Retain only charged facts; secondary accounting errors cannot replace
      // an earlier execution/finish error or authorize a second terminal.
      try { account(); } catch {}
      if (!attempted) {
        attempted = true;
        try { receipt.finish('indeterminate'); } catch { /* Keep the execution error. */ }
      }
      // NativeState mutates its in-memory value before writing. A failed clear
      // must remain uncertain even if that value already says pending=null.
      if (clearing && state.value.pending === null && state.value.source === source) {
        try { state.update({pending:'check', status:'indeterminate'}); } catch {}
      }
      if (known && key(error)) facts.set(error, known);
      throw error;
    }
    // This deliberate rejection is outside the execution/settlement catch.
    if (known) {
      const error = new Error('Native predefined check failed');
      failures.set(error, known); facts.set(error, known);
      throw error;
    }
    return text;
  } else throw new Error('Unknown native tool');
  host.boundary(); signal.throwIfAborted();
  const text = JSON.stringify(result); state.charge('resultBytes', Buffer.byteLength(text));
  state.update({ stage: tool, pending: null }); return text;
}
