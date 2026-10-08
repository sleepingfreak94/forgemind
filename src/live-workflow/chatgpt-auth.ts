import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authError, ChatGPTStore, directScope, isAuthError, issuedClient, requestedChatGPTScopes, textField } from './chatgpt-store.js';
import type { ChatGPTConnection } from './chatgpt-store.js';
import { discoverIdentity, identityJSON, openAIIdentity, verifyIdentity } from './chatgpt-oidc.js';
import type { ChatGPTTransport } from './chatgpt-oidc.js';

export type { ChatGPTConnection } from './chatgpt-store.js';
export { loadChatGPTConnection, chatGPTStatus } from './chatgpt-store.js';
export interface ChatGPTConnectOptions {
  /** Canonical owner-only state directory, outside the project root. Parent must exist. */
  directory: string;
  signal?: AbortSignal;
  onAuthorize: (url: string) => void | Promise<void>;
  timeoutMs?: number;
}
export interface ChatGPTConnectResult {
  clientId: string;
  subject: string;
  /** Unix epoch milliseconds; reconnect is required on expiry. */
  expiresAt: number;
  /** Granted direct scope only; this makes no billing/credit-setting claim. */
  planUsageEnabled: boolean;
}
interface CallbackResult { code: string; clientId: string }
function sameState(value: string | null, expected: string): boolean {
  if (!value || value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
function callbackListener(state: string, previous: ChatGPTConnection | undefined, signal: AbortSignal): {
  server: Server; result: Promise<CallbackResult>; dispose: () => void;
} {
  let resolve!: (value: CallbackResult) => void, reject!: (error: Error) => void;
  let consumed = false;
  const result = new Promise<CallbackResult>((yes, no) => { resolve = yes; reject = no; });
  void result.catch(() => undefined);
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Connection', 'close');
    const path = req.url?.split('?')[0];
    if (path !== '/auth/callback') { res.writeHead(404).end('Not found'); return; }
    if (consumed) { res.writeHead(409).end('Sign-in attempt already consumed'); return; }
    consumed = true;
    try {
      const address = server.address() as AddressInfo;
      if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${address.port}`
        || !req.url || req.url.length > 12288) throw authError('invalid callback');
      const url = new URL(req.url, `http://127.0.0.1:${address.port}`);
      const params = url.searchParams;
      for (const key of params.keys()) if (params.getAll(key).length !== 1) throw authError('duplicate callback parameter');
      if (!sameState(params.get('state'), state)) throw authError('callback state mismatch');
      if (params.has('error')) throw authError('authorization denied or failed');
      const code = params.get('code');
      const client = params.get('client_id') ?? previous?.clientId;
      if (!textField(code, 4096) || !issuedClient(client)) throw authError('incomplete registration callback');
      if (previous && client !== previous.clientId) throw authError('callback client mismatch');
      res.writeHead(200).end('Sign-in received. Return to ForgeMind.', () => resolve({ code, clientId: client }));
    } catch {
      res.writeHead(400).end('Sign-in could not be verified. Reconnect in ForgeMind.', () => reject(authError('callback rejected')));
    }
  });
  const abort = (): void => { consumed = true; reject(authError('sign-in cancelled or timed out')); };
  const failed = (): void => { consumed = true; reject(authError('callback listener failed')); };
  server.on('error', failed);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return { server, result, dispose: () => { signal.removeEventListener('abort', abort); server.off('error', failed); } };
}
async function listen(server: Server, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => { server.off('error', failed); signal.removeEventListener('abort', aborted); };
    const failed = (): void => { cleanup(); reject(authError('callback listener failed')); };
    const aborted = (): void => { cleanup(); reject(authError('sign-in cancelled or timed out')); };
    server.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { cleanup(); resolve(); });
  });
}
async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(authError('sign-in cancelled or timed out'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Explicit dependency seam for synthetic tests/embedding. Production URLs stay pinned;
 * no environment, CLI, URL parameter, ambient key, or Codex credential overrides exist.
 * projectRoot defaults to the caller's canonical cwd; pass the actual project when embedding.
 */
export function createChatGPTAuth(dependencies: { transport?: ChatGPTTransport; projectRoot?: string } = {}): {
  connectChatGPT: (options: ChatGPTConnectOptions) => Promise<ChatGPTConnectResult>;
} {
  const transport: ChatGPTTransport = dependencies.transport ?? ((url, init) => fetch(url, init));
  return {
    async connectChatGPT(options): Promise<ChatGPTConnectResult> {
      const timeout = options.timeoutMs ?? 180000;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000 || typeof options.onAuthorize !== 'function')
        throw authError('invalid sign-in options');
      if (options.signal?.aborted) throw authError('sign-in cancelled');
      const store = new ChatGPTStore(options.directory, dependencies.projectRoot, true);
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      const timer = setTimeout(cancel, timeout);
      options.signal?.addEventListener('abort', cancel, { once: true });
      let listener: ReturnType<typeof callbackListener> | undefined;
      try {
        store.lock();
        const hostId = store.getHostId();
        const previous = store.connection(true);
        const state = randomBytes(32).toString('base64url');
        const nonce = randomBytes(32).toString('base64url');
        const verifier = randomBytes(64).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        listener = callbackListener(state, previous, controller.signal);
        await listen(listener.server, controller.signal);
        await withAbort(discoverIdentity(transport, controller.signal), controller.signal);
        const port = (listener.server.address() as AddressInfo).port;
        const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
        const url = new URL(openAIIdentity.authorization);
        url.search = new URLSearchParams({
          client_id: previous?.clientId ?? 'dynamic_agent_client',
          ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri,
          scope: requestedChatGPTScopes, resource: openAIIdentity.resource,
          state, nonce, code_challenge_method: 'S256', code_challenge: challenge,
        }).toString();
        // The URL may be printed by a CLI: never put retained tokens in it.
        if (!previous) url.searchParams.set('agent_name_hint', 'ForgeMind');
        await withAbort(Promise.resolve().then(() => options.onAuthorize(url.toString())), controller.signal);
        const callback = await listener.result;
        if (controller.signal.aborted) throw authError('sign-in cancelled');
        const receivedAt = Date.now();
        const tokens = await withAbort(identityJSON(transport, openAIIdentity.token, {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: callback.clientId,
            code: callback.code, code_verifier: verifier, redirect_uri: redirectUri, resource: openAIIdentity.resource }).toString(),
        }), controller.signal);
        if (!textField(tokens.access_token) || !textField(tokens.id_token, 65536)
          || tokens.token_type !== 'Bearer' || !directScope(tokens.scope)
          || !Number.isSafeInteger(tokens.expires_in) || (tokens.expires_in as number) <= 0
          || (tokens.expires_in as number) > 31536000 || tokens.error !== undefined
          || (tokens.refresh_token !== undefined && !textField(tokens.refresh_token)))
          throw authError('invalid token response or direct scope not granted');
        const identity = await withAbort(verifyIdentity(tokens.id_token, callback.clientId, nonce, transport, controller.signal), controller.signal);
        if (previous && (identity.subject !== previous.subject || callback.clientId !== previous.clientId))
          throw authError('account identity mismatch; existing account retained');
        const connection: ChatGPTConnection = {
          schemaVersion: 1, hostId, clientId: callback.clientId, subject: identity.subject,
          accessToken: tokens.access_token, idToken: tokens.id_token, scope: tokens.scope,
          expiresAt: Math.min(receivedAt + (tokens.expires_in as number) * 1000, identity.expiresAt),
          ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token as string }),
          ...(identity.email === undefined ? {} : { email: identity.email }),
        };
        if (controller.signal.aborted) throw authError('sign-in cancelled');
        store.save(connection);
        return { clientId: connection.clientId, subject: connection.subject, expiresAt: connection.expiresAt, planUsageEnabled: true };
      } catch (error) {
        // Only module-authored messages escape. Transport/browser/provider errors can contain credentials.
        if (isAuthError(error)) throw error;
        throw authError('sign-in failed; reconnect required');
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        controller.abort();
        if (listener) {
          listener.dispose();
          listener.server.closeAllConnections();
          await new Promise<void>(resolve => listener!.server.close(() => resolve()));
        }
        store.close();
      }
    },
  };
}

export async function connectChatGPT(options: ChatGPTConnectOptions): Promise<ChatGPTConnectResult> {
  return createChatGPTAuth().connectChatGPT(options);
}
