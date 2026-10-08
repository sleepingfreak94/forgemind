import { createPublicKey, verify } from 'node:crypto';
import { authError, record, textField } from './chatgpt-store.js';

// Source: https://developers.openai.com/siwc/website (OIDC production discovery).
export const openAIIdentity = Object.freeze({
  issuer: 'https://auth.openai.com',
  discovery: 'https://auth.openai.com/.well-known/openid-configuration',
  authorization: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  jwks: 'https://auth.openai.com/.well-known/jwks.json',
  resource: 'https://api.openai.com/v1',
});
export type ChatGPTTransport = (url: string, init: RequestInit) => Promise<Response>;
const MAX_RESPONSE = 128 * 1024;

export async function identityJSON(transport: ChatGPTTransport, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  if (!([openAIIdentity.discovery, openAIIdentity.token, openAIIdentity.jwks] as readonly string[]).includes(url)) throw authError('untrusted identity endpoint');
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await transport(url, { ...init, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (response.redirected || response.status !== 200 || !response.body) throw authError('identity request failed');
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) throw authError('identity response exceeds limit');
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE) throw authError('identity response exceeds limit');
      chunks.push(Buffer.from(part.value));
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch { throw authError('identity request failed or returned invalid data'); }
  finally {
    if (reader) { try { await reader.cancel(); } catch { /* discard untrusted response */ } reader.releaseLock(); }
    else if (response?.body) { try { await response.body.cancel(); } catch { /* discard */ } }
  }
}
export async function discoverIdentity(transport: ChatGPTTransport, signal: AbortSignal): Promise<void> {
  const d = await identityJSON(transport, openAIIdentity.discovery, { signal });
  if (d.issuer !== openAIIdentity.issuer || d.authorization_endpoint !== openAIIdentity.authorization
    || d.token_endpoint !== openAIIdentity.token || d.jwks_uri !== openAIIdentity.jwks)
    throw authError('untrusted OpenID discovery');
}
function decodePart(part: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw authError('invalid ID token');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw authError('invalid ID token encoding');
  return record(JSON.parse(bytes.toString('utf8')));
}
export async function verifyIdentity(
  token: string, clientId: string, nonce: string, transport: ChatGPTTransport, signal: AbortSignal,
): Promise<{ subject: string; expiresAt: number; email?: string }> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || token.length > 65536) throw authError('invalid ID token');
    const [head, body, signature] = parts as [string, string, string];
    const header = decodePart(head), claims = decodePart(body);
    if (header.alg !== 'RS256' || !textField(header.kid, 256) || header.crit !== undefined
      || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined)
      throw authError('unsupported ID token signature');
    const jwks = await identityJSON(transport, openAIIdentity.jwks, { signal });
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 64) throw authError('invalid signing keys');
    const keys = jwks.keys.map(record).filter(k => k.kid === header.kid);
    if (keys.length !== 1) throw authError('unknown or ambiguous signing key');
    const k = keys[0]!;
    if (k.kty !== 'RSA' || (k.alg !== undefined && k.alg !== 'RS256')
      || (k.use !== undefined && k.use !== 'sig') || k.d !== undefined
      || (k.key_ops !== undefined && (!Array.isArray(k.key_ops) || !k.key_ops.includes('verify')))
      || !textField(k.n, 2048) || !textField(k.e, 16)) throw authError('invalid signing key');
    const key = createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' });
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || !/^[A-Za-z0-9_-]+$/.test(signature)) throw authError('invalid signing key or signature');
    const sig = Buffer.from(signature, 'base64url');
    if (sig.toString('base64url') !== signature || !verify('RSA-SHA256', Buffer.from(`${head}.${body}`), key, sig))
      throw authError('ID token signature failed');
    const now = Date.now() / 1000;
    const audience = claims.aud;
    const audienceOK = audience === clientId || (Array.isArray(audience) && audience.length > 0
      && audience.every(a => typeof a === 'string') && audience.includes(clientId)
      && (audience.length === 1 || claims.azp === clientId));
    if (claims.iss !== openAIIdentity.issuer || !audienceOK || (claims.azp !== undefined && claims.azp !== clientId)
      || !Number.isSafeInteger(claims.exp) || (claims.exp as number) <= now
      || !Number.isSafeInteger(claims.iat) || (claims.iat as number) > now + 5
      || (claims.iat as number) >= (claims.exp as number)
      || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || (claims.nbf as number) > now))
      || claims.nonce !== nonce || !textField(claims.sub, 512)) throw authError('ID token claims failed');
    const result = { subject: claims.sub, expiresAt: (claims.exp as number) * 1000 };
    // Only a signed, provider-verified email is suitable for the owner's identity review.
    return claims.email_verified === true && textField(claims.email, 320) ? { ...result, email: claims.email } : result;
  } catch { throw authError('ID token validation failed'); }
}
