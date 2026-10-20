import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, OrganizationDenied, projectKey, safeOrganizationJSON, validateState } from '../../src/memory/organization-registry-contracts.js';
import type { LocalOrganizationState } from '../../src/memory/organization-registry-contracts.js';

// These contracts exercise no owner storage and must run even without POSIX UID identity.
function bootstrapped(): LocalOrganizationState {
  const state = initialState('team');
  state.ownerId = 'owner';
  state.members.push({ principalId: 'owner', role: 'owner', status: 'active', epoch: 1 });
  return state;
}
function invalidJSON(value: unknown): void {
  assert.throws(() => safeOrganizationJSON(value), (error: unknown) =>
    error instanceof OrganizationDenied && error.status === 'invalid-input');
}

test('portable safe JSON rejects proxies and accessors without invoking traps, getters or toJSON', () => {
  let calls = 0;
  const trap = () => { calls++; throw new Error('private trap text'); };
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  const getter = Object.defineProperty({}, 'principalId', { enumerable: true, get: trap });
  const setter = Object.defineProperty({}, 'principalId', { enumerable: true, set: trap });
  const indexedGetter = Object.defineProperty([0], '0', { enumerable: true, get: trap });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const raw of [proxy, { nested: proxy }, getter, setter, indexedGetter, revoked.proxy,
    { toJSON() { calls++; return { role: 'owner' }; } }]) invalidJSON(raw);
  assert.equal(calls, 0);
});

test('portable safe JSON produces a detached deeply frozen data snapshot', () => {
  const raw = { principalId: 'owner', grants: [{ principalId: 'reader', read: true, share: false }] };
  const snapshot = safeOrganizationJSON(raw);
  assert.deepEqual(snapshot, raw);
  assert.notEqual(snapshot, raw); assert.notEqual(snapshot.grants, raw.grants);
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.grants));
  assert.ok(Object.isFrozen(snapshot.grants[0]));
  raw.principalId = 'changed'; raw.grants[0]!.read = false;
  assert.equal(snapshot.principalId, 'owner'); assert.equal(snapshot.grants[0]!.read, true);
  assert.throws(() => { snapshot.grants[0]!.read = false; }, TypeError);
  assert.equal(safeOrganizationJSON(null), null);
});

test('portable safe JSON rejects malformed data and enforces traversal and byte budgets', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  let deep: unknown = null;
  for (let i = 0; i < 12; i++) deep = { nested: deep };
  const symbols = { [Symbol('hidden')]: 'authority' };
  const hidden = Object.defineProperty({}, 'owner', { value: true });
  for (const raw of [cycle, symbols, hidden, new Date(), new Map(), Object.create({ owner: true }),
    { value: undefined }, { value: Symbol('owner') }, { value: 1n }, { value: NaN }, { value: Infinity },
    { value: 'x'.repeat(65537) }, deep, Array(2), Array.from({ length: 1025 }, () => 0),
    Array.from({ length: 5 }, () => Array.from({ length: 850 }, () => 0))]) invalidJSON(raw);
});

test('portable authority state accepts only explicit bootstrap and returns detached state', () => {
  assert.deepEqual(validateState(initialState('team'), 'team'), initialState('team'));
  const raw = bootstrapped(), checked = validateState(raw, 'team');
  assert.deepEqual(checked, raw); assert.notEqual(checked.members[0], raw.members[0]);
  checked.members[0]!.status = 'revoked';
  assert.equal(raw.members[0]!.status, 'active');
});

test('portable authority state rejects forged owners, roles, epochs and extra authority fields', () => {
  const changes: ((state: LocalOrganizationState) => void)[] = [
    state => { state.ownerId = null; },
    state => { state.ownerId = 'impostor'; },
    state => { state.members[0]!.status = 'suspended'; },
    state => { state.members[0]!.role = 'reader'; },
    state => { state.members[0]!.epoch = 0; },
    state => { state.members.push({ principalId: 'other', role: 'owner', status: 'active', epoch: 1 }); },
    state => { state.members.push({ ...state.members[0]! }); },
    state => { Object.assign(state, { authorized: true }); }
  ];
  for (const change of changes) {
    const state = bootstrapped(); change(state);
    assert.throws(() => validateState(state, 'team'));
  }
  assert.throws(() => validateState(bootstrapped(), 'other-team'), /identity mismatch/);
});

test('portable resource authority binds exact root, project, known grants and approval state', () => {
  const root = '/portable/workspace', key = projectKey(root, 'project-a');
  assert.notEqual(key, projectKey('/portable/clone', 'project-a'));
  assert.notEqual(key, projectKey(root, 'project-b'));
  const state = bootstrapped();
  state.resources.push({ key, workspaceRoot: root, projectId: 'project-a', enabled: true,
    grants: [{ principalId: 'owner', read: true, share: true }], epoch: 1 });
  assert.deepEqual(validateState(state, 'team'), state);
  const changes: ((value: LocalOrganizationState) => void)[] = [
    value => { value.resources[0]!.workspaceRoot = '/portable/clone'; },
    value => { value.resources[0]!.projectId = 'project-b'; },
    value => { value.resources[0]!.grants[0]!.principalId = 'unknown'; },
    value => { value.resources[0]!.grants.push({ ...value.resources[0]!.grants[0]! }); },
    value => { value.approvals.push({ id: 'a'.repeat(64), projectKey: key, resourceEpoch: 1,
      sourceDirectory: '/portable/source', recordId: 'b'.repeat(64), recordDigest: 'b'.repeat(64), recordBinding: 'c'.repeat(64) }); }
  ];
  for (const change of changes) {
    const value = structuredClone(state); change(value);
    assert.throws(() => validateState(value, 'team'));
  }
});

test('organization storage fails closed with actual UID absence before creating its database', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'forgemind-organization-no-uid-')));
  try {
    const workspace = join(base, 'workspace'), directory = join(base, 'organization');
    mkdirSync(workspace); mkdirSync(directory, { mode: 0o700 });
    const module = new URL('../../src/memory/organization-registry-storage.js', import.meta.url).href;
    // Isolate process identity mutation from the test runner and all other storage tests.
    // On Windows this asserts the existing absence; on POSIX it actually removes getuid.
    const script = `
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { OrganizationRegistryStorage, organizationDatabasePath } from ${JSON.stringify(module)};
      const [directory, workspace] = process.argv.slice(1);
      Object.defineProperty(process, 'getuid', { configurable: true, writable: true, value: undefined });
      assert.equal(typeof process.getuid, 'undefined');
      assert.throws(() => OrganizationRegistryStorage.open(directory, workspace, 'team'),
        { message: 'unsafe organization owner storage' });
      assert.equal(existsSync(organizationDatabasePath(directory)), false);
      assert.equal(existsSync(join(directory, 'organization-v1')), false);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, directory, workspace],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
