import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixture.js';
import { OrganizationRegistry } from '../../src/memory/organization-registry.js';
import { organizationDatabasePath } from '../../src/memory/organization-registry-storage.js';
import { safeOrganizationJSON } from '../../src/memory/organization-registry-contracts.js';

// Guard only cases that construct the POSIX owner-storage fixture.
function storageTest(name: string, run: () => void | Promise<void>): void {
  void test(name, { skip: typeof process.getuid === 'function' ? false : "Organization owner storage requires process.getuid and POSIX UID/mode checks; native Windows/ACL enforcement is deferred" }, run);
}

function setup() {
  const f = fixture(), directory = join(f.base, 'organization');
  const registry = new OrganizationRegistry(directory, f.root, 'team');
  const actor = (principalId = 'owner') => ({ organizationId: 'team', projectId: f.projectId, principalId });
  return { f, directory, registry, actor, dispose() { registry.close(); f.dispose(); } };
}
storageTest('explicit bootstrap, immutable owner and default deny before members/resources', () => {
  const s = setup();
  try {
    assert.equal(s.registry.status(s.actor()).receipt.decision, 'denied');
    assert.equal(s.registry.configure({ ...s.actor(), enabled: true, grants: [] }).receipt.decision, 'denied');
    const boot = s.registry.bootstrap(s.actor());
    assert.equal(boot.receipt.decision, 'allowed');
    assert.deepEqual(s.registry.bootstrap(s.actor()), boot);
    assert.equal(s.registry.bootstrap(s.actor('impostor')).receipt.decision, 'denied');
    assert.equal(s.registry.promote(s.actor()).receipt.decision, 'denied');
    assert.equal(s.registry.setMember({ ...s.actor(), memberId: 'owner', role: 'reader', status: 'revoked' }).receipt.decision, 'denied');
    assert.equal(s.registry.setMember({ ...s.actor(), memberId: 'x', role: 'owner', status: 'active' }).receipt.decision, 'denied');
    assert.equal(s.registry.setMember({ ...s.actor(), memberId: 'reader', role: 'reader', status: 'active' }).receipt.decision, 'allowed');
    assert.equal(s.registry.setMember({ ...s.actor('reader'), memberId: 'reader', role: 'editor', status: 'active' }).receipt.decision, 'denied');
    assert.equal(s.registry.configure({ ...s.actor('reader'), enabled: true, grants: [] }).receipt.decision, 'denied');
  } finally { s.dispose(); }
});
storageTest('membership and resource writes persist; other handles see current owner state', () => {
  const s = setup();
  let other: OrganizationRegistry | undefined;
  try {
    s.registry.bootstrap(s.actor());
    other = new OrganizationRegistry(s.directory, s.f.root, 'team');
    const input = { ...s.actor(), memberId: 'writer', role: 'editor', status: 'active' };
    const result = s.registry.setMember(input);
    assert.equal(result.receipt.decision, 'allowed');
    assert.equal(other.status(s.actor()).receipt.stateDigest, result.receipt.stateDigest);
    assert.equal(other.setMember(input).receipt.revision, result.receipt.revision);
    const config = { ...s.actor(), enabled: true, grants: [{ principalId: 'writer', read: true, share: true }] };
    const configured = other.configure(config);
    assert.equal(configured.receipt.decision, 'allowed');
    assert.equal(s.registry.configure(config).receipt.stateDigest, configured.receipt.stateDigest);
    assert.throws(() => new OrganizationRegistry(s.directory, s.f.root, 'other-org'), /identity mismatch/);
    assert.equal(s.registry.status({ ...s.actor(), organizationId: 'other-org' }).receipt.decision, 'denied');
    assert.equal(s.registry.status({ ...s.actor(), projectId: 'other-project' }).receipt.decision, 'denied');
    assert.equal(s.registry.status(s.actor('unknown')).receipt.decision, 'denied');
  } finally { other?.close(); s.dispose(); }
});
storageTest('strict input snapshots do not run getters or proxy traps and deny extra authority JSON', () => {
  const s = setup();
  try {
    s.registry.bootstrap(s.actor());
    let calls = 0;
    const getter = Object.defineProperty({}, 'principalId', { enumerable: true, get() { calls++; return 'owner'; } });
    const proxy = new Proxy({}, { ownKeys() { calls++; throw new Error('secret'); }, getPrototypeOf() { calls++; return Object.prototype; } });
    for (const raw of [getter, proxy, { ...s.actor(), extra: { owner: true } }, { ...s.actor(), principalId: '../owner' },
      { ...s.actor(), principalId: 'owner\nsecret' }, { ...s.actor(), nested: 'x'.repeat(70000) }]) {
      const result = s.registry.status(raw);
      assert.equal(result.receipt.decision, 'denied');
      assert.equal(result.receipt.status, 'invalid-input');
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024);
      assert.ok(!JSON.stringify(result).includes('secret'));
    }
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    assert.throws(() => safeOrganizationJSON(revoked.proxy));
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    assert.throws(() => safeOrganizationJSON(cycle));
    assert.throws(() => safeOrganizationJSON({ value: Symbol('hidden') }));
    assert.equal(calls, 0);
    assert.equal(s.registry.status(s.actor()).receipt.decision, 'allowed');
  } finally { s.dispose(); }
});
storageTest('owner grants reject unknown labels, duplicate grants, reader write and oversized lists', () => {
  const s = setup();
  try {
    s.registry.bootstrap(s.actor());
    s.registry.setMember({ ...s.actor(), memberId: 'viewer', role: 'reader', status: 'active' });
    const grant = { principalId: 'viewer', read: true, share: false };
    for (const grants of [[{ ...grant, principalId: 'unknown' }], [{ ...grant, share: true }], [grant, grant],
      [{ ...grant, role: 'owner' }], Array.from({ length: 129 }, () => grant)]) {
      assert.equal(s.registry.configure({ ...s.actor(), enabled: true, grants }).receipt.decision, 'denied');
    }
    const db = new DatabaseSync(organizationDatabasePath(s.directory), { readOnly: true });
    try {
      const receipts = db.prepare('SELECT body FROM org_receipts').all();
      assert.equal(receipts.length, 7);
      assert.equal(receipts.filter(row => { const receipt = JSON.parse(row.body as string); return receipt.operation === 'configure' && receipt.decision === 'denied'; }).length, 5);
      for (const row of receipts) assert.equal(JSON.parse(row.body as string).organizationId, 'team');
    } finally { db.close(); }
  } finally { s.dispose(); }
});
storageTest('private storage rejects workspace-local, noncanonical, linked or public owner paths', () => {
  const s = setup();
  try {
    assert.throws(() => new OrganizationRegistry(join(s.f.root, 'org-state'), s.f.root, 'team'), /external/);
    const pub = join(s.f.base, 'public'); mkdirSync(pub, { mode: 0o755 }); chmodSync(pub, 0o755);
    assert.throws(() => new OrganizationRegistry(pub, s.f.root, 'team'), /unsafe/);
    const linked = join(s.f.base, 'linked'); symlinkSync(s.directory, linked);
    assert.throws(() => new OrganizationRegistry(linked, s.f.root, 'team'), /canonical/);
    const dbPath = organizationDatabasePath(s.directory);
    const alias = join(s.f.base, 'database-alias'); linkSync(dbPath, alias);
    assert.throws(() => s.registry.bootstrap(s.actor()), /unsafe/);
  } finally { s.dispose(); }
});
storageTest('database replacement and unexpected schema fail closed on an existing handle', () => {
  const s = setup();
  try {
    s.registry.bootstrap(s.actor());
    const path = organizationDatabasePath(s.directory);
    renameSync(path, path + '.saved'); writeFileSync(path, '', { mode: 0o600 });
    assert.throws(() => s.registry.status(s.actor()), /replaced/);
  } finally { s.dispose(); }
  const t = setup();
  try {
    const db = new DatabaseSync(organizationDatabasePath(t.directory));
    db.exec('CREATE TABLE unexpected (value TEXT)'); db.close();
    assert.throws(() => t.registry.bootstrap(t.actor()), /schema mismatch/);
  } finally { t.dispose(); }
});
storageTest('receipts remain bounded and source scoped under repeated denies', () => {
  const s = setup();
  try {
    for (let i = 0; i < 1005; i++) assert.equal(s.registry.status(s.actor('unknown')).receipt.decision, 'denied');
    const db = new DatabaseSync(organizationDatabasePath(s.directory), { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM org_receipts').get()?.n, 1000); }
    finally { db.close(); }
  } finally { s.dispose(); }
});

storageTest('independent owner processes serialize membership writes without losing updates', async () => {
  const s = setup();
  try {
    s.registry.bootstrap(s.actor());
    const module = new URL('../../src/memory/organization-registry.js', import.meta.url).href;
    const script = 'import {OrganizationRegistry} from ' + JSON.stringify(module) +
      ';const [directory,root,prefix]=process.argv.slice(1);const r=new OrganizationRegistry(directory,root,"team");' +
      'try {for(let i=0;i<12;i++){const result=r.setMember({organizationId:"team",principalId:"owner",projectId:"project-a",memberId:prefix+i,role:"reader",status:"active"});if(result.receipt.decision!=="allowed")throw Error("denied")}}finally{r.close()}';
    const child = (prefix: string) => new Promise<void>((resolve, reject) => {
      const processChild = spawn(process.execPath, ['--input-type=module', '-e', script, s.directory, s.f.root, prefix], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = ''; processChild.stderr.on('data', bytes => { stderr += String(bytes); });
      processChild.on('error', reject);
      processChild.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
    });
    await Promise.all([child('left'), child('right')]);
    const status = s.registry.status(s.actor()).value as { members: { principalId: string }[] };
    assert.equal(status.members.length, 25);
    assert.equal(new Set(status.members.map(member => member.principalId)).size, 25);
  } finally { s.dispose(); }
});
