import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { loadChatGPTConnection } from './chatgpt-auth.js';
import type { ChatGPTConnection } from './chatgpt-auth.js';
import { ChatGPTStore, chatGPTAccountFingerprint } from './chatgpt-store.js';
import type { ChatGPTBillingReview } from './chatgpt-store.js';

const sessions = new WeakMap<object, { directory: string; connection: ChatGPTConnection; expiresAt: number; review: ChatGPTBillingReview }>();
const identity = chatGPTAccountFingerprint;
const record = (c: ChatGPTConnection) => createHash('sha256').update(JSON.stringify([
  c.schemaVersion, c.hostId, c.clientId, c.subject, c.accessToken, c.refreshToken,
  c.idToken, c.scope, c.expiresAt, c.email,
])).digest('hex');
export const CHATGPT_USAGE_SETTINGS = 'https://chatgpt.com/#settings/Usage';
export interface BillingTerminal {
  isTTY: boolean;
  confirm(prompt: string): Promise<string>;
}
function reviewStore<T>(directory: string, action: (store: ChatGPTStore) => T): T {
  const store = new ChatGPTStore(directory);
  try { store.lock(); return action(store); } finally { store.close(); }
}
/** Forgetting the acknowledgement also invalidates already-open sessions. */
export function forgetChatGPTBillingReview(directory: string): void {
  reviewStore(directory, store => store.forgetBillingReview());
}
/** A trusted owner's persistent assertion, not a machine billing attestation.
 * Same-account credential renewal retains it. Project files cannot enable it. */
export async function openChatGPTPlanSession(directory: string, terminal: BillingTerminal): Promise<ChatGPTPlanSession> {
  if (!terminal.isTTY) throw new Error('Subscription-only execution requires an interactive account settings review');
  const connection = loadChatGPTConnection(directory);
  if (!connection.email) throw new Error('A signed account email is required to match the account in browser settings');
  directory = realpathSync(directory);
  let review = reviewStore(directory, store => store.billingReview(connection));
  if (!review) {
    const phrase = `credits-disabled ${identity(connection)}`;
    const answer = await terminal.confirm(
      `Connection directory: ${directory}\nApp/client: ${connection.clientId}\nSigned account email: ${connection.email}\nAccount subject: ${connection.subject}\nAccount fingerprint: ${identity(connection)}\n` +
      `Match this email to the account open in your browser. Open ChatGPT Settings > Usage and verify "Allow other apps to use credits after reaching your usage limit" is OFF for that same account.\n` +
      `This is an owner confirmation, not an automatic inspection. Disabling credit auto-purchase alone is insufficient.\n` +
      `This acknowledgement is remembered for this account across runs and reconnects. Reset it if the setting changes.\n` +
      `Enter exactly "${phrase}" only after reviewing that setting, or cancel: `,
    );
    if (answer !== phrase) throw new Error('Subscription-only settings review was not confirmed');
    const current = loadChatGPTConnection(directory);
    if (record(current) !== record(connection))
      throw new Error('Connection changed during account review');
    review = reviewStore(directory, store => store.confirmBillingReview(connection));
  }
  const session = new ChatGPTPlanSession();
  sessions.set(session, { directory, connection, expiresAt: connection.expiresAt, review });
  session.assertActive();
  return session;
}
/** No API-key, native-login credential extraction, endpoint override or retry path. */
export class ChatGPTPlanSession {
  assertActive(): void {
    const state = sessions.get(this);
    if (!state) throw new Error('Authenticated subscription-only session required');
    if (Date.now() >= state.expiresAt) throw new Error('ChatGPT connection expired; reconnect required');
    const current = loadChatGPTConnection(state.directory);
    if (record(current) !== record(state.connection))
      throw new Error('Selected ChatGPT connection changed or was disconnected');
    const review = reviewStore(state.directory, store => store.billingReview(current));
    if (review?.reviewId !== state.review.reviewId) throw new Error('Subscription-only account acknowledgement was reset or changed');
  }
  binding(): { clientId: string; accountSha256: string; billingReview: string; confirmedAt: number; expiresAt: number } {
    this.assertActive();
    const state = sessions.get(this)!;
    return { clientId: state.connection.clientId, accountSha256: identity(state.connection),
      billingReview: 'owner-confirmed-server-credit-control-off', confirmedAt: state.review.confirmedAt, expiresAt: state.expiresAt };
  }
  async request(payload: string, signal: AbortSignal): Promise<Response> {
    this.assertActive(); signal.throwIfAborted();
    const state = sessions.get(this)!;
    // Fetch's abort signal remains active through response-body consumption.
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, state.expiresAt - Date.now()))]);
    return fetch('https://api.openai.com/v1/responses', {
      method: 'POST', redirect: 'error', signal: lifetime,
      headers: { Authorization: `Bearer ${state.connection.accessToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: payload,
    });
  }
}

export function assertChatGPTPlanSession(session: ChatGPTPlanSession): void {
  if (!sessions.has(session)) throw new Error('Unrecognized authenticated ChatGPT plan session');
  session.assertActive();
}
