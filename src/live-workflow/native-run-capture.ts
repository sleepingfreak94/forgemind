import { types } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunAuthority, privateDirectory } from './authority.js';
import { createOwnerArtifactAttempt } from './owner-artifact-io.js';
import type { OwnerArtifactWriter, OwnerJson } from './owner-artifact-contracts.js';
import type { NativeTask } from './native-executor-contracts.js';
import { sha256 } from './validation.js';

const captureErrors = new WeakSet<object>();
export class NativeCaptureError extends Error {
  constructor() { super('Native capture unavailable'); captureErrors.add(this); }
}
export function isNativeCaptureError(error: unknown): boolean {
  return error !== null && (typeof error === 'object' || typeof error === 'function') && captureErrors.has(error);
}
/** Select data descriptors only. Undefined optional receipt fields are omitted,
 * as in the existing CLI envelope; no exception, getter or toJSON is inspected. */
export function captureJson(value: unknown): OwnerJson {
  const active = new Set<object>(); let nodes = 0;
  function visit(item: unknown, depth: number): OwnerJson {
    if (++nodes > 100000 || depth > 64) throw new NativeCaptureError();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || types.isProxy(item) || active.has(item)) throw new NativeCaptureError();
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) throw new NativeCaptureError();
    if (Object.getOwnPropertyDescriptor(item, 'toJSON')) throw new NativeCaptureError();
    active.add(item);
    try {
      if (array) {
        const length = Object.getOwnPropertyDescriptor(item, 'length')?.value;
        if (!Number.isSafeInteger(length) || length > 100000 || Reflect.ownKeys(item).length !== length + 1) throw new NativeCaptureError();
        const out: OwnerJson[] = [];
        for (let i = 0; i < length; i++) {
          const d = Object.getOwnPropertyDescriptor(item, String(i));
          if (!d || !('value' in d)) throw new NativeCaptureError();
          out.push(visit(d.value, depth + 1));
        }
        return out;
      }
      const out: { [key: string]: OwnerJson } = Object.create(null);
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== 'string') throw new NativeCaptureError();
        const d = Object.getOwnPropertyDescriptor(item, key);
        if (!d || !('value' in d) || !d.enumerable) throw new NativeCaptureError();
        if (d.value !== undefined) out[key] = visit(d.value, depth + 1);
      }
      return out;
    } finally { active.delete(item); }
  }
  return visit(value, 0);
}
export interface NativeRunCapture {
  readonly directory: string;
  finish(envelope: unknown, failure?: { phase: string; code: string }): void;
  close(): void;
}
/** Artifact-only settlement grace never extends model, command or account budgets.
 * Trusted owner evidence port, never a model tool or execution capability.
 * Its separate authority can only be reached through these artifact methods. */
export function beginNativeRunCapture(task: NativeTask, runDirectory: string, requestBinding: string,
  runtimeMs: number): NativeRunCapture {
  if (!/^[a-f0-9]{64}$/.test(requestBinding)) throw new NativeCaptureError();
  const id = randomUUID(), taskId = 'capture-' + sha256(task.task).slice(0, 32);
  const state = join(runDirectory, 'capture-authority', id);
  const authority = new RunAuthority(state, task.root, task.project, {
    schemaVersion: 1, taskId, objective: 'Private structured native owner capture', readPaths: [], writePaths: [], checks: [],
    model: 'none', effort: 'low', maxModelRequests: 0, maxPromptBytes: 1,
    maxOutputBytes: 16777216, maxRuntimeMs: Math.min(runtimeMs + 35000, 2147483647), draftPr: false,
  }, task.source);
  const root = join(runDirectory, 'capture'); let writer: OwnerArtifactWriter;
  let closed = false, terminal = false, resumeAttempted = false;
  function artifact<T>(phase: string, operation: () => T): T {
    const receipt = authority.reserve({ kind: 'artifact', source: task.source,
      detail: { operation: 'native.owner-capture', phase, root, attempt: id } });
    let settled = false;
    try {
      receipt.check(); const result = operation(); settled = true; receipt.finish('completed'); return result;
    } catch {
      if (!settled) { try { receipt.finish('failed'); } catch { /* Durable reservation remains uncertain. */ } }
      throw new NativeCaptureError();
    }
  }
  try {
    writer = artifact('prepare', () => {
      privateDirectory(root);
      const value = createOwnerArtifactAttempt({ root, project: task.root,
        scope: { taskId, sourceSha256: task.source, requestSha256: requestBinding } }, id);
      value.writeJson('start.json', { schema: 'native-owner-capture-v1', source: task.source,
        requestBinding, model: task.model, effort: task.effort, policyDirectory: state });
      value.progress({ stage: 'prepare', status: 'running', completed: 0, total: 1 });
      return value;
    });
  } catch (error) { authority.finish('failed'); authority.close(); throw error; }
  function resume(failure: {phase: string; code: string}): void {
    if(resumeAttempted)return;resumeAttempted=true;
    artifact('failure-resume',()=>{
      const safe=(v:string)=>/^[a-z0-9-]{1,96}$/.test(v)?v:'unknown';
      const failures=privateDirectory(join(runDirectory,'failures'));
      writeFileSync(join(failures,id+'.md'),'# Native run stopped\n\nSource: '+task.source+
        '\n\nPhase: '+safe(failure.phase)+'\n\nCode: '+safe(failure.code)+
        '\n\nEvidence attempt: '+id+'\n\nTerminal capture may be incomplete; inspect acceptance and failure artifacts. Preserve this attempt; diagnose before a fresh scoped run. Automatic inference retries: zero.\n',
        {flag:'wx',mode:0o600});
    });
  }
  return Object.freeze({ directory: join(root, id),
    finish(envelope: unknown, failure?: { phase: string; code: string }): void {
      if (terminal || closed) throw new NativeCaptureError(); terminal = true;
      try {
        artifact('terminal', () => {
          writer.writeJson('terminal.json', captureJson(envelope));
          writer.accept();
        });
        if(failure)resume(failure);
        authority.finish('completed');
      } catch {
        try{resume(failure??{phase:'capture',code:'capture-unavailable'});}catch{/* Independent note unavailable; no retry. */}
        authority.finish('failed');throw new NativeCaptureError();
      }
    },
    close(): void {
      if (closed) return; closed = true;
      if (!terminal) {
        try { artifact('incomplete', () => writer.incomplete()); } catch { /* Preserve incomplete capture. */ }
        authority.finish('failed');
      }
      authority.close();
    },
  });
}
