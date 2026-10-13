import { ChatGPTExecutionLedger,ChatGPTRefreshDeferred } from '../../src/live-workflow/chatgpt-execution-ledger.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGPTStore } from '../../src/live-workflow/chatgpt-store.js';
import { openChatGPTPlanSession } from '../../src/live-workflow/chatgpt-plan.js';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { RunAuthority } from '../../src/live-workflow/authority.js';
import { sourceIdentity } from '../../src/live-workflow/repository.js';
import { NativeCodexModel } from '../../src/live-workflow/provider.js';
import type { LiveTask } from '../../src/live-workflow/contracts.js';
import { createChatGPTRefresh } from '../../src/live-workflow/chatgpt-refresh.js';
import { createChatGPTAuth } from '../../src/live-workflow/chatgpt-auth.js';
import { openAIIdentity } from '../../src/live-workflow/chatgpt-oidc.js';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'refresh-test', alg: 'RS256', use: 'sig' };
function jwt(patch: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: key.kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: openAIIdentity.issuer, sub: 'subject', aud: 'oaiapp_fixture',
    iat: now - 10, exp: now + 3600, nonce: 'original-nonce', auth_time: now - 100,
    email: 'owner@example.invalid', email_verified: true, ...patch })).toString('base64url');
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), pair.privateKey).toString('base64url')}`;
}
function fixture(lifetime = 1000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-refresh-'))), directory = join(root, 'account');
  const store = new ChatGPTStore(directory, process.cwd(), true);
  try {
    store.lock(); store.save({ schemaVersion: 1, hostId: store.getHostId(), clientId: 'oaiapp_fixture', subject: 'subject',
      accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: jwt(),
      scope: 'openid email chatgpt.tokens.use.direct', expiresAt: Date.now() + lifetime, email: 'owner@example.invalid' });
    store.confirmBillingReview(store.connection()!);
  } finally { store.close(); }
  return { root, directory, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function saved(directory: string) { return JSON.parse(readFileSync(join(directory, 'chatgpt-connection.json'), 'utf8')); }
const terminal = { isTTY: true, confirm: async () => { throw Error('Unexpected repeated billing prompt'); } };
function good(patch: Record<string, unknown> = {}) { return { access_token: 'new-access', refresh_token: 'new-refresh',
  token_type: 'Bearer', scope: 'email chatgpt.tokens.use.direct openid', expires_in: 3600, ...patch }; }

test('expired owner connection renews once before opening a plan session without repeating billing review', async t => {
  const f = fixture();
  try {
    const before = saved(f.directory), review = readFileSync(join(f.directory, 'chatgpt-billing-review.json'), 'utf8');
    writeFileSync(join(f.directory, 'chatgpt-connection.json'), JSON.stringify({ ...before, expiresAt: Date.now() - 1 }));
    let posts = 0;
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, openAIIdentity.token); assert.equal(init?.redirect, 'manual');
      assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init?.body))), {
        grant_type: 'refresh_token', client_id: before.clientId, refresh_token: before.refreshToken, resource: openAIIdentity.resource });
      assert.ok(existsSync(join(f.directory, 'chatgpt-refresh-pending.json'))); posts++; return Response.json(good());
    });
    const session = await openChatGPTPlanSession(f.directory, terminal);
    session.assertActive(); assert.equal(posts, 1); assert.equal(saved(f.directory).refreshToken, 'new-refresh');
    assert.equal(saved(f.directory).idToken, before.idToken);
    assert.equal(readFileSync(join(f.directory, 'chatgpt-billing-review.json'), 'utf8'), review);
    assert.equal(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')), false);
  } finally { f.cleanup(); }
});

function mutate(directory: string, patch: Record<string, unknown>) {
  writeFileSync(join(directory, 'chatgpt-connection.json'), JSON.stringify({ ...saved(directory), ...patch }));
}
function payloadClaims(token: string) { return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')); }

test('pre-inference preparation adopts its own refresh and retains original identity across consecutive rotations', async t => {
  const f = fixture(60000);
  try {
    const session = await openChatGPTPlanSession(f.directory, terminal), original = saved(f.directory);
    let posts = 0;
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      if (url === openAIIdentity.jwks) return Response.json({ keys: [key] });
      assert.equal(url, openAIIdentity.token); posts++;
      return Response.json(good({ expires_in: posts === 1 ? 120 : 3600,
        access_token: `new-access-${posts}`, refresh_token: `new-refresh-${posts}`,
        id_token: jwt({ auth_time: payloadClaims(original.idToken).auth_time, nonce: posts === 1 ? undefined : 'original-nonce' }) }));
    });
    await session.prepare(90000, new AbortController().signal); session.assertActive();
    await session.prepare(180000, new AbortController().signal); session.assertActive();
    assert.equal(posts, 2); assert.equal(saved(f.directory).idToken, original.idToken);
    assert.equal(saved(f.directory).accessToken, 'new-access-2');
  } finally { f.cleanup(); }
});

test('expired retained ID token does not shorten freshly granted access when refresh omits ID', async () => {
  const f = fixture();
  try {
    mutate(f.directory, { idToken: jwt({ exp: Math.floor(Date.now() / 1000) - 1, iat: Math.floor(Date.now() / 1000) - 100 }) });
    const ensure = createChatGPTRefresh({ transport: async () => Response.json(good()) });
    const next = await ensure(f.directory, { minimumLifetimeMs: 5000 });
    assert.ok(next.expiresAt > Date.now() + 3500000);
  } finally { f.cleanup(); }
});

for (const patch of [
  { scope: 'openid email chatgpt.tokens.use.direct added' }, { scope: 'openid chatgpt.tokens.use.direct' },
  { refresh_token: undefined }, { token_type: 'bad' }, { expires_in: 0 }, { expires_in: 1 },
  { access_token: 'bad\nvalue' }, { id_token: 'bad.token.signature' },
]) test('invalid refresh grants fail closed with durable marker and no replay', async () => {
  const f = fixture(); let posts = 0;
  try {
    const before = saved(f.directory);
    const ensure = createChatGPTRefresh({ transport: async () => { posts++; return Response.json(good(patch)); } });
    await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000 }));
    assert.deepEqual(saved(f.directory), before); assert.ok(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')));
    await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000 }), /indeterminate/); assert.equal(posts, 1);
  } finally { f.cleanup(); }
});

for (const patch of [{ sub: 'another' }, { aud: 'another' }, { aud: ['oaiapp_fixture', 'extra'], azp: 'oaiapp_fixture' },
  { nonce: 'wrong' }, { auth_time: 0 }, { email: 'another@example.invalid' }, { exp: 1 }, { iss: 'https://attacker.invalid' }]) {
  test('signed refresh ID cannot transfer identity, audience, nonce or authenticated time', async () => {
    const f = fixture();
    try {
      const before = saved(f.directory);
      const ensure = createChatGPTRefresh({ transport: async url => url === openAIIdentity.jwks
        ? Response.json({ keys: [key] }) : Response.json(good({ id_token: jwt(patch) })) });
      await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000 }), /validation failed/);
      assert.deepEqual(saved(f.directory), before);
    } finally { f.cleanup(); }
  });
}

for (const failure of ['network', 'unknown-http', 'invalid-client', 'oversized']) {
  test(`uncertain renewal ${failure} preserves credentials but never reuses pending token`, async () => {
    const f = fixture(); let posts = 0;
    try {
      const before = saved(f.directory);
      const ensure = createChatGPTRefresh({ transport: async () => {
        posts++;
        if (failure === 'network') throw Error('synthetic-secret-do-not-print');
        if (failure === 'oversized') return new Response('x'.repeat(131073));
        return Response.json({ error: failure === 'invalid-client' ? 'invalid_client' : 'unknown', error_description: 'synthetic-secret-do-not-print' }, { status: 400 });
      } });
      await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000 }), error => {
        assert.doesNotMatch(String(error), /synthetic-secret/); return true;
      });
      assert.deepEqual(saved(f.directory), before);
      await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000 }), /indeterminate/); assert.equal(posts, 1);
      await assert.rejects(openChatGPTPlanSession(f.directory, terminal), /indeterminate/);
    } finally { f.cleanup(); }
  });
}

test('terminal rejection clears unusable tokens but preserves issued registration for explicit reconnect', async () => {
  const f = fixture();
  try {
    const before = saved(f.directory);
    const ensure = createChatGPTRefresh({ transport: async () => Response.json({ error: 'refresh_token_reused' }, { status: 400 }) });
    await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000 }), /rejected/);
    assert.equal(existsSync(join(f.directory, 'chatgpt-connection.json')), false);
    assert.equal(existsSync(join(f.directory, 'chatgpt-billing-review.json')), false);
    const registration = readFileSync(join(f.directory, 'chatgpt-registration.json'), 'utf8');
    assert.equal(JSON.parse(registration).clientId, before.clientId); assert.doesNotMatch(registration, /synthetic-access|synthetic-refresh/);
    let client = '', nonce = '';
    const auth = createChatGPTAuth({ transport: async url => {
      if (url === openAIIdentity.discovery) return Response.json({ issuer: openAIIdentity.issuer, authorization_endpoint: openAIIdentity.authorization,
        token_endpoint: openAIIdentity.token, jwks_uri: openAIIdentity.jwks });
      if (url === openAIIdentity.jwks) return Response.json({ keys: [key] });
      return Response.json(good({ id_token: jwt({ nonce }) }));
    } });
    await auth.connectChatGPT({ directory: f.directory, onAuthorize: async value => {
      const url = new URL(value); client = url.searchParams.get('client_id')!; nonce = url.searchParams.get('nonce')!;
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')! }).toString();
      const response = await fetch(callback); assert.equal(response.status, 200);
    } });
    assert.equal(client, before.clientId); assert.equal(saved(f.directory).clientId, client);
    assert.equal(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')), false);
  } finally { f.cleanup(); }
});

for (const race of ['credentials', 'review', 'disconnect']) {
  test(`renewal cannot overwrite concurrent ${race} changes`, async () => {
    const f = fixture();
    try {
      const ensure = createChatGPTRefresh({ transport: async () => {
        if (race === 'credentials') mutate(f.directory, { accessToken: 'owner-reconnected' });
        else if (race === 'disconnect') unlinkSync(join(f.directory, 'chatgpt-connection.json'));
        else { const s = new ChatGPTStore(f.directory); try { s.lock(); s.forgetBillingReview(); } finally { s.close(); } }
        return Response.json(good());
      } });
      await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000 }), /changed/);
      if (race === 'credentials') assert.equal(saved(f.directory).accessToken, 'owner-reconnected');
      assert.ok(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')));
    } finally { f.cleanup(); }
  });
}

test('concurrent renewal fails closed and posts a rotating token only once', async () => {
  const f = fixture(); let resolve!: (value: Response) => void, started!: () => void, posts = 0;
  const seen = new Promise<void>(yes => { started = yes; });
  try {
    const ensure = createChatGPTRefresh({ transport: async () => { posts++; started(); return new Promise<Response>(yes => { resolve = yes; }); } });
    const first = ensure(f.directory, { minimumLifetimeMs: 5000 }); await seen;
    await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000 }), /indeterminate|locked/);
    resolve(Response.json(good())); await first; assert.equal(posts, 1);
  } finally { f.cleanup(); }
});

test('cancellation of non-cooperative transport preserves ambiguity and cannot commit late response', async () => {
  const f = fixture(); const controller = new AbortController(); let resolve!: (r: Response) => void;
  try {
    const before = saved(f.directory);
    const ensure = createChatGPTRefresh({ transport: async () => new Promise<Response>(yes => { resolve = yes; }) });
    const pending = ensure(f.directory, { minimumLifetimeMs: 5000, signal: controller.signal });
    controller.abort(); await assert.rejects(pending, /cancelled/);
    resolve(Response.json(good())); await new Promise(yes => setImmediate(yes));
    assert.deepEqual(saved(f.directory), before); assert.ok(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')));
  } finally { f.cleanup(); }
});

test('already cancelled and sufficient-lifetime connections never dispatch renewal', async () => {
  const f = fixture(3600000); let posts = 0;
  try {
    const ensure = createChatGPTRefresh({ transport: async () => { posts++; return Response.json(good()); } });
    assert.deepEqual(await ensure(f.directory, { minimumLifetimeMs: 10000 }), saved(f.directory));
    await assert.rejects(ensure(f.directory, { signal: AbortSignal.abort() })); assert.equal(posts, 0);
  } finally { f.cleanup(); }
});

test('lost rotation-lock ownership prevents candidate persistence', async () => {
  const f = fixture();
  try {
    const before = saved(f.directory);
    const ensure = createChatGPTRefresh({ transport: async () => {
      const path = join(f.directory, 'chatgpt-refresh.lock'); renameSync(path, path + '.displaced'); writeFileSync(path, 'replacement', { mode: 0o600 });
      return Response.json(good());
    } });
    await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000 }), /ownership changed/);
    assert.deepEqual(saved(f.directory), before); assert.ok(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')));
    assert.equal(readFileSync(join(f.directory, 'chatgpt-refresh.lock'), 'utf8'), 'replacement');
  } finally { f.cleanup(); }
});

test('Native adapter prepares fresh lifetime before executable launch or inference budget reservation', async t => {
  const f = fixture(); let authority: RunAuthority | undefined;
  try {
    const session = await openChatGPTPlanSession(f.directory, terminal);
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      assert.equal(url, openAIIdentity.token); return Response.json(good());
    });
    const task: LiveTask = { schemaVersion: 1, taskId: 'refresh-native-fixture', objective: 'test', readPaths: [], writePaths: [], checks: [],
      model: 'fixture', effort: 'low', maxModelRequests: 1, maxPromptBytes: 1000, maxOutputBytes: 1000, maxRuntimeMs: 5000, draftPr: false };
    const source = sourceIdentity(process.cwd());
    authority = new RunAuthority(join(f.root, 'native-policy'), process.cwd(), 'fixture', task, source);
    const model = new NativeCodexModel({ executable: join(f.root, 'does-not-exist'), task, authority, source: () => source, planSession: session });
    await assert.rejects(model.complete('', {}, {}, new AbortController().signal), /ENOENT/);
    assert.equal(saved(f.directory).accessToken, 'new-access'); session.assertActive();
    assert.equal((authority.export() as { run: { requests: number } }).run.requests, 0);
  } finally { authority?.close(); f.cleanup(); }
});

test('caller grant denial after dispatch cannot persist a renewal or extend task authority', async () => {
  const f = fixture(); let active = true;
  try {
    const before = saved(f.directory);
    const ensure = createChatGPTRefresh({ transport: async () => { active = false; return Response.json(good()); } });
    await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000, check: () => { if (!active) throw Error('inactive caller grant'); } }));
    assert.deepEqual(saved(f.directory), before); assert.ok(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')));
  } finally { f.cleanup(); }
});

test('external same-account reconnect cannot be adopted by prepare', async () => {
  const f = fixture(60000);
  try {
    const session = await openChatGPTPlanSession(f.directory, terminal);
    mutate(f.directory, { accessToken: 'outside-session' });
    await assert.rejects(session.prepare(1000, new AbortController().signal), /changed/);
    assert.equal(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')), false);
  } finally { f.cleanup(); }
});

test('OAuth receipts disclose no access, refresh or ID token values', async () => {
  const f = fixture();
  try {
    const before = saved(f.directory);
    await createChatGPTRefresh({ transport: async () => Response.json(good()) })(f.directory, { minimumLifetimeMs: 5000 });
    const entry = readdirSync(f.directory).find(name => name.startsWith('oauth-refresh-'))!;
    const db = new DatabaseSync(join(f.directory, entry, 'run.sqlite'));
    try {
      const persisted = JSON.stringify({ run: db.prepare('SELECT * FROM run').all(), phases: db.prepare('SELECT * FROM phases').all() });
      assert.doesNotMatch(persisted, /synthetic-access|synthetic-refresh|new-access|new-refresh/);
      assert.ok(!persisted.includes(before.idToken));
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test('owner refresh works outside a Git working directory using the compiled runtime source', async () => {
  const f = fixture(); const cwd = process.cwd();
  try {
    process.chdir(f.root);
    const next = await createChatGPTRefresh({ transport: async () => Response.json(good()) })(f.directory, { minimumLifetimeMs: 5000 });
    assert.equal(next.accessToken, 'new-access');
  } finally { process.chdir(cwd); f.cleanup(); }
});

test('runtime source drift after dispatch denies persistence under a stale source receipt', async () => {
  const f = fixture(); const project = join(f.root, 'project');
  try {
    mkdirSync(project); execFileSync('git', ['init', '-q', project]);
    writeFileSync(join(project, 'source.txt'), 'before'); execFileSync('git', ['-C', project, 'add', 'source.txt']);
    execFileSync('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture']);
    const before = saved(f.directory);
    const ensure = createChatGPTRefresh({ projectRoot: project, transport: async () => {
      writeFileSync(join(project, 'source.txt'), 'after'); return Response.json(good());
    } });
    await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000 }), /source changed/);
    assert.deepEqual(saved(f.directory), before); assert.ok(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')));
  } finally { f.cleanup(); }
});

test('longest allowed task lifetime includes a thirty-second credential buffer', async () => {
  const f = fixture();
  try {
    const next = await createChatGPTRefresh({ transport: async () => Response.json(good()) })(f.directory, { minimumLifetimeMs: 930000 });
    assert.ok(next.expiresAt - Date.now() > 930000);
  } finally { f.cleanup(); }
});

test('synchronous preparation consumes the same absolute renewal deadline even before abort timer fires', async t => {
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  const f = fixture(); let firstCheck = true, observedAbort = true;
  try {
    const before = saved(f.directory);
    const ensure = createChatGPTRefresh({ transport: async (_url, init) => {
      t.mock.timers.setTime(now + 35000); observedAbort = init.signal!.aborted; return Response.json(good());
    } });
    await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000, check: () => {
      if (firstCheck) { firstCheck = false; t.mock.timers.setTime(now + 10000); }
    } }), /deadline exhausted/);
    assert.equal(observedAbort, false); assert.deepEqual(saved(f.directory), before);
    assert.ok(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')));
  } finally { f.cleanup(); }
});

test('slow durable marker persistence cannot dispatch OAuth after the absolute deadline', async t => {
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  const f = fixture(); let posts = 0;
  try {
    const before = saved(f.directory), original = ChatGPTStore.prototype.beginRefresh;
    t.mock.method(ChatGPTStore.prototype, 'beginRefresh', function(this: ChatGPTStore, c: Parameters<ChatGPTStore['beginRefresh']>[0]) {
      original.call(this, c); t.mock.timers.setTime(now + 30001);
    });
    const ensure = createChatGPTRefresh({ transport: async () => { posts++; return Response.json(good()); } });
    await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000 }), /deadline exhausted/);
    assert.equal(posts, 0); assert.deepEqual(saved(f.directory), before);
    assert.ok(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')));
  } finally { f.cleanup(); }
});

test('slow caller grant check cannot conceal an expired renewal window', async t => {
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  const f = fixture(); let posts = 0;
  try {
    const ensure = createChatGPTRefresh({ transport: async () => { posts++; return Response.json(good()); } });
    await assert.rejects(ensure(f.directory, { minimumLifetimeMs: 5000, check: () => t.mock.timers.setTime(now + 30001) }), /deadline exhausted/);
    assert.equal(posts, 0); assert.equal(existsSync(join(f.directory, 'chatgpt-refresh-pending.json')), false);
  } finally { f.cleanup(); }
});


async function verifiedReconnect(directory:string,during?:()=>void):Promise<void>{
  let nonce='';const auth=createChatGPTAuth({transport:async url=>{
    if(url===openAIIdentity.discovery)return Response.json({issuer:openAIIdentity.issuer,authorization_endpoint:openAIIdentity.authorization,token_endpoint:openAIIdentity.token,jwks_uri:openAIIdentity.jwks});
    if(url===openAIIdentity.jwks)return Response.json({keys:[key]});
    assert.equal(url,openAIIdentity.token);return Response.json({...good(),access_token:'reconnected-access',refresh_token:'reconnected-refresh',id_token:jwt({nonce})});
  }});
  await auth.connectChatGPT({directory,timeoutMs:3000,onAuthorize:async raw=>{
    const url=new URL(raw);nonce=url.searchParams.get('nonce')!;during?.();
    const callback=new URL(url.searchParams.get('redirect_uri')!);callback.search=new URLSearchParams({state:url.searchParams.get('state')!,code:'synthetic-code',client_id:'oaiapp_fixture'}).toString();
    await (await fetch(callback)).text();
  }});
}
test('verified reconnect recovers post-save failure, partial invalidation and intent-only states without refresh replay',async t=>{
  for(const mode of ['post-save','partial-invalidation','intent-only','absent-intent-only']){
    const f=fixture();let posts=0;
    try{
      const save=ChatGPTStore.prototype.save,forget=ChatGPTStore.prototype.forgetBillingReview;
      const fault=t.mock.method(ChatGPTStore.prototype,mode==='partial-invalidation'?'forgetBillingReview':'save',function(this:ChatGPTStore,value?:Parameters<typeof save>[0]){
        if(mode==='partial-invalidation'){forget.call(this);throw new Error('Injected after connection removal');}
        save.call(this,value!);throw new Error('Injected after credential save');
      });
      const ensure=createChatGPTRefresh({transport:async()=>{posts++;return mode==='partial-invalidation'?Response.json({error:'invalid_grant'},{status:400}):Response.json(good());}});
      await assert.rejects(ensure(f.directory,{minimumLifetimeMs:5000}));fault.mock.restore();
      assert.equal(posts,1);assert.equal(existsSync(join(f.directory,'chatgpt-refresh-pending.json')),true);
      if(mode!=='partial-invalidation')assert.equal(saved(f.directory).accessToken,'new-access');
      if(mode==='intent-only'||mode==='absent-intent-only'){
        unlinkSync(join(f.directory,'chatgpt-refresh-pending.json'));
        if(mode==='absent-intent-only')unlinkSync(join(f.directory,'chatgpt-connection.json'));
      }
      await verifiedReconnect(f.directory);assert.equal(posts,1);assert.equal(saved(f.directory).accessToken,'reconnected-access');
      assert.equal(existsSync(join(f.directory,'chatgpt-refresh-pending.json')),false);
      const ledger=new ChatGPTExecutionLedger(f.directory);try{assert.equal(ledger.refreshIntent(),null);}finally{ledger.close();}
      const store=new ChatGPTStore(f.directory);try{store.lock();if(!store.billingReview(store.connection()!))store.confirmBillingReview(store.connection()!);}finally{store.close();}
      const session=await openChatGPTPlanSession(f.directory,terminal),lease=session.admitExecution({runBinding:'a'.repeat(64),deadline:Date.now()+1000,signal:new AbortController().signal,check:()=>{}});lease.settle('failed',null);
    }finally{f.cleanup();}
  }
});
test('explicit reconnect preserves unresolved execution leases and old sessions remain invalid',async()=>{
  const f=fixture(60000),old=await openChatGPTPlanSession(f.directory,terminal),lease=old.admitExecution({runBinding:'a'.repeat(64),deadline:Date.now()+10000,signal:new AbortController().signal,check:()=>{}});
  const id=lease.receipt().id;
  try{
    await verifiedReconnect(f.directory);assert.throws(()=>old.assertActive(),/changed/);
    const ledger=new ChatGPTExecutionLedger(f.directory);try{assert.equal(ledger.row(id).status,'revoked');assert.throws(()=>ledger.beginRefresh('a'.repeat(64),()=>{}),ChatGPTRefreshDeferred);}finally{ledger.close();}
    lease.settle('failed',null);
  }finally{f.cleanup();}
});
