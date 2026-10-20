import { request } from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { bytes, dataSnapshot, digest, serialize, string } from '../context-engine/validation.js';
import { natural, slug } from './run-recording.js';
import { shape } from './weekly-delivery-envelope.js';
import { maxTeamsBytes, teamsEntry } from './teams-envelope.js';
import type { TeamsEnvelope } from './teams-envelope.js';

export type TeamsAdapterResult = { readonly status: 'accepted' | 'uncertain' };
/** Opaque capability created only by trusted owner code, never deserialized. */
export interface OwnerTeamsAdapter { readonly destinationId: string; readonly endpointBinding: string }
export interface TeamsWorkflowOptions {
  readonly destinationId: string; readonly webhookUrl: string; readonly bearerToken?: string;
  readonly deadlineMs?: number; readonly maxResponseBytes?: number;
}
/** Trusted test/host seam. Contains secrets: never log, serialize, or expose to model code. */
export interface PrivateTeamsRequest {
  readonly url: string; readonly bearerToken?: string; readonly body: string;
  readonly signal: AbortSignal; readonly maxResponseBytes: number;
}
export type TeamsTransport = (request: PrivateTeamsRequest) => Promise<{ readonly statusCode: number }>;
const adapters = new WeakMap<OwnerTeamsAdapter, (envelope: TeamsEnvelope) => Promise<TeamsAdapterResult>>();
function bound(value: unknown, min: number, max: number): asserts value is number {
  natural(value); if (value < min || value > max) throw new Error('invalid Teams transport bound');
}
/** One HTTPS POST, no redirects/retries, bounded headers/body and total deadline. */
export type TeamsHttpOpen = (url: string, options: RequestOptions, receive: (res: IncomingMessage) => void) => ClientRequest;
export function createTeamsHttpsTransport(open: TeamsHttpOpen = request): TeamsTransport {
  return input => new Promise((resolve, reject) => {
  let settled = false;
  const fail = () => { if (!settled) { settled = true; reject(new Error('Teams transport uncertain')); } };
  const req = open(input.url, {
    method: 'POST', signal: input.signal, agent: false, maxHeaderSize: 8192,
    headers: { 'content-type': 'application/json', 'content-length': bytes(input.body),
      ...(input.bearerToken === undefined ? {} : { authorization: 'Bearer ' + input.bearerToken }) }
  }, res => {
    let received = 0;
    res.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > input.maxResponseBytes) { fail(); res.destroy(); req.destroy(); }
    });
    res.on('error', fail); res.on('aborted', fail);
    res.on('end', () => {
      if (!settled) { settled = true; resolve({ statusCode: res.statusCode ?? 0 }); }
    });
  });
  req.on('error', fail);
  req.end(input.body);
  });
}
const httpsTransport = createTeamsHttpsTransport();
export function createTeamsWorkflowAdapter(raw: TeamsWorkflowOptions, transport: TeamsTransport = httpsTransport): OwnerTeamsAdapter {
  try {
    const v = dataSnapshot(raw);
    shapeOptions(v);
    const url = new URL(v.webhookUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname ||
        url.port && url.port !== '443' || url.pathname === '/' || /[\u0000-\u0020\u007f]/.test(v.webhookUrl)) throw new Error('invalid endpoint');
    const endpoint = url.href, token = v.bearerToken;
    if (token !== undefined) { string(token, 8192); if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('invalid token'); }
    const deadlineMs = v.deadlineMs ?? 10000, maxResponseBytes = v.maxResponseBytes ?? 4096;
    bound(deadlineMs, 10, 30000); bound(maxResponseBytes, 0, 16384);
    if (typeof transport !== 'function') throw new Error('invalid transport');
    const adapter: OwnerTeamsAdapter = Object.freeze({ destinationId: v.destinationId,
      endpointBinding: digest(serialize({ domain: 'teams-workflows-endpoint-v1', endpoint })) });
    adapters.set(adapter, async rawEnvelope => {
      try {
        // Reconstruct the entire envelope before any I/O; endpoint comes only from this closure.
        const safe = dataSnapshot(rawEnvelope);
        const envelope = teamsEntry({ schemaVersion: 1, envelope: safe, status: 'pending', attempts: 0 },
          safe.summary.projectId, safe.summary.originalRoot).envelope;
        if (envelope.destinationId !== adapter.destinationId || envelope.endpointBinding !== adapter.endpointBinding) {
          throw new Error('destination mismatch');
        }
        const body = serialize(envelope.payload);
        if (bytes(body) > maxTeamsBytes || bytes(body) > envelope.payloadBudget) throw new Error('payload bound');
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('Teams deadline')); }, deadlineMs);
          });
          const result = dataSnapshot(await Promise.race([Promise.resolve().then(() => transport({
            url: endpoint, ...(token === undefined ? {} : { bearerToken: token }),
            body, signal: controller.signal, maxResponseBytes
          })), expired]));
          shape(result, ['statusCode']); bound(result.statusCode, 100, 599);
          return dataSnapshot({ status: result.statusCode >= 200 && result.statusCode < 300 ? 'accepted' as const : 'uncertain' as const });
        } finally { if (timer !== undefined) clearTimeout(timer); }
      } catch { return Object.freeze({ status: 'uncertain' as const }); }
    });
    return adapter;
  } catch { throw new Error('Invalid private Teams owner configuration'); }
}
function shapeOptions(v: TeamsWorkflowOptions): void {
  // Required fields plus explicitly optional transport settings.
  const { destinationId, webhookUrl, ...options } = v;
  shape({ destinationId, webhookUrl }, ['destinationId', 'webhookUrl']);
  slug(destinationId); string(webhookUrl, 8192);
  for (const key of Object.keys(options)) {
    if (!['bearerToken', 'deadlineMs', 'maxResponseBytes'].includes(key)) throw new Error('invalid configuration');
  }
}
export function assertTeamsAdapter(adapter: OwnerTeamsAdapter): void {
  if (!adapters.has(adapter)) throw new Error('trusted Teams owner adapter required');
}
export async function sendTeamsEnvelope(adapter: OwnerTeamsAdapter, envelope: TeamsEnvelope): Promise<TeamsAdapterResult> {
  assertTeamsAdapter(adapter);
  return adapters.get(adapter)!(envelope);
}
