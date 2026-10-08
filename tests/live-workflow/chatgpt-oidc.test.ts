import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { discoverIdentity, identityJSON, openAIIdentity, verifyIdentity } from '../../src/live-workflow/chatgpt-oidc.js';
import type { ChatGPTTransport } from '../../src/live-workflow/chatgpt-oidc.js';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
const abort = new AbortController().signal;
function jwt(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test', ...header })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: openAIIdentity.issuer, sub: 'subject', aud: 'oaiapp_test',
    nonce: 'nonce', iat: now, exp: now + 3600, ...claims })).toString('base64url');
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), pair.privateKey).toString('base64url')}`;
}
const keys: ChatGPTTransport = async (url, init) => {
  assert.equal(url, openAIIdentity.jwks);
  assert.equal(init.redirect, 'manual');
  return Response.json({ keys: [key] });
};

test('OIDC supports a matching single audience and authorized multiple audiences', async () => {
  for (const claims of [{ aud: ['oaiapp_test'] }, { aud: ['other', 'oaiapp_test'], azp: 'oaiapp_test' }]) {
    const result = await verifyIdentity(jwt(claims), 'oaiapp_test', 'nonce', keys, abort);
    assert.equal(result.subject, 'subject');
    assert.ok(result.expiresAt > Date.now());
  }
});
test('email is retained only from a valid signed token explicitly asserting email_verified true', async () => {
  for (const email_verified of [true, false, undefined, 'true']) {
    const result = await verifyIdentity(jwt({ email: 'signed@example.test', email_verified }), 'oaiapp_test', 'nonce', keys, abort);
    assert.equal(result.email, email_verified === true ? 'signed@example.test' : undefined);
  }
  await assert.rejects(verifyIdentity(jwt({ email: 'signed@example.test', email_verified: true }), 'oaiapp_test', 'wrong-nonce', keys, abort));
});
for (const token of ['', 'a.b', 'e30.e30.invalid', `${jwt()}.extra`]) {
  test('malformed ID token is rejected with a constant safe error', async () => {
    await assert.rejects(verifyIdentity(token, 'oaiapp_test', 'nonce', keys, abort), { message: 'ChatGPT connection: ID token validation failed' });
  });
}
for (const header of [{ crit: [] }, { jwk: key }, { x5u: 'https://attacker.test/key' }]) {
  test('ID token cannot select an external or embedded verification key', async () => {
    let requested = false;
    await assert.rejects(verifyIdentity(jwt({}, header), 'oaiapp_test', 'nonce', async () => { requested = true; return Response.json({}); }, abort));
    assert.equal(requested, false);
  });
}
for (const patch of [{ alg: 'HS256' }, { use: 'enc' }, { key_ops: ['encrypt'] }, { d: 'private' }, { n: '' }]) {
  test('JWKS must supply one compatible public RSA signature verification key', async () => {
    await assert.rejects(verifyIdentity(jwt(), 'oaiapp_test', 'nonce', async () => Response.json({ keys: [{ ...key, ...patch }] }), abort));
  });
}
test('weak RSA modulus is refused', async () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  await assert.rejects(verifyIdentity(jwt(), 'oaiapp_test', 'nonce', async () => Response.json({ keys: [
    { ...weak.publicKey.export({ format: 'jwk' }), kid: 'test' },
  ] }), abort));
});

test('identity transport does not call unpinned endpoints', async () => {
  let called = false;
  await assert.rejects(identityJSON(async () => { called = true; return Response.json({}); }, 'http://127.0.0.1/unpinned', {}), /untrusted/);
  assert.equal(called, false);
});
test('body read limit applies to streamed responses without content-length and cancels stream', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(8192)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(identityJSON(async () => new Response(stream), openAIIdentity.token, {}), /invalid data/);
  assert.equal(cancelled, true);
});
for (const length of ['131073', 'secret-access-token', '-1', '9999999999999999999999999999999']) {
  test('invalid and oversized content-length is refused and response cancelled before reading', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await assert.rejects(identityJSON(async () => new Response(body, { headers: { 'Content-Length': length } }), openAIIdentity.token, {}));
    assert.equal(cancelled, true);
  });
}
test('HTTP errors and JSON/transport failures never expose server data or thrown secrets', async () => {
  for (const transport of [
    async () => new Response('secret-access-token', { status: 500 }),
    async () => new Response('secret-access-token', { status: 200 }),
    async () => { throw new Error('secret-refresh-token'); },
    async () => Response.json([]),
  ] satisfies ChatGPTTransport[]) {
    await assert.rejects(identityJSON(transport, openAIIdentity.token, {}), { message: 'ChatGPT connection: identity request failed or returned invalid data' });
  }
});
test('already-followed transport responses are rejected even when they return 200', async () => {
  const response = Response.json({});
  Object.defineProperty(response, 'redirected', { value: true });
  await assert.rejects(identityJSON(async () => response, openAIIdentity.token, {}));
});
test('discovery requires exact issuer and pinned official endpoints, including path and scheme', async () => {
  const valid = { issuer: openAIIdentity.issuer, authorization_endpoint: openAIIdentity.authorization,
    token_endpoint: openAIIdentity.token, jwks_uri: openAIIdentity.jwks };
  for (const [field, value] of Object.entries(valid)) {
    for (const bad of [`${value}/`, value.replace('https:', 'http:'), 'https://attacker.test']) {
      await assert.rejects(discoverIdentity(async () => Response.json({ ...valid, [field]: bad }), abort), /untrusted/);
    }
  }
});
