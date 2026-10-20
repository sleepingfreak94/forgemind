import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixture.js';
import { LocalOrganizationSharing } from '../../src/memory/organization-sharing.js';
import { recordBinding } from '../../src/memory/organization-registry-contracts.js';

// Guard only cases that construct the POSIX owner-storage fixture.
function storageTest(name: string, run: () => void | Promise<void>): void {
  void test(name, { skip: typeof process.getuid === 'function' ? false : "Organization owner storage requires process.getuid and POSIX UID/mode checks; native Windows/ACL enforcement is deferred" }, run);
}

function setup() {
  const f = fixture(), directory = join(f.base, 'organization');
  let sharing = new LocalOrganizationSharing(directory, f.root, 'team', f.directory);
  const actor = (principalId = 'owner') => ({ organizationId: 'team', projectId: f.projectId, principalId });
  const grant = (principalId: string, share: boolean) => ({ principalId, read: true, share });
  const grants = [grant('owner', true), grant('writer', true), grant('viewer', false)];
  sharing.bootstrap(actor());
  sharing.setMember({ ...actor(), memberId: 'writer', role: 'editor', status: 'active' });
  sharing.setMember({ ...actor(), memberId: 'viewer', role: 'reader', status: 'active' });
  const configure = (enabled = true) => sharing.configure({ ...actor(), enabled, grants });
  configure();
  const id = f.memory.add(f.input()); f.memory.validate(id, id);
  const record = f.memory.get(id)!;
  const approveInput = { ...actor(), recordId: id, recordDigest: id, recordBinding: recordBinding(record) };
  const approve = () => sharing.approve(approveInput);
  return { f, directory, actor, grants, id, record, approveInput, approve, configure,
    get sharing() { return sharing; },
    reopen() { sharing.close(); sharing = new LocalOrganizationSharing(directory, f.root, 'team', f.directory); },
    dispose() { sharing.close(); f.dispose(); } };
}
storageTest('exact owner approval permits explicit editor copy and reader access across restart', async () => {
  const s = setup();
  try {
    const inspection = s.sharing.inspectRecord({ ...s.actor(), recordId: s.id });
    assert.deepEqual(inspection.value?.record, s.record);
    assert.equal(inspection.value?.recordBinding, s.approveInput.recordBinding);
    const approvalId = s.approve().value!.approvalId;
    assert.equal(s.approve().value!.approvalId, approvalId);
    const input = { ...s.actor('writer'), approvalId };
    const shared = await s.sharing.share(input), shareId = shared.value!.shareId;
    assert.equal(shared.receipt.decision, 'allowed');
    assert.equal((await s.sharing.share(input)).value?.shareId, shareId);
    s.reopen();
    const read = await s.sharing.read({ ...s.actor('viewer'), shareId });
    assert.equal(read.receipt.decision, 'allowed');
    assert.deepEqual(read.value?.record, s.record);
    assert.equal(read.value?.trust, 'evidence-only');
    assert.equal((await s.sharing.share({ ...s.actor('viewer'), approvalId })).receipt.decision, 'denied');
    assert.equal(s.sharing.approve({ ...s.approveInput, principalId: 'writer' }).receipt.decision, 'denied');
    assert.equal(s.sharing.inspectRecord({ ...s.actor('viewer'), recordId: s.id }).receipt.decision, 'denied');
    assert.equal(s.sharing.promote(s.actor()).receipt.decision, 'denied');
  } finally { s.dispose(); }
});
storageTest('no rights from candidates, missing approval, unvalidated record or mismatched binding', async () => {
  const s = setup();
  try {
    assert.equal((await s.sharing.share({ ...s.actor('writer'), approvalId: 'a'.repeat(64) })).receipt.decision, 'denied');
    const candidate = s.f.memory.add(s.f.input('Unvalidated candidate text'));
    assert.equal(s.sharing.approve({ ...s.approveInput, recordId: candidate, recordDigest: candidate }).receipt.decision, 'denied');
    assert.equal(s.sharing.approve({ ...s.approveInput, recordBinding: 'b'.repeat(64) }).receipt.decision, 'denied');
    assert.equal(s.sharing.approve({ ...s.approveInput, recordDigest: 'b'.repeat(64) }).receipt.decision, 'denied');
    const evidence = { schemaVersion: 1, organizationId: 'team', principalId: 'owner', sources: [s.record], role: 'owner' };
    assert.equal((await s.sharing.share(evidence)).receipt.status, 'invalid-input');
    s.configure(false);
    assert.equal(s.approve().receipt.decision, 'denied');
  } finally { s.dispose(); }
});
storageTest('reader revoked after async boundary denies immediately; live writer revocation erases copies permanently', async () => {
  const s = setup();
  try {
    const approvalId = s.approve().value!.approvalId;
    const shareId = (await s.sharing.share({ ...s.actor('writer'), approvalId })).value!.shareId;
    const pending = s.sharing.read({ ...s.actor('viewer'), shareId });
    s.sharing.setMember({ ...s.actor(), memberId: 'viewer', role: 'reader', status: 'revoked' });
    assert.equal((await pending).receipt.decision, 'denied');
    s.sharing.setMember({ ...s.actor(), memberId: 'viewer', role: 'reader', status: 'active' });
    assert.equal((await s.sharing.read({ ...s.actor('viewer'), shareId })).receipt.decision, 'allowed');
    s.sharing.setMember({ ...s.actor(), memberId: 'writer', role: 'editor', status: 'suspended' });
    s.reopen();
    assert.equal((await s.sharing.read({ ...s.actor('viewer'), shareId })).receipt.decision, 'denied');
    s.sharing.setMember({ ...s.actor(), memberId: 'writer', role: 'editor', status: 'active' });
    assert.equal((await s.sharing.read({ ...s.actor('viewer'), shareId })).receipt.decision, 'denied');
    const fresh = await s.sharing.share({ ...s.actor('writer'), approvalId });
    assert.equal(fresh.receipt.decision, 'allowed');
    assert.notEqual(fresh.value!.shareId, shareId);
  } finally { s.dispose(); }
});
storageTest('share permission changes while awaiting are rechecked and caller JSON is snapshotted', async () => {
  const s = setup();
  let other: LocalOrganizationSharing | undefined;
  try {
    const approvalId = s.approve().value!.approvalId;
    other = new LocalOrganizationSharing(s.directory, s.f.root, 'team', s.f.directory);
    const pending = s.sharing.share({ ...s.actor('writer'), approvalId });
    other.setMember({ ...s.actor(), memberId: 'writer', role: 'editor', status: 'revoked' });
    assert.equal((await pending).receipt.decision, 'denied');
    other.setMember({ ...s.actor(), memberId: 'writer', role: 'editor', status: 'active' });
    const raw = { ...s.actor('writer'), approvalId };
    const snap = s.sharing.share(raw); raw.principalId = 'unknown';
    const result = await snap;
    assert.equal(result.receipt.decision, 'allowed');
    const pendingRead = s.sharing.read({ ...s.actor('viewer'), shareId: result.value!.shareId });
    other.configure({ ...s.actor(), enabled: false, grants: s.grants });
    assert.equal((await pendingRead).receipt.decision, 'denied');
  } finally { other?.close(); s.dispose(); }
});
storageTest('fresh originating source change invalidates persisted copy without ingest and never resurrects', async () => {
  const s = setup();
  try {
    const approvalId = s.approve().value!.approvalId;
    const shareId = (await s.sharing.share({ ...s.actor('writer'), approvalId })).value!.shareId;
    const path = join(s.f.root, s.f.path), original = '# Local storage\n\nStatus: Accepted\n\nUse SQLite for durable project memory. FTS5 handles keyword retrieval.\n';
    writeFileSync(path, '# Changed\nStatus: Accepted\nDifferent bytes\n');
    const read = await s.sharing.read({ ...s.actor('viewer'), shareId });
    assert.equal(read.receipt.status, 'source-unavailable');
    writeFileSync(path, original);
    s.reopen();
    assert.equal((await s.sharing.read({ ...s.actor('viewer'), shareId })).receipt.decision, 'denied');
    assert.equal((await s.sharing.share({ ...s.actor('writer'), approvalId })).receipt.decision, 'denied');
  } finally { s.dispose(); }
});
storageTest('source removal and ProjectMemory deletion both deny copies across restart', async () => {
  for (const mode of ['file', 'record']) {
    const s = setup();
    try {
      const approvalId = s.approve().value!.approvalId;
      const shareId = (await s.sharing.share({ ...s.actor('writer'), approvalId })).value!.shareId;
      if (mode === 'file') rmSync(join(s.f.root, s.f.path)); else s.f.memory.remove(s.id, s.id);
      s.reopen();
      assert.equal((await s.sharing.read({ ...s.actor('viewer'), shareId })).receipt.decision, 'denied');
    } finally { s.dispose(); }
  }
});
storageTest('cross-project, same-ID different workspace and substitute source store cannot read/share', async () => {
  const s = setup(), other = fixture(s.f.projectId);
  let cross: LocalOrganizationSharing | undefined, substitute: LocalOrganizationSharing | undefined;
  try {
    const approvalId = s.approve().value!.approvalId;
    const shareId = (await s.sharing.share({ ...s.actor('writer'), approvalId })).value!.shareId;
    cross = new LocalOrganizationSharing(s.directory, other.root, 'team', other.directory);
    assert.equal((await cross.read({ ...s.actor('viewer'), shareId })).receipt.decision, 'denied');
    assert.equal((await cross.share({ ...s.actor('writer'), approvalId })).receipt.decision, 'denied');
    assert.equal((await s.sharing.read({ ...s.actor('viewer'), projectId: 'other', shareId })).receipt.decision, 'denied');
    const fakeDir = join(s.f.base, 'substitute'); mkdirSync(fakeDir, { mode: 0o700 });
    substitute = new LocalOrganizationSharing(s.directory, s.f.root, 'team', fakeDir);
    assert.equal((await substitute.read({ ...s.actor('viewer'), shareId })).receipt.decision, 'denied');
    assert.equal((await s.sharing.read({ ...s.actor('viewer'), shareId })).receipt.decision, 'denied');
  } finally { cross?.close(); substitute?.close(); other.dispose(); s.dispose(); }
});
storageTest('explicit revoke and ACL disable/re-enable do not resurrect copies or approvals', async () => {
  const s = setup();
  try {
    const approvalId = s.approve().value!.approvalId;
    const shareId = (await s.sharing.share({ ...s.actor('writer'), approvalId })).value!.shareId;
    assert.equal(s.sharing.revoke({ ...s.actor('writer'), shareId }).receipt.decision, 'denied');
    assert.equal(s.sharing.revoke({ ...s.actor(), shareId }).receipt.decision, 'allowed');
    assert.equal(s.sharing.revoke({ ...s.actor(), shareId }).receipt.decision, 'allowed');
    s.reopen();
    assert.equal((await s.sharing.share({ ...s.actor('writer'), approvalId })).receipt.decision, 'denied');
    s.configure(false); s.configure(true);
    assert.equal((await s.sharing.share({ ...s.actor('owner'), approvalId })).receipt.decision, 'denied');
    assert.equal((await s.sharing.read({ ...s.actor('viewer'), shareId })).receipt.decision, 'denied');
  } finally { s.dispose(); }
});
storageTest('async inputs reject accessors/proxies without side effects and receipt content leaks', async () => {
  const s = setup();
  try {
    let calls = 0;
    const proxy = new Proxy({}, { ownKeys() { calls++; throw new Error('secret'); } });
    const raw = { ...s.actor() };
    Object.defineProperty(raw, 'shareId', { enumerable: true, get() { calls++; return 'secret'; } });
    for (const result of [await s.sharing.read(raw), await s.sharing.share(proxy)]) {
      assert.equal(result.receipt.status, 'invalid-input');
      assert.ok(!JSON.stringify(result).includes('secret'));
    }
    assert.equal(calls, 0);
  } finally { s.dispose(); }
});

storageTest('staleness observed during a share tombstones prior copies even if source bytes are restored', async () => {
  const s = setup();
  try {
    const approvalId = s.approve().value!.approvalId;
    const shareId = (await s.sharing.share({ ...s.actor('writer'), approvalId })).value!.shareId;
    const path = join(s.f.root, s.f.path);
    writeFileSync(path, '# Changed\nStatus: Accepted\nNew bytes\n');
    assert.equal((await s.sharing.share({ ...s.actor('writer'), approvalId })).receipt.status, 'source-unavailable');
    writeFileSync(path, '# Local storage\n\nStatus: Accepted\n\nUse SQLite for durable project memory. FTS5 handles keyword retrieval.\n');
    s.reopen();
    assert.equal((await s.sharing.read({ ...s.actor('viewer'), shareId })).receipt.decision, 'denied');
  } finally { s.dispose(); }
});
storageTest('expired and superseded source records cannot authorize copies', async () => {
  for (const mode of ['expired', 'superseded']) {
    const s = setup();
    try {
      const approvalId = s.approve().value!.approvalId;
      const shareId = (await s.sharing.share({ ...s.actor('writer'), approvalId })).value!.shareId;
      if (mode === 'superseded') {
        const next = s.f.memory.add({ ...s.f.input('Replacement source-bound decision'), supersedes: s.id });
        s.f.memory.validate(next, next);
      } else {
        // A genuinely time-bound record; avoid sleeping or changing host time.
        const id = s.f.memory.add({ ...s.f.input('Time-bound decision'), expiresAt: Date.now() + 60000 });
        s.f.memory.validate(id, id);
        const inspection = s.sharing.inspectRecord({ ...s.actor(), recordId: id }).value!;
        const approved = s.sharing.approve({ ...s.actor(), recordId: id, recordDigest: id, recordBinding: inspection.recordBinding });
        const copy = (await s.sharing.share({ ...s.actor('writer'), approvalId: approved.value!.approvalId })).value!;
        s.f.setNow(Date.now() + 120000); assert.equal(s.f.memory.get(id), undefined);
        assert.equal((await s.sharing.read({ ...s.actor('viewer'), shareId: copy.shareId })).receipt.decision, 'denied');
        continue;
      }
      assert.equal((await s.sharing.read({ ...s.actor('viewer'), shareId })).receipt.decision, 'denied');
    } finally { s.dispose(); }
  }
});
