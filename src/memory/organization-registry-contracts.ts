import { types } from 'node:util';
import { dataSnapshot, digest, object, serialize } from '../context-engine/validation.js';
import { input as memoryInput, hash } from './validation.js';
import type { MemoryRecord } from './contracts.js';

export type LocalRole = 'owner' | 'editor' | 'reader';
export type MemberStatus = 'active' | 'suspended' | 'revoked';
export interface LocalMember { principalId: string; role: LocalRole; status: MemberStatus; epoch: number }
export interface LocalGrant { principalId: string; read: boolean; share: boolean }
export interface LocalResource { key: string; projectId: string; workspaceRoot: string; enabled: boolean; grants: LocalGrant[]; epoch: number }
export interface LocalApproval {
  id: string; projectKey: string; resourceEpoch: number; sourceDirectory: string;
  recordId: string; recordDigest: string; recordBinding: string;
}
export interface LocalCopy {
  id: string; approvalId: string; projectKey: string; principalId: string; memberEpoch: number;
  record: MemoryRecord | null; revoked: boolean;
}
export interface LocalOrganizationState {
  schemaVersion: 1; organizationId: string; ownerId: string | null;
  members: LocalMember[]; resources: LocalResource[]; approvals: LocalApproval[]; copies: LocalCopy[];
}
export type LocalOperation = 'bootstrap' | 'member' | 'configure' | 'inspect' | 'approve' | 'share' | 'read' | 'revoke' | 'promote' | 'status';
export type LocalStatus = 'ok' | 'denied' | 'invalid-input' | 'source-unavailable';
export interface LocalReceipt {
  schemaVersion: 1; operation: LocalOperation; organizationId: string; principalDigest: string | null;
  projectKey: string; decision: 'allowed' | 'denied'; status: LocalStatus;
  revision: number; stateDigest: string; digest: string;
}
export interface LocalResult<T = unknown> { receipt: Readonly<LocalReceipt>; value?: T }
export class OrganizationDenied extends Error {
  constructor(readonly status: Exclude<LocalStatus, 'ok'> = 'denied') { super('Local organization operation denied'); }
}
export function label(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new OrganizationDenied('invalid-input');
}
/** Reject proxies before reflection; never invoke accessors/toJSON, bound traversal before cloning. */
export function safeOrganizationJSON<T>(raw: T): Readonly<T> {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  function walk(value: unknown, depth: number): void {
    if (++nodes > 4096 || depth > 10) throw new OrganizationDenied('invalid-input');
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > 65536) throw new OrganizationDenied('invalid-input'); return; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || types.isProxy(value) || seen.has(value)) throw new OrganizationDenied('invalid-input');
    if (Object.getOwnPropertySymbols(value).length) throw new OrganizationDenied('invalid-input');
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new OrganizationDenied('invalid-input');
    const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
    if (entries.length > 1024) throw new OrganizationDenied('invalid-input');
    seen.add(value);
    for (const [key, descriptor] of entries) {
      if (array && key === 'length') continue;
      bytes += Buffer.byteLength(key);
      if (bytes > 65536 || descriptor.get || descriptor.set || !descriptor.enumerable) throw new OrganizationDenied('invalid-input');
      walk(descriptor.value, depth + 1);
    }
    seen.delete(value);
  }
  walk(raw, 0);
  try { return dataSnapshot(raw); } catch { throw new OrganizationDenied('invalid-input'); }
}
export function projectKey(workspaceRoot: string, projectId: string): string { return digest(serialize({ workspaceRoot, projectId })); }
export function recordBinding(record: MemoryRecord): string { return digest(serialize(record)); }
export function initialState(organizationId: string): LocalOrganizationState {
  return { schemaVersion: 1, organizationId, ownerId: null, members: [], resources: [], approvals: [], copies: [] };
}
function natural(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('invalid organization epoch'); }
function unique(values: string[]): void { if (new Set(values).size !== values.length) throw new Error('duplicate organization row'); }
/** Persistence is private owner state, but malformed/replaced data still fails closed. */
export function validateState(raw: unknown, organizationId: string): LocalOrganizationState {
  // State has a separate bounded budget because it contains multiple approved copies.
  const value = dataSnapshot(raw) as unknown as LocalOrganizationState;
  object(value, ['schemaVersion', 'organizationId', 'ownerId', 'members', 'resources', 'approvals', 'copies']);
  if (value.schemaVersion !== 1 || value.organizationId !== organizationId) throw new Error('organization identity mismatch');
  label(value.organizationId);
  for (const key of ['members', 'resources', 'approvals', 'copies'] as const) {
    if (!Array.isArray(value[key]) || value[key].length > 128) throw new Error('organization row budget');
    unique(value[key].map(row => key === 'members' ? (row as LocalMember).principalId : key === 'resources' ? (row as LocalResource).key : (row as LocalApproval | LocalCopy).id));
  }
  for (const member of value.members) {
    object(member, ['principalId', 'role', 'status', 'epoch']); label(member.principalId); natural(member.epoch);
    if (!['owner', 'editor', 'reader'].includes(member.role) || !['active', 'suspended', 'revoked'].includes(member.status)) throw new Error('invalid organization member');
  }
  if (value.ownerId === null) {
    if (value.members.length || value.resources.length || value.approvals.length || value.copies.length) throw new Error('unbootstrapped organization state');
  } else {
    label(value.ownerId);
    const owners = value.members.filter(member => member.role === 'owner');
    if (owners.length !== 1 || owners[0]!.principalId !== value.ownerId || owners[0]!.status !== 'active') throw new Error('invalid bootstrap owner');
  }
  for (const resource of value.resources) {
    object(resource, ['key', 'projectId', 'workspaceRoot', 'enabled', 'grants', 'epoch']); label(resource.projectId); natural(resource.epoch);
    hash(resource.key);
    if (typeof resource.workspaceRoot !== 'string' || resource.workspaceRoot.length > 4096 ||
        resource.key !== projectKey(resource.workspaceRoot, resource.projectId) || typeof resource.enabled !== 'boolean' ||
        !Array.isArray(resource.grants) || resource.grants.length > 128) throw new Error('invalid organization resource');
    unique(resource.grants.map(grant => grant.principalId));
    for (const grant of resource.grants) {
      object(grant, ['principalId', 'read', 'share']); label(grant.principalId);
      if (typeof grant.read !== 'boolean' || typeof grant.share !== 'boolean' || !value.members.some(member => member.principalId === grant.principalId)) throw new Error('invalid organization grant');
    }
  }
  for (const approval of value.approvals) {
    object(approval, ['id', 'projectKey', 'resourceEpoch', 'sourceDirectory', 'recordId', 'recordDigest', 'recordBinding']);
    for (const field of ['id', 'projectKey', 'recordId', 'recordDigest', 'recordBinding'] as const) hash(approval[field]);
    natural(approval.resourceEpoch);
    if (typeof approval.sourceDirectory !== 'string' || approval.sourceDirectory.length > 4096) throw new Error('invalid source directory');
    const { id, ...body } = approval;
    if (id !== digest(serialize(body)) || !value.resources.some(resource => resource.key === approval.projectKey && resource.epoch === approval.resourceEpoch)) throw new Error('unbound organization approval');
  }
  for (const copy of value.copies) {
    object(copy, ['id', 'approvalId', 'projectKey', 'principalId', 'memberEpoch', 'record', 'revoked']);
    hash(copy.id); hash(copy.approvalId); hash(copy.projectKey); label(copy.principalId); natural(copy.memberEpoch);
    if (typeof copy.revoked !== 'boolean' || copy.revoked !== (copy.record === null)) throw new Error('invalid organization copy');
    if (copy.id !== digest(serialize({ approvalId: copy.approvalId, projectKey: copy.projectKey, principalId: copy.principalId, memberEpoch: copy.memberEpoch }))) throw new Error('copy identity mismatch');
    if (copy.record !== null) {
      const record = copy.record;
      object(record, ['kind', 'title', 'text', 'sources', 'expiresAt', 'supersedes', 'id', 'digest', 'projectId', 'workspaceRoot', 'createdAt', 'state']);
      memoryInput({ kind: record.kind, title: record.title, text: record.text, sources: record.sources,
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
        ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }) });
      const approval = value.approvals.find(item => item.id === copy.approvalId);
      if (!approval || record.state !== 'validated' || record.id !== approval.recordId || record.digest !== approval.recordDigest ||
          recordBinding(record) !== approval.recordBinding || copy.projectKey !== projectKey(record.workspaceRoot, record.projectId)) throw new Error('copy record binding mismatch');
    }
  }
  return structuredClone(value);
}
