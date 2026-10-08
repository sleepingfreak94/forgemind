import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer, request } from 'node:http';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chatGPTStatus, connectChatGPT, createChatGPTAuth, loadChatGPTConnection } from '../../src/live-workflow/chatgpt-auth.js';
import type { ChatGPTConnectOptions, ChatGPTConnection } from '../../src/live-workflow/chatgpt-auth.js';
import { openAIIdentity } from '../../src/live-workflow/chatgpt-oidc.js';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const file = 'chatgpt-connection.json';
interface Changes {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  tokens?: Record<string, unknown>;
  discovery?: Record<string, unknown>;
  keys?: unknown[];
  wrongSignature?: boolean;
  status?: number;
  oversized?: boolean;
}
async function fixture(changes: Changes = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-chatgpt-')));
  const directory = join(root, 'state');
  const urls: URL[] = [];
  const requests: string[] = [];
  let tokens = 0;
  const server = createServer(async (req, res) => {
    requests.push(req.url!);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === new URL(openAIIdentity.discovery).pathname) {
      res.end(JSON.stringify({ issuer: openAIIdentity.issuer, authorization_endpoint: openAIIdentity.authorization,
        token_endpoint: openAIIdentity.token, jwks_uri: openAIIdentity.jwks, ...changes.discovery }));
    } else if (req.url === new URL(openAIIdentity.jwks).pathname) {
      res.end(JSON.stringify({ keys: changes.keys ?? [jwk] }));
    } else if (req.url === new URL(openAIIdentity.token).pathname) {
      tokens++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const auth = urls.at(-1)!;
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), 'oaiapp_fixture');
      assert.equal(form.get('resource'), openAIIdentity.resource);
      assert.equal(form.get('redirect_uri'), auth.searchParams.get('redirect_uri'));
      assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), auth.searchParams.get('code_challenge'));
      assert.equal(form.has('client_secret'), false);
      if (changes.status) { res.writeHead(changes.status, { Location: '/stolen' }).end('secret-access-token'); return; }
      if (changes.oversized) { res.end('x'.repeat(131073)); return; }
      const now = Math.floor(Date.now() / 1000);
      const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture', ...changes.header })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ iss: openAIIdentity.issuer, aud: 'oaiapp_fixture',
        sub: 'subject-fixture', nonce: auth.searchParams.get('nonce'), iat: now, exp: now + 3600,
        email: 'fixture@example.test', email_verified: true, ...changes.claims })).toString('base64url');
      const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), changes.wrongSignature ? other.privateKey : pair.privateKey).toString('base64url');
      res.end(JSON.stringify({ access_token: 'secret-access-token', refresh_token: 'secret-refresh-token',
        id_token: `${head}.${body}.${signature}`, token_type: 'Bearer', scope, expires_in: 3600, ...changes.tokens }));
    } else res.writeHead(500).end('unexpected request');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const auth = createChatGPTAuth({ transport: async (url, init) => {
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(new URL(url).origin, openAIIdentity.issuer);
    return fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init);
  } });
  const callback = async (url: URL, extra: Record<string, string> = {}, mutate?: (u: URL) => void): Promise<Response> => {
    const target = new URL(url.searchParams.get('redirect_uri')!);
    target.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'fixture-code', client_id: 'oaiapp_fixture', ...extra }).toString();
    mutate?.(target);
    return fetch(target);
  };
  const connect = async (onAuthorize?: (url: URL) => Promise<void>, options: Partial<ChatGPTConnectOptions> = {}) => auth.connectChatGPT({
    directory, timeoutMs: 3000,
    onAuthorize: async raw => { const url = new URL(raw); urls.push(url); if (onAuthorize) await onAuthorize(url); else { const r = await callback(url); await r.text(); } },
    ...options,
  });
  return { root, directory, changes, urls, requests, callback, connect, tokens: () => tokens,
    cleanup: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); } };
}
async function rejectsSafely(work: Promise<unknown>): Promise<void> {
  await assert.rejects(work, (e: Error) => {
    assert.match(e.message, /^ChatGPT connection:/);
    assert.doesNotMatch(e.message, /secret-|fixture-code|eyJ|Bearer/);
    return true;
  });
}
function changeStored(directory: string, patch: Record<string, unknown>): void {
  const path = join(directory, file);
  const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...data, ...patch }));
}

test('public contract, pre-listener, pinned dynamic OAuth, offline load, redacted status and protected own store', async () => {
  assert.equal(typeof connectChatGPT, 'function');
  const f = await fixture();
  try {
    const result = await f.connect(async url => {
      assert.equal(url.origin + url.pathname, openAIIdentity.authorization);
      assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
      assert.equal(url.searchParams.get('agent_name_hint'), 'ForgeMind');
      assert.equal(url.searchParams.get('resource'), openAIIdentity.resource);
      assert.equal(url.searchParams.get('scope'), scope);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.match(url.searchParams.get('state')!, /^[\w-]{43}$/);
      assert.notEqual(url.searchParams.get('state'), url.searchParams.get('nonce'));
      const redirect = new URL(url.searchParams.get('redirect_uri')!);
      assert.equal(redirect.hostname, '127.0.0.1');
      assert.equal(redirect.pathname, '/auth/callback');
      const host = JSON.parse(readFileSync(join(f.directory, 'chatgpt-host.json'), 'utf8')) as { hostId: string };
      assert.equal(url.searchParams.get('ext_agent_host_id'), host.hostId);
      assert.equal(statSync(join(f.directory, 'chatgpt.lock')).mode & 0o777, 0o600);
      const response = await f.callback(url);
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), /fixture-code|secret-/);
    });
    assert.deepEqual(Object.keys(result).sort(), ['clientId', 'expiresAt', 'planUsageEnabled', 'subject']);
    assert.equal(result.planUsageEnabled, true);
    assert.ok(result.expiresAt > Date.now() && result.expiresAt < Date.now() + 3600001);
    const saved: ChatGPTConnection = loadChatGPTConnection(f.directory);
    assert.equal(saved.accessToken, 'secret-access-token');
    assert.equal(saved.clientId, 'oaiapp_fixture');
    assert.equal(saved.subject, 'subject-fixture');
    assert.equal(saved.email, 'fixture@example.test');
    assert.equal(saved.expiresAt, result.expiresAt);
    assert.equal(saved.schemaVersion, 1);
    assert.equal(f.tokens(), 1);
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
    for (const name of [file, 'chatgpt-host.json']) assert.equal(statSync(join(f.directory, name)).mode & 0o777, 0o600);
    assert.equal(existsSync(join(f.directory, 'chatgpt.lock')), false);
    assert.deepEqual(chatGPTStatus(f.directory), { connected: true, clientId: 'oaiapp_fixture', expiresAt: saved.expiresAt, planUsageEnabled: true });
    assert.doesNotMatch(JSON.stringify(chatGPTStatus(f.directory)), /secret-|fixture@example|subject-fixture|idToken/);
    assert.equal(f.requests.length, 3); // Offline loader and status perform no HTTP requests.
  } finally { await f.cleanup(); }
});

test('returning sign-in uses stable host/client, fresh state/nonce/PKCE and no retained secret in printable URL', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const original = loadChatGPTConnection(f.directory);
    await f.connect(async url => {
      assert.equal(url.searchParams.get('client_id'), original.clientId);
      assert.equal(url.searchParams.get('ext_agent_host_id'), original.hostId);
      assert.equal(url.searchParams.has('agent_name_hint'), false);
      assert.equal(url.searchParams.has('id_token_hint'), false);
      assert.doesNotMatch(url.toString(), /secret-|eyJ/);
      for (const field of ['state', 'nonce', 'code_challenge']) assert.notEqual(url.searchParams.get(field), f.urls[0]!.searchParams.get(field));
      await (await f.callback(url, {}, target => target.searchParams.delete('client_id'))).text();
    });
    assert.equal(f.tokens(), 2);
  } finally { await f.cleanup(); }
});

for (const [name, extra, mutate] of [
  ['tampered state', { state: 'wrong' }], ['denial', { error: 'access_denied' }],
  ['denial with bad state', { error: 'access_denied', state: 'wrong' }],
  ['dynamic client', { client_id: 'dynamic_agent_client' }], ['empty code', { code: '' }],
  ['missing client', {}, (u: URL) => u.searchParams.delete('client_id')],
  ['missing state', {}, (u: URL) => u.searchParams.delete('state')],
  ['duplicate state', {}, (u: URL) => u.searchParams.append('state', u.searchParams.get('state')!)],
] as [string, Record<string, string>, ((u: URL) => void)?][]) {
  test(`callback rejects ${name} without exchanging or storing tokens`, async () => {
    const f = await fixture();
    try {
      await rejectsSafely(f.connect(async url => {
        const response = await f.callback(url, extra, mutate);
        assert.equal(response.status, 400); await response.text();
      }));
      assert.equal(f.tokens(), 0);
      assert.equal(existsSync(join(f.directory, file)), false);
      assert.deepEqual(chatGPTStatus(f.directory), { connected: false, planUsageEnabled: false });
    } finally { await f.cleanup(); }
  });
}

test('callback replay is consumed once; unrelated path does not consume pending attempt', async () => {
  const f = await fixture();
  try {
    await f.connect(async url => {
      const otherPath = new URL(url.searchParams.get('redirect_uri')!); otherPath.pathname = '/favicon.ico';
      assert.equal((await fetch(otherPath)).status, 404);
      assert.equal((await f.callback(url)).status, 200);
      assert.equal((await f.callback(url)).status, 409);
    });
    assert.equal(f.tokens(), 1);
  } finally { await f.cleanup(); }
});

for (const reason of ['client', 'subject'] as const) {
  test(`returning ${reason} mismatch preserves original credentials`, async () => {
    const f = await fixture();
    try {
      await f.connect();
      const original = readFileSync(join(f.directory, file));
      if (reason === 'subject') f.changes.claims = { sub: 'switched-subject' };
      await rejectsSafely(f.connect(async url => {
        await (await f.callback(url, reason === 'client' ? { client_id: 'oaiapp_wrong' } : {})).text();
      }));
      assert.deepEqual(readFileSync(join(f.directory, file)), original);
      assert.equal(f.tokens(), reason === 'client' ? 1 : 2);
    } finally { await f.cleanup(); }
  });
}

for (const [name, changes] of [
  ['wrong signature', { wrongSignature: true }], ['wrong audience', { claims: { aud: 'oaiapp_wrong' } }],
  ['wrong nonce', { claims: { nonce: 'wrong' } }], ['wrong issuer', { claims: { iss: 'https://attacker.test' } }],
  ['expired ID token', { claims: { exp: 1 } }], ['missing subject', { claims: { sub: '' } }],
  ['future iat', { claims: { iat: 9999999999 } }], ['future nbf', { claims: { nbf: 9999999999 } }],
  ['wrong azp', { claims: { azp: 'oaiapp_wrong' } }], ['multi audience without azp', { claims: { aud: ['oaiapp_fixture', 'other'] } }],
  ['algorithm confusion', { header: { alg: 'HS256' } }], ['unsecured JWT', { header: { alg: 'none' } }],
  ['untrusted key URL', { header: { jku: 'http://attacker.test/jwks' } }], ['unknown key', { header: { kid: 'unknown' } }],
  ['duplicate key', { keys: [jwk, jwk] }], ['no signing key', { keys: [] }],
  ['callback scope cannot authorize plan usage', { tokens: { scope: 'openid profile email' } }],
  ['missing granted scope', { tokens: { scope: undefined } }], ['bad token type', { tokens: { token_type: 'MAC' } }],
  ['zero expires_in', { tokens: { expires_in: 0 } }], ['malformed refresh', { tokens: { refresh_token: {} } }],
  ['oversized token response', { oversized: true }],
  ['untrusted discovery issuer', { discovery: { issuer: 'https://attacker.test' } }],
  ['untrusted discovery jwks', { discovery: { jwks_uri: 'https://auth.openai.com/evil' } }],
  ['untrusted discovery token', { discovery: { token_endpoint: 'https://attacker.test/token' } }],
  ['untrusted discovery authorize', { discovery: { authorization_endpoint: 'https://attacker.test/authorize' } }],
] as [string, Changes][]) {
  test(`rejects ${name} and redacts all failure details`, async () => {
    const f = await fixture(changes);
    try {
      await rejectsSafely(f.connect());
      assert.equal(existsSync(join(f.directory, file)), false);
      assert.equal(f.requests.some(path => path.includes('evil')), false);
      assert.equal(f.requests.some(path => path.includes('stolen')), false);
    } finally { await f.cleanup(); }
  });
}
for (const status of [301, 302, 303, 307, 308]) {
  test(`token endpoint ${status} is never followed`, async () => {
    const f = await fixture({ status });
    try {
      await rejectsSafely(f.connect());
      assert.equal(f.tokens(), 1);
      assert.equal(f.requests.includes('/stolen'), false);
    } finally { await f.cleanup(); }
  });
}

test('abort, timeout, browser failure and hung browser all release owned locks and stop the callback listener', async () => {
  for (const mode of ['abort', 'timeout', 'throw', 'hung'] as const) {
    const f = await fixture();
    const controller = new AbortController();
    let redirect: string | undefined;
    try {
      await rejectsSafely(f.connect(async url => {
        redirect = url.searchParams.get('redirect_uri')!;
        if (mode === 'abort') controller.abort();
        if (mode === 'throw') throw new Error('ChatGPT connection: secret-access-token');
        if (mode === 'hung') await new Promise(() => {});
      }, { signal: controller.signal, timeoutMs: mode === 'timeout' || mode === 'hung' ? 100 : 3000 }));
      assert.equal(existsSync(join(f.directory, 'chatgpt.lock')), false);
      if (redirect) await assert.rejects(fetch(redirect));
      assert.equal(f.tokens(), 0);
    } finally { await f.cleanup(); }
  }
});

test('existing and concurrent locks fail closed without retry, removal, or credentials access', async () => {
  const f = await fixture();
  try {
    mkdirSync(f.directory, { mode: 0o700 });
    const path = join(f.directory, 'chatgpt.lock');
    writeFileSync(path, 'existing-owner', { mode: 0o600 });
    await rejectsSafely(f.connect());
    assert.equal(readFileSync(path, 'utf8'), 'existing-owner');
    assert.equal(f.requests.length, 0);
    assert.throws(() => loadChatGPTConnection(f.directory), /locked/);
    rmSync(path);
    await f.connect(async url => {
      await rejectsSafely(f.connect());
      assert.throws(() => loadChatGPTConnection(f.directory), /locked/);
      await (await f.callback(url)).text();
    });
    assert.equal(f.tokens(), 1);
  } finally { await f.cleanup(); }
});

for (const mode of ['symlink file', 'hardlink file', 'unsafe file', 'unsafe directory', 'oversize', 'invalid JSON', 'schema', 'scope', 'expiry', 'host', 'unknown fields']) {
  test(`offline store rejects ${mode} and status stays redacted`, async () => {
    const f = await fixture();
    try {
      await f.connect();
      const path = join(f.directory, file);
      if (mode === 'symlink file') { const dest = join(f.root, 'target'); writeFileSync(dest, readFileSync(path), { mode: 0o600 }); rmSync(path); symlinkSync(dest, path); }
      if (mode === 'hardlink file') linkSync(path, join(f.root, 'second-link'));
      if (mode === 'unsafe file') chmodSync(path, 0o644);
      if (mode === 'unsafe directory') chmodSync(f.directory, 0o755);
      if (mode === 'oversize') writeFileSync(path, 'x'.repeat(131073));
      if (mode === 'invalid JSON') writeFileSync(path, 'secret-access-token');
      if (mode === 'schema') changeStored(f.directory, { schemaVersion: 2 });
      if (mode === 'scope') changeStored(f.directory, { scope: 'openid' });
      if (mode === 'expiry') changeStored(f.directory, { expiresAt: 1 });
      if (mode === 'host') changeStored(f.directory, { hostId: 'urn:uuid:00000000-0000-0000-0000-000000000000' });
      if (mode === 'unknown fields') changeStored(f.directory, { apiKey: 'secret-key' });
      assert.throws(() => loadChatGPTConnection(f.directory), (e: Error) => !/secret-/.test(e.message));
      assert.deepEqual(chatGPTStatus(f.directory), { connected: false, planUsageEnabled: false });
    } finally { await f.cleanup(); }
  });
}

test('store refuses canonical aliases, directory symlinks, project paths and all enclosing Git directory/file checkouts before browser or network', async () => {
  const f = await fixture();
  try {
    mkdirSync(f.directory, { mode: 0o700 });
    const alias = join(f.root, 'alias'); symlinkSync(f.directory, alias);
    for (const directory of [alias, `${f.root}/state/../state`, join(process.cwd(), 'state')]) {
      await rejectsSafely(f.connect(undefined, { directory }));
    }
    for (const gitType of ['directory', 'file']) {
      const repo = join(f.root, `repo-${gitType}`); mkdirSync(repo, { mode: 0o700 });
      if (gitType === 'directory') mkdirSync(join(repo, '.git')); else writeFileSync(join(repo, '.git'), 'gitdir: /fixture');
      const nested = join(repo, 'nested'); mkdirSync(nested, { mode: 0o700 });
      const directory = join(nested, 'credentials');
      await rejectsSafely(f.connect(undefined, { directory }));
      assert.equal(existsSync(directory), false);
    }
    const project = join(f.root, 'non-git-project'); mkdirSync(project, { mode: 0o700 });
    await rejectsSafely(createChatGPTAuth({ projectRoot: project, transport: async () => { throw new Error('network forbidden'); } })
      .connectChatGPT({ directory: join(project, 'credentials'), onAuthorize: () => { throw new Error('browser forbidden'); } }));
    assert.equal(f.requests.length, 0);
    assert.deepEqual(chatGPTStatus(join(f.root, 'absent')), { connected: false, planUsageEnabled: false });
  } finally { await f.cleanup(); }
});

test('expired connection requires reconnect but retains client and account consistency', async () => {
  const f = await fixture();
  try {
    await f.connect();
    changeStored(f.directory, { expiresAt: 1 });
    assert.throws(() => loadChatGPTConnection(f.directory), /reconnect/);
    await f.connect();
    assert.equal(f.urls[1]!.searchParams.get('client_id'), 'oaiapp_fixture');
    assert.ok(loadChatGPTConnection(f.directory).expiresAt > Date.now());
  } finally { await f.cleanup(); }
});

test('callback rejects wrong method and Host header without any token exchange', async () => {
  for (const mode of ['method', 'host']) {
    const f = await fixture();
    try {
      await rejectsSafely(f.connect(async url => {
        const target = new URL(url.searchParams.get('redirect_uri')!);
        target.search = new URLSearchParams({ code: 'fixture-code', state: url.searchParams.get('state')!, client_id: 'oaiapp_fixture' }).toString();
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const req = request(target, { method: mode === 'method' ? 'POST' : 'GET',
            headers: mode === 'host' ? { Host: 'attacker.test' } : {} }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
          req.on('error', reject); req.end();
        });
        assert.equal(status, 400);
      }));
      assert.equal(f.tokens(), 0);
    } finally { await f.cleanup(); }
  }
});

test('sign-in cannot replace a linked credential target or write through a replaced directory', async () => {
  for (const mode of ['symlink', 'hardlink', 'directory']) {
    const f = await fixture();
    try {
      await f.connect();
      const path = join(f.directory, file);
      const original = readFileSync(path);
      const target = join(f.root, 'retained');
      await rejectsSafely(f.connect(async url => {
        if (mode === 'directory') {
          // Replace with another owner-only directory while the original fd is pinned.
          const { renameSync } = await import('node:fs');
          renameSync(f.directory, target); mkdirSync(f.directory, { mode: 0o700 });
        } else if (mode === 'hardlink') linkSync(path, target);
        else { writeFileSync(target, original, { mode: 0o600 }); rmSync(path); symlinkSync(target, path); }
        await (await f.callback(url)).text();
      }));
      assert.deepEqual(readFileSync(mode === 'directory' ? join(target, file) : target), original);
      if (mode === 'directory') assert.equal(existsSync(path), false);
    } finally { await f.cleanup(); }
  }
});

test('failed first authorization retains its stable host for the next fresh attempt', async () => {
  const f = await fixture();
  try {
    await rejectsSafely(f.connect(async url => { await (await f.callback(url, { error: 'access_denied' })).text(); }));
    await f.connect();
    assert.equal(f.urls[0]!.searchParams.get('ext_agent_host_id'), f.urls[1]!.searchParams.get('ext_agent_host_id'));
    assert.notEqual(f.urls[0]!.searchParams.get('state'), f.urls[1]!.searchParams.get('state'));
  } finally { await f.cleanup(); }
});

test('lost lock ownership cannot persist new credentials or remove another owner lock', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const original = readFileSync(join(f.directory, file));
    const lock = join(f.directory, 'chatgpt.lock');
    await rejectsSafely(f.connect(async url => {
      rmSync(lock);
      writeFileSync(lock, 'new-owner', { mode: 0o600 });
      await (await f.callback(url)).text();
    }));
    assert.deepEqual(readFileSync(join(f.directory, file)), original);
    assert.equal(readFileSync(lock, 'utf8'), 'new-owner');
  } finally { await f.cleanup(); }
});
