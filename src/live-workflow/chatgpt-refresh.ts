import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { ChatGPTStore, authError, connectionDigest, directScope, isAuthError, textField } from './chatgpt-store.js';
import type { ChatGPTConnection } from './chatgpt-store.js';
import { identityTokenResponse, openAIIdentity, verifyRefreshIdentity } from './chatgpt-oidc.js';
import type { ChatGPTTransport } from './chatgpt-oidc.js';
import { RunAuthority } from './authority.js';
import { sourceIdentity } from './repository.js';

const TERMINAL = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const scopes = (s: string) => [...new Set(s.split(' ').filter(Boolean))].sort().join(' ');
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((yes, no) => {
    const stop = () => no(authError('renewal cancelled or timed out; reconnect if dispatched'));
    signal.addEventListener('abort', stop, { once: true });
    void work.then(yes, no).finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
  });
}
export interface ChatGPTRefreshOptions {
  signal?: AbortSignal;
  minimumLifetimeMs?: number;
  /** A session can adopt only a renewal of its own exact protected record. */
  expectedConnection?: ChatGPTConnection;
  /** Optional caller grant check can narrow the independent owner OAuth action. */
  check?: () => void;
}
/** Owner-only dependency seam for synthetic fixtures. Production endpoints and policy stay fixed. */
export function createChatGPTRefresh(dependencies: { transport?: ChatGPTTransport; projectRoot?: string } = {}) {
  const transport = dependencies.transport ?? ((url: string, init: RequestInit) => fetch(url, init));
  return async function ensureConnection(directory: string, options: ChatGPTRefreshOptions = {}): Promise<ChatGPTConnection> {
    const minimum = options.minimumLifetimeMs ?? 0;
    if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > 930000) throw authError('invalid renewal lifetime');
    const deadline = Date.now() + 30000;
    const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(30000)]);
    const checkLive = () => {
      if (Date.now() >= deadline) throw authError('renewal deadline exhausted; reconnect if dispatched');
      signal.throwIfAborted(); options.check?.();
      if (Date.now() >= deadline) throw authError('renewal deadline exhausted; reconnect if dispatched');
      signal.throwIfAborted();
    };
    checkLive();
    const project = resolve(dependencies.projectRoot ?? fileURLToPath(new URL('../../../', import.meta.url)));
    const store = new ChatGPTStore(directory, project);
    let release: ((() => void) & { check(): void }) | undefined, authority: RunAuthority | undefined;
    let action: ReturnType<RunAuthority['reserve']> | undefined;
    let locked = false;
    const lock = () => { store.lock(); locked = true; };
    const unlock = () => { store.unlock(); locked = false; };
    const read = () => {
      const c = store.connection(true);
      if (!c) throw authError('not connected; reconnect required');
      if (options.expectedConnection && connectionDigest(c) !== connectionDigest(options.expectedConnection)) throw authError('selected connection changed');
      if (store.pendingRefresh()) throw authError('previous renewal is indeterminate; reconnect required');
      return c;
    };
    try {
      const healthy = store.reviewedSnapshot(true).connection;
      checkLive();
      if (options.expectedConnection && connectionDigest(healthy) !== connectionDigest(options.expectedConnection)) throw authError('selected connection changed');
      if (healthy.expiresAt - Date.now() > minimum) return healthy;
      lock(); let previous = read();
      if (previous.expiresAt - Date.now() > minimum) return previous;
      unlock(); release = store.lockRefresh(); lock(); previous = read();
      if (previous.expiresAt - Date.now() > minimum) return previous;
      if (!previous.refreshToken) throw authError('expired or insufficient token lifetime; reconnect required');
      const review = JSON.stringify(store.billingReview(previous));
      const source = sourceIdentity(project), taskId = `oauth-refresh-${randomUUID()}`;
      authority = new RunAuthority(join(store.directory, taskId), project, 'forgemind-owner-oauth', {
        schemaVersion: 1, taskId, objective: 'Renew the selected owner ChatGPT connection, no inference',
        readPaths: [], writePaths: [], checks: [], model: 'none', effort: 'low', maxModelRequests: 0,
        maxPromptBytes: 1, maxOutputBytes: 131072, maxRuntimeMs: Math.max(1, deadline - Date.now()), draftPr: false,
      }, source);
      action = authority.reserve({ kind: 'provider', source, detail: { operation: 'oauth-refresh', endpoint: openAIIdentity.token,
        connectionSha256: connectionDigest(previous), clientId: previous.clientId, noInference: true, noRetry: true } });
      const checkSource = () => {
        checkLive(); action!.check();
        if (sourceIdentity(project) !== source) throw authError('runtime source changed during renewal');
        checkLive(); action!.check();
      };
      release.check(); checkSource(); store.beginRefresh(previous); unlock();
      release.check(); checkLive(); action.check();
      const receivedAt = Date.now();
      const reply = await abortable(identityTokenResponse(transport, { method: 'POST', signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: previous.clientId,
          refresh_token: previous.refreshToken, resource: openAIIdentity.resource }).toString(),
      }), signal);
      checkSource();
      // Re-check exact credentials and owner acknowledgement before any persistence or invalidation.
      const checkCurrent = () => {
        release!.check(); checkSource();
        const current = store.connection(true);
        if (!current || connectionDigest(current) !== connectionDigest(previous)
          || JSON.stringify(store.billingReview(current)) !== review || !store.pendingRefresh()) throw authError('connection or acknowledgement changed during renewal');
      };
      if (reply.status !== 200) {
        if (typeof reply.data.error === 'string' && TERMINAL.has(reply.data.error)) {
          lock(); checkCurrent(); checkLive(); action.check(); store.invalidateConnection();
          action.finish('failed'); action = undefined;
          throw authError('refresh token rejected; reconnect using the retained registration');
        }
        throw authError('renewal was not completed; reconnect required');
      }
      const tokens = reply.data;
      if (!textField(tokens.access_token) || !textField(tokens.refresh_token) || tokens.token_type !== 'Bearer'
        || !directScope(tokens.scope) || scopes(tokens.scope) !== scopes(previous.scope)
        || !Number.isSafeInteger(tokens.expires_in) || (tokens.expires_in as number) < 1
        || (tokens.expires_in as number) > 31536000 || tokens.error !== undefined
        || (tokens.id_token !== undefined && !textField(tokens.id_token, 65536))) throw authError('invalid renewal response; reconnect required');
      if (tokens.id_token !== undefined) await abortable(verifyRefreshIdentity(tokens.id_token as string, previous, transport, signal), signal);
      const next: ChatGPTConnection = { ...previous, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        // Original verified ID claims remain the identity anchor, even when the ID token has expired.
        expiresAt: receivedAt + (tokens.expires_in as number) * 1000 };
      checkSource();
      if (next.expiresAt - Date.now() <= minimum) throw authError('renewed token does not cover the requested task lifetime');
      lock(); checkCurrent(); checkLive(); action.check();
      store.save(next); checkLive(); action.check(); release.check(); store.finishRefresh();
      action.finish('completed', connectionDigest(next)); action = undefined;
      authority.phase('renewed', source, { expiresAt: next.expiresAt }); authority.finish('completed');
      return next;
    } catch (error) {
      try { action?.finish('indeterminate'); authority?.finish('failed'); } catch { /* preserve recovery marker */ }
      if (isAuthError(error)) throw error;
      throw authError('renewal failed or was cancelled; reconnect if dispatched');
    } finally {
      // Never remove the durable pending marker on failure. A lost response must not replay the old refresh token.
      try { if (locked) unlock(); } finally {
        try { release?.(); } finally { try { authority?.close(); } finally { store.close(); } }
      }
    }
  };
}
export const ensureChatGPTConnection = createChatGPTRefresh();
