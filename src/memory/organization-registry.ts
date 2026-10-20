import { digest, freeze, object, serialize } from '../context-engine/validation.js';
import { readProject } from '../project-workflow/project.js';
import { canonicalWorkspace } from './documents.js';
import { OrganizationRegistryStorage } from './organization-registry-storage.js';
import { label, OrganizationDenied, projectKey, safeOrganizationJSON } from './organization-registry-contracts.js';
import type { LocalMember, LocalOperation, LocalOrganizationState, LocalReceipt, LocalResource, LocalResult, LocalStatus } from './organization-registry-contracts.js';

/** Trusted local owner only. Principal labels do not authenticate people or processes. */
export class OrganizationRegistry {
  readonly #storage: OrganizationRegistryStorage;
  readonly organizationId: string;
  readonly workspaceRoot: string;
  readonly projectId: string;
  readonly projectKey: string;
  constructor(directory: string, workspaceRoot: string, organizationId: string) {
    label(organizationId);
    this.workspaceRoot = canonicalWorkspace(workspaceRoot);
    this.projectId = readProject(this.workspaceRoot).projectId; label(this.projectId);
    this.organizationId = organizationId; this.projectKey = projectKey(this.workspaceRoot, this.projectId);
    this.#storage = OrganizationRegistryStorage.open(directory, this.workspaceRoot, organizationId);
  }
  close(): void { this.#storage.close(); }
  protected operate<T>(operation: LocalOperation, raw: unknown, keys: string[],
    work: (state: LocalOrganizationState, input: Record<string, unknown>) => T): LocalResult<T> {
    let value: Record<string, unknown> | undefined;
    try {
      const checked = safeOrganizationJSON(raw);
      object(checked, ['organizationId', 'principalId', 'projectId', ...keys]);
      label(checked.organizationId); label(checked.principalId); label(checked.projectId);
      value = checked;
    } catch { /* No input reflection or error text is retained in receipts. */ }
    return this.#storage.transaction((state) => {
      const result: LocalResult<T> = {} as LocalResult<T>;
      let status: LocalStatus = 'ok';
      try {
        if (!value) throw new OrganizationDenied('invalid-input');
        canonicalWorkspace(this.workspaceRoot);
        if (readProject(this.workspaceRoot).projectId !== this.projectId || value.projectId !== this.projectId || value.organizationId !== this.organizationId) throw new OrganizationDenied();
        result.value = work(state, value);
      } catch (error) {
        if (!(error instanceof OrganizationDenied)) throw error;
        status = error.status;
      }
      return { value: result, receipt: (revision, stateDigest) => {
        const body = { schemaVersion: 1 as const, operation, organizationId: this.organizationId,
          principalDigest: value ? digest(value.principalId as string) : null, projectKey: this.projectKey,
          decision: status === 'ok' ? 'allowed' as const : 'denied' as const, status, revision, stateDigest };
        const receipt = freeze({ ...body, digest: digest(serialize(body)) });
        result.receipt = receipt; freeze(result); return receipt;
      } };
    });
  }
  protected memberFor(state: LocalOrganizationState, principalId: unknown): LocalMember {
    const member = state.members.find(item => item.principalId === principalId);
    if (!member || member.status !== 'active') throw new OrganizationDenied();
    return member;
  }
  protected owner(state: LocalOrganizationState, principalId: unknown): LocalMember {
    const member = this.memberFor(state, principalId);
    if (member.role !== 'owner' || member.principalId !== state.ownerId) throw new OrganizationDenied();
    return member;
  }
  protected permission(state: LocalOrganizationState, principalId: unknown, action: 'read' | 'share'): { member: LocalMember; resource: LocalResource } {
    const member = this.memberFor(state, principalId), resource = state.resources.find(item => item.key === this.projectKey);
    const grant = resource?.grants.find(item => item.principalId === principalId);
    if (!resource?.enabled || !grant?.[action] || action === 'share' && member.role === 'reader') throw new OrganizationDenied();
    return { member, resource };
  }
  bootstrap(raw: unknown): LocalResult<{ ownerId: string }> {
    return this.operate('bootstrap', raw, [], (state, input) => {
      const id = input.principalId as string;
      if (state.ownerId !== null && state.ownerId !== id) throw new OrganizationDenied();
      if (state.ownerId === null) {
        state.ownerId = id; state.members.push({ principalId: id, role: 'owner', status: 'active', epoch: 1 });
      }
      return { ownerId: id };
    });
  }
  setMember(raw: unknown): LocalResult<LocalMember> {
    return this.operate('member', raw, ['memberId', 'role', 'status'], (state, input) => {
      this.owner(state, input.principalId); label(input.memberId);
      if (!['editor', 'reader'].includes(input.role as string) || !['active', 'suspended', 'revoked'].includes(input.status as string) || input.memberId === state.ownerId) throw new OrganizationDenied();
      const existing = state.members.find(item => item.principalId === input.memberId);
      if (existing && existing.role === input.role && existing.status === input.status) return { ...existing };
      if (!existing && state.members.length >= 128) throw new OrganizationDenied();
      const member: LocalMember = { principalId: input.memberId, role: input.role as 'editor' | 'reader',
        status: input.status as 'active' | 'suspended' | 'revoked', epoch: (existing?.epoch ?? 0) + 1 };
      if (existing) state.members[state.members.indexOf(existing)] = member; else state.members.push(member);
      for (const copy of state.copies) if (copy.principalId === member.principalId) { copy.record = null; copy.revoked = true; }
      return { ...member };
    });
  }
  configure(raw: unknown): LocalResult<{ projectKey: string; epoch: number }> {
    return this.operate('configure', raw, ['enabled', 'grants'], (state, input) => {
      this.owner(state, input.principalId);
      if (typeof input.enabled !== 'boolean' || !Array.isArray(input.grants) || input.grants.length > 128) throw new OrganizationDenied('invalid-input');
      const grants = input.grants.map(rawGrant => {
        try { object(rawGrant, ['principalId', 'read', 'share']); } catch { throw new OrganizationDenied('invalid-input'); }
        label(rawGrant.principalId);
        const member = this.memberFor(state, rawGrant.principalId);
        if (typeof rawGrant.read !== 'boolean' || typeof rawGrant.share !== 'boolean' || rawGrant.share && member.role === 'reader') throw new OrganizationDenied('invalid-input');
        return { principalId: rawGrant.principalId, read: rawGrant.read, share: rawGrant.share };
      }).sort((a, b) => a.principalId.localeCompare(b.principalId));
      if (new Set(grants.map(grant => grant.principalId)).size !== grants.length) throw new OrganizationDenied('invalid-input');
      const old = state.resources.find(resource => resource.key === this.projectKey);
      if (old && old.enabled === input.enabled && serialize(old.grants) === serialize(grants)) return { projectKey: old.key, epoch: old.epoch };
      if (!old && state.resources.length >= 128) throw new OrganizationDenied();
      const resource: LocalResource = { key: this.projectKey, projectId: this.projectId, workspaceRoot: this.workspaceRoot,
        enabled: input.enabled, grants, epoch: (old?.epoch ?? 0) + 1 };
      if (old) state.resources[state.resources.indexOf(old)] = resource; else state.resources.push(resource);
      for (const copy of state.copies) if (copy.projectKey === this.projectKey) { copy.record = null; copy.revoked = true; }
      state.approvals = state.approvals.filter(approval => approval.projectKey !== this.projectKey);
      return { projectKey: this.projectKey, epoch: resource.epoch };
    });
  }
  status(raw: unknown): LocalResult<unknown> {
    return this.operate('status', raw, [], (state, input) => {
      this.owner(state, input.principalId);
      return { trust: 'local-owner-asserted-labels', ownerId: state.ownerId, members: structuredClone(state.members),
        resource: structuredClone(state.resources.find(resource => resource.key === this.projectKey) ?? null),
        approvals: state.approvals.filter(approval => approval.projectKey === this.projectKey).map(approval => approval.id),
        copies: state.copies.filter(copy => copy.projectKey === this.projectKey).map(copy => ({ id: copy.id, revoked: copy.revoked })),
        promotion: 'disabled-governance-unconfigured' };
    });
  }
  promote(raw: unknown): LocalResult<never> {
    return this.operate('promote', raw, [], () => { throw new OrganizationDenied(); });
  }
}
