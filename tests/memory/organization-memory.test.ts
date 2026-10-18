import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, serialize } from '../../src/context-engine/validation.js';
import { OrganizationMemory, organizationRequirements, validateOrganizationCandidate } from '../../src/memory/organization-memory.js';
import type { OrganizationCandidate, OrganizationOperation } from '../../src/memory/organization-memory.js';

function candidate(): OrganizationCandidate {
  const body = { schemaVersion: 1 as const, candidateId: 'a'.repeat(64), organizationId: 'example-org', kind: 'lesson' as const,
    summary: 'A proposed shared lesson.', applicability: 'Two reviewed projects on the same stack.', exclusions: 'Other versions need separate review.',
    sources: [{ projectId: 'project-a', workspaceIdentity: 'b'.repeat(64), recordId: 'c'.repeat(64), recordDigest: 'c'.repeat(64),
      path: 'docs/adr/storage.md', sourceDigest: 'd'.repeat(64), sourceStatus: 'Accepted' }],
    evidence: [{ evidenceDigest: 'e'.repeat(64), projectId: 'project-a', recordDigest: 'c'.repeat(64), sourceDigest: 'd'.repeat(64), independenceDomain: 'claimed-domain' }],
    provenance: { taskId: 'task-1', packetDigest: 'f'.repeat(64), workflowVersion: 'fixture-v1' }, createdAt: 1000 };
  return { ...body, digest: digest(serialize(body)) };
}
const operations: OrganizationOperation[] = ['write', 'read', 'share', 'promote'];

test('all organization operations remain disabled even for structurally plausible source-bound evidence', () => {
  const org = new OrganizationMemory(), input = candidate();
  assert.deepEqual(validateOrganizationCandidate(input), input);
  assert.equal(org.status().status, 'blocked-policy-unconfigured'); assert.equal(org.status().enabled, false);
  assert.deepEqual(org.status().missing, ['trusted-principal/group-mapping', 'ACL-policy', 'validator/quorum', 'independent-evidence-bindings']);
  assert.equal(organizationRequirements().validatorAndQuorum, 'required-unconfigured');
  for (const operation of operations) {
    const receipt = org[operation](input);
    assert.equal(receipt.decision, 'denied'); assert.equal(receipt.input, 'well-formed-evidence');
    assert.equal(receipt.candidateDigest, input.digest); assert.equal(receipt.trust, 'evidence-only');
    assert.ok(Object.isFrozen(receipt)); assert.ok(Object.isFrozen(receipt.missing));
    const { digest: stored, ...body } = receipt; assert.equal(stored, digest(serialize(body)));
    assert.deepEqual(org[operation](input), receipt);
    assert.equal('capability' in receipt, false); assert.equal('entries' in receipt, false);
  }
});

test('authorized/member/validation-like flags never confer organization authority', () => {
  const org = new OrganizationMemory();
  for (const extra of [{ authorized: true }, { membership: true }, { validated: true }, { quorumMet: true },
    { principalId: 'owner', uid: 1000 }, { scope: 'organization', canPromote: true }]) {
    const forged = { ...candidate(), ...extra };
    assert.throws(() => validateOrganizationCandidate(forged));
    for (const operation of operations) {
      const receipt = org[operation](forged);
      assert.equal(receipt.decision, 'denied'); assert.equal(receipt.status, 'blocked-policy-unconfigured');
      assert.equal(receipt.input, 'malformed'); assert.equal(receipt.candidateDigest, null);
    }
  }
});

test('mismatched project/evidence, altered digest, unsafe path and missing metadata fail conformance and remain denied', () => {
  const org = new OrganizationMemory();
  const mismatch = candidate(); mismatch.evidence[0]!.projectId = 'foreign';
  const changedHash = candidate(); changedHash.evidence[0]!.sourceDigest = '0'.repeat(64);
  const unsafePath = candidate(); unsafePath.sources[0]!.path = '../private';
  const duplicate = candidate(); duplicate.evidence.push({ ...duplicate.evidence[0]! });
  for (const input of [mismatch, changedHash, unsafePath, duplicate, { ...candidate(), digest: '0'.repeat(64) },
    { ...candidate(), provenance: {} }, { ...candidate(), sources: [] }, { ...candidate(), schemaVersion: 2 }]) {
    assert.throws(() => validateOrganizationCandidate(input));
    for (const operation of operations) assert.equal(org[operation](input).decision, 'denied');
  }
});

test('malformed packets/accessors are denied without evaluation or echoing protected input', () => {
  const org = new OrganizationMemory(); let invoked = false;
  const getter = { get authorized() { invoked = true; return true; } };
  const nested = candidate(); Object.defineProperty(nested.sources, '0', { get() { invoked = true; throw new Error('must not execute'); } });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const input of [null, undefined, 'secret-private-token', [], getter, nested, cyclic, { ...candidate(), summary: 'x'.repeat(25000) }]) {
    const receipt = org.promote(input); assert.equal(receipt.decision, 'denied'); assert.equal(receipt.input, 'malformed');
    assert.equal(JSON.stringify(receipt).includes('secret-private-token'), false);
  }
  assert.equal(invoked, false);
});
