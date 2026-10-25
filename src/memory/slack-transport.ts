import { request } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { bytes, dataSnapshot, digest, object, serialize, string } from '../context-engine/validation.js';
import { natural, slug } from './run-recording.js';
import { shape } from './weekly-delivery-envelope.js';
import { maxSlackBytes, slackEntry, slackLiteral } from './slack-envelope.js';
import { weeklyReportLines } from './weekly-email.js';
import type { SlackEnvelope } from './slack-envelope.js';

export type SlackAdapterResult = { readonly status: 'accepted' | 'uncertain' };
/** Opaque owner capability: serialized copies cannot send. */
export interface OwnerSlackAdapter { readonly destinationId: string; readonly endpointBinding: string }
export interface SlackWebhookOptions {
  readonly destinationId: string; readonly webhookUrl: string;
  readonly deadlineMs?: number; readonly maxResponseBytes?: number;
}
/** Trusted host/test seam. URL is secret: never log or expose this request. */
export interface PrivateSlackRequest {
  readonly url: string; readonly body: string; readonly signal: AbortSignal; readonly maxResponseBytes: number;
}
export interface SlackResponse { readonly statusCode: number; readonly acknowledged: boolean }
export type SlackTransport = (request: PrivateSlackRequest) => Promise<SlackResponse>;
export type SlackHttpOpen = (url: string, options: RequestOptions, receive: (res: IncomingMessage) => void) => ClientRequest;
const adapters = new WeakMap<OwnerSlackAdapter, (envelope: SlackEnvelope) => Promise<SlackAdapterResult>>();
function bound(value: unknown, min: number, max: number): asserts value is number {
  natural(value); if (value < min || value > max) throw new Error('invalid Slack transport bound');
}
/** Standard Slack only. Canonical literal syntax rejects encoded paths, aliases and redirects. */
function endpoint(raw: unknown): string {
  string(raw, 2048);
  if (!/^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{1,127}\/B[A-Z0-9]{1,127}\/[A-Za-z0-9_-]{1,256}$/.test(raw)) {
    throw new Error('unsupported Slack webhook');
  }
  const url = new URL(raw);
  if (url.href !== raw || url.protocol !== 'https:' || url.hostname !== 'hooks.slack.com' ||
      url.port || url.username || url.password || url.hash || url.search) throw new Error('invalid Slack endpoint');
  return raw;
}
/** One POST with mandatory TLS verification. No redirects, pooling or retries. */
export function createSlackHttpsTransport(open: SlackHttpOpen = request): SlackTransport {
  return input => new Promise((resolve, reject) => {
    const target = endpoint(input.url);
    string(input.body, maxSlackBytes); bound(input.maxResponseBytes, 0, 16384);
    let settled = false;
    const fail = () => { if (!settled) { settled = true; reject(new Error('Slack transport uncertain')); } };
    const req = open(target, {
      method: 'POST', signal: input.signal, agent: false, rejectUnauthorized: true, maxHeaderSize: 8192,
      headers: { 'content-type': 'application/json', 'content-length': bytes(input.body) }
    }, res => {
      let received = 0, matches = true;
      res.on('data', (chunk: Buffer) => {
        if (received + chunk.length > input.maxResponseBytes) { fail(); res.destroy(); req.destroy(); return; }
        // Compare without retaining arbitrary response text or logging provider errors.
        for (const byte of chunk) {
          if (received > 1 || byte !== (received === 0 ? 0x6f : 0x6b)) matches = false;
          received++;
        }
      });
      res.on('error', fail); res.on('aborted', fail);
      res.on('end', () => {
        if (!settled) {
          settled = true;
          resolve({ statusCode: res.statusCode ?? 0, acknowledged: matches && received === 2 });
        }
      });
    });
    req.on('error', fail); req.end(input.body);
  });
}
const httpsTransport = createSlackHttpsTransport();
export function createSlackWebhookAdapter(raw: SlackWebhookOptions, transport: SlackTransport = httpsTransport): OwnerSlackAdapter {
  try {
    const v = dataSnapshot(raw);
    object(v, ['destinationId', 'webhookUrl', 'deadlineMs', 'maxResponseBytes']);
    slug(v.destinationId);
    const url = endpoint(v.webhookUrl), deadlineMs = v.deadlineMs ?? 10000, maxResponseBytes = v.maxResponseBytes ?? 4096;
    bound(deadlineMs, 10, 30000); bound(maxResponseBytes, 0, 16384);
    if (typeof transport !== 'function') throw new Error('invalid Slack transport');
    const adapter: OwnerSlackAdapter = Object.freeze({ destinationId: v.destinationId,
      endpointBinding: digest(serialize({ domain: 'slack-incoming-endpoint-v1', endpoint: url })) });
    adapters.set(adapter, async rawEnvelope => {
      try {
        const safe = dataSnapshot(rawEnvelope);
        const envelope = slackEntry({ schemaVersion: 1, envelope: safe, status: 'pending', attempts: 0 },
          safe.summary.projectId, safe.summary.originalRoot).envelope;
        if (envelope.destinationId !== adapter.destinationId || envelope.endpointBinding !== adapter.endpointBinding) {
          throw new Error('Slack destination mismatch');
        }
        // Render the readable report at send time so stored envelopes stay valid; over budget, post the exact stored payload.
        const rendered = serialize({ ...envelope.payload,
          text: slackLiteral(weeklyReportLines(envelope.summary)) + '\n\n' + envelope.payload.text });
        const fits = bytes(rendered) <= maxSlackBytes && bytes(rendered) <= envelope.payloadBudget;
        const body = fits ? rendered : serialize(envelope.payload);
        if (bytes(body) > maxSlackBytes || bytes(body) > envelope.payloadBudget) throw new Error('Slack payload bound');
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('Slack deadline')); }, deadlineMs);
          });
          const result = dataSnapshot(await Promise.race([Promise.resolve().then(() => transport({
            url, body, signal: controller.signal, maxResponseBytes
          })), expired]));
          shape(result, ['statusCode', 'acknowledged']); bound(result.statusCode, 100, 599);
          if (typeof result.acknowledged !== 'boolean') throw new Error('invalid acknowledgment');
          return Object.freeze({ status: result.statusCode === 200 && result.acknowledged ? 'accepted' as const : 'uncertain' as const });
        } finally { if (timer !== undefined) clearTimeout(timer); }
      } catch { return Object.freeze({ status: 'uncertain' as const }); }
    });
    return adapter;
  } catch { throw new Error('Invalid private Slack owner configuration'); }
}
export function assertSlackAdapter(adapter: OwnerSlackAdapter): void {
  if (!adapters.has(adapter)) throw new Error('trusted Slack owner adapter required');
}
export async function sendSlackEnvelope(adapter: OwnerSlackAdapter, envelope: SlackEnvelope): Promise<SlackAdapterResult> {
  assertSlackAdapter(adapter); return adapters.get(adapter)!(envelope);
}
