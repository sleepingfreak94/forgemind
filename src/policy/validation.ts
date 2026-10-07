import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { actions } from './contracts.js';
import type { Action, ActionRequest, Capability, GrantInput } from './contracts.js';

export function text(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
}
export function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`invalid ${label}`);
  }
}
export function record(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(k => !keys.includes(k))) throw new Error('invalid fields');
}
export function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function fileResource(root: string, input: string): string {
  text(input, 'file resource');
  if (input.includes('\\') || input.split('/').includes('..')) throw new Error('invalid path');
  const target = resolve(root, input);
  if (!inside(root, target) || target === root) throw new Error('outside workspace');
  // Root itself is canonicalized at registration; reject links below it, even links inside it.
  if (realpathSync(root) !== root) throw new Error('workspace changed');
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('symlink resource');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}
export function resource(root: string, action: Action, input: unknown): string {
  text(input, 'resource');
  if (action.startsWith('file.')) return fileResource(root, input);
  if (action === 'network.request') {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('invalid destination');
    return url.href;
  }
  // A command is a host-registered identifier, never arbitrary shell text or arguments.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,255}$/.test(input)) throw new Error('invalid resource identifier');
  return input;
}
export function capability(root: string, raw: unknown): Capability {
  record(raw, ['action', 'resource']);
  if (!actions.includes(raw.action as Action)) throw new Error('invalid action');
  const action = raw.action as Action;
  return { action, resource: resource(root, action, raw.resource) };
}
export function request(root: string, raw: unknown): Readonly<ActionRequest> {
  record(raw, ['requestId', 'action', 'resource', 'sourceSnapshot', 'content']);
  text(raw.requestId, 'request ID', 128);
  text(raw.sourceSnapshot, 'source snapshot', 256);
  const cap = capability(root, { action: raw.action, resource: raw.resource });
  const result: ActionRequest = { requestId: raw.requestId, ...cap, sourceSnapshot: raw.sourceSnapshot };
  if (cap.action === 'file.write') {
    if (typeof raw.content !== 'string' || Buffer.byteLength(raw.content) > 65536) throw new Error('invalid content');
    result.content = raw.content;
  } else if (raw.content !== undefined) throw new Error('unexpected content');
  return Object.freeze(result);
}
export function grantInput(root: string, raw: unknown, now: number): GrantInput {
  record(raw, ['taskId', 'invocationId', 'role', 'capabilities', 'expiresAt', 'remainingDepth', 'maxActions', 'maxChildren', 'parentId']);
  text(raw.taskId, 'task ID', 128);
  text(raw.invocationId, 'invocation ID', 128);
  const roles = ['lead', 'researcher', 'architect', 'coder', 'qa', 'reviewer'];
  if (!roles.includes(raw.role as string)) throw new Error('invalid role');
  integer(raw.expiresAt, 'expiry', now + 1);
  integer(raw.remainingDepth, 'delegation depth', 0, 8);
  integer(raw.maxActions, 'action budget', 1, 100000);
  integer(raw.maxChildren, 'child limit', 0, 32);
  if (!Array.isArray(raw.capabilities) || raw.capabilities.length > 256) throw new Error('invalid capabilities');
  const capabilities = raw.capabilities.map(c => capability(root, c));
  const readonly = ['researcher', 'architect', 'reviewer'].includes(raw.role as string);
  if (readonly && capabilities.some(c => c.action !== 'file.read')) throw new Error('read-only role');
  if (raw.role !== 'lead' && capabilities.some(c => ['git.commit', 'git.push', 'pr.draft', 'git.merge', 'release'].includes(c.action))) {
    throw new Error('external action requires lead role');
  }
  if (raw.parentId !== undefined) text(raw.parentId, 'parent ID', 128);
  return { taskId: raw.taskId, invocationId: raw.invocationId, role: raw.role as GrantInput['role'], capabilities,
    expiresAt: raw.expiresAt, remainingDepth: raw.remainingDepth, maxActions: raw.maxActions, maxChildren: raw.maxChildren,
    ...(raw.parentId === undefined ? {} : { parentId: raw.parentId as string }) };
}
