import { realpathSync } from 'node:fs';
import { digest, serialize } from '../context-engine/validation.js';
import { hash } from './validation.js';
import { ProjectMemory } from './service.js';
import { OrganizationRegistry } from './organization-registry.js';
import { OrganizationDenied, recordBinding, safeOrganizationJSON } from './organization-registry-contracts.js';
import type { LocalApproval, LocalCopy, LocalOrganizationState, LocalResult } from './organization-registry-contracts.js';
import type { MemoryRecord } from './contracts.js';

export interface LocalSharedPacket {
  schemaVersion: 1; organizationId: string; projectKey: string; shareId: string;
  trust: 'evidence-only'; record: Readonly<MemoryRecord>; digest: string;
}
/** Trusted owner service; never accepts serialized candidates or supplied source adapters. */
export class LocalOrganizationSharing extends OrganizationRegistry {
  readonly #sourceDirectory: string;
  constructor(directory: string, workspaceRoot: string, organizationId: string, projectMemoryDirectory: string) {
    const source = realpathSync(projectMemoryDirectory);
    if (source !== projectMemoryDirectory) throw new Error('canonical project memory directory required');
    super(directory, workspaceRoot, organizationId);
    this.#sourceDirectory = source;
  }
  #hash(value: unknown): asserts value is string {
    try { hash(value); } catch { throw new OrganizationDenied('invalid-input'); }
  }
  #invalidateOrigin(state: LocalOrganizationState, recordId: string): void {
    const ids = new Set(state.approvals.filter(approval => approval.projectKey === this.projectKey &&
      approval.sourceDirectory === this.#sourceDirectory && approval.recordId === recordId).map(approval => approval.id));
    for (const copy of state.copies) if (ids.has(copy.approvalId)) { copy.record = null; copy.revoked = true; }
  }
  #fresh(state: LocalOrganizationState, id: string): Readonly<MemoryRecord> {
    let memory: ProjectMemory | undefined;
    try {
      memory = new ProjectMemory(this.#sourceDirectory, this.workspaceRoot);
      const record = memory.get(id);
      if (!record || record.projectId !== this.projectId || record.workspaceRoot !== this.workspaceRoot || record.state !== 'validated' ||
          Buffer.byteLength(serialize(record)) > 16000) throw new OrganizationDenied('source-unavailable');
      return record;
    } catch {
      this.#invalidateOrigin(state, id);
      throw new OrganizationDenied('source-unavailable');
    } finally { memory?.close(); }
  }
  #approvedRecord(state: LocalOrganizationState, approval: LocalApproval): Readonly<MemoryRecord> {
    if (approval.sourceDirectory !== this.#sourceDirectory || approval.projectKey !== this.projectKey) throw new OrganizationDenied();
    const record = this.#fresh(state, approval.recordId);
    if (record.digest !== approval.recordDigest || recordBinding(record) !== approval.recordBinding) {
      this.#invalidateOrigin(state, approval.recordId);
      throw new OrganizationDenied('source-unavailable');
    }
    return record;
  }
  inspectRecord(raw: unknown): LocalResult<{ record: Readonly<MemoryRecord>; recordBinding: string }> {
    return this.operate('inspect', raw, ['recordId'], (state, input) => {
      this.owner(state, input.principalId); this.#hash(input.recordId);
      const record = this.#fresh(state, input.recordId);
      return { record, recordBinding: recordBinding(record) };
    });
  }
  approve(raw: unknown): LocalResult<{ approvalId: string }> {
    return this.operate('approve', raw, ['recordId', 'recordDigest', 'recordBinding'], (state, input) => {
      this.owner(state, input.principalId);
      const { resource } = this.permission(state, input.principalId, 'share');
      this.#hash(input.recordId); this.#hash(input.recordDigest); this.#hash(input.recordBinding);
      const record = this.#fresh(state, input.recordId);
      if (record.digest !== input.recordDigest || recordBinding(record) !== input.recordBinding) throw new OrganizationDenied('source-unavailable');
      const body = { projectKey: this.projectKey, resourceEpoch: resource.epoch, sourceDirectory: this.#sourceDirectory,
        recordId: record.id, recordDigest: record.digest, recordBinding: input.recordBinding };
      const approval: LocalApproval = { ...body, id: digest(serialize(body)) };
      if (!state.approvals.some(item => item.id === approval.id)) {
        if (state.approvals.length >= 128) throw new OrganizationDenied();
        state.approvals.push(approval);
      }
      return { approvalId: approval.id };
    });
  }
  #approval(state: LocalOrganizationState, id: unknown): LocalApproval {
    this.#hash(id);
    const approval = state.approvals.find(item => item.id === id && item.projectKey === this.projectKey);
    const resource = state.resources.find(item => item.key === this.projectKey);
    if (!approval || approval.resourceEpoch !== resource?.epoch) throw new OrganizationDenied();
    return approval;
  }
  async share(raw: unknown): Promise<LocalResult<{ shareId: string }>> {
    let checked: unknown;
    try { checked = safeOrganizationJSON(raw); } catch { checked = null; }
    await Promise.resolve();
    return this.operate('share', checked, ['approvalId'], (state, input) => {
      const { member } = this.permission(state, input.principalId, 'share');
      const approval = this.#approval(state, input.approvalId), record = this.#approvedRecord(state, approval);
      const body = { approvalId: approval.id, projectKey: this.projectKey, principalId: member.principalId, memberEpoch: member.epoch };
      const id = digest(serialize(body)), existing = state.copies.find(copy => copy.id === id);
      if (existing?.revoked) throw new OrganizationDenied();
      if (!existing) {
        if (state.copies.length >= 128 || Buffer.byteLength(serialize(state)) + Buffer.byteLength(serialize(record)) > 900000) throw new OrganizationDenied();
        state.copies.push({ ...body, id, record: structuredClone(record), revoked: false });
      }
      return { shareId: id };
    });
  }
  async read(raw: unknown): Promise<LocalResult<Readonly<LocalSharedPacket>>> {
    let checked: unknown;
    try { checked = safeOrganizationJSON(raw); } catch { checked = null; }
    await Promise.resolve();
    return this.operate('read', checked, ['shareId'], (state, input) => {
      this.permission(state, input.principalId, 'read'); this.#hash(input.shareId);
      const copy = state.copies.find(item => item.id === input.shareId && item.projectKey === this.projectKey);
      if (!copy || copy.revoked || !copy.record) throw new OrganizationDenied();
      let record: Readonly<MemoryRecord>;
      try {
        const { member } = this.permission(state, copy.principalId, 'share');
        if (member.epoch !== copy.memberEpoch) throw new OrganizationDenied();
        const approval = this.#approval(state, copy.approvalId);
        record = this.#approvedRecord(state, approval);
        if (recordBinding(record) !== recordBinding(copy.record)) throw new OrganizationDenied('source-unavailable');
      } catch (error) {
        if (!(error instanceof OrganizationDenied)) throw error;
        copy.record = null; copy.revoked = true; throw error;
      }
      const body = { schemaVersion: 1 as const, organizationId: this.organizationId, projectKey: this.projectKey,
        shareId: copy.id, trust: 'evidence-only' as const, record: structuredClone(record) };
      return { ...body, digest: digest(serialize(body)) };
    });
  }
  revoke(raw: unknown): LocalResult<{ shareId: string; revoked: true }> {
    return this.operate('revoke', raw, ['shareId'], (state, input) => {
      this.owner(state, input.principalId); this.#hash(input.shareId);
      const copy: LocalCopy | undefined = state.copies.find(item => item.id === input.shareId && item.projectKey === this.projectKey);
      if (!copy) throw new OrganizationDenied();
      copy.record = null; copy.revoked = true;
      return { shareId: copy.id, revoked: true };
    });
  }
}
