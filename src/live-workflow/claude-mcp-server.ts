import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CodingToolResult } from './coding-tools.js';

export interface McpTool { name: string; description: string; inputSchema: object }
export interface McpEndpoint {
  readonly url: string;
  readonly port: number;
  /** Error that ended the session; the caller stops the client and fails closed. */
  readonly fatal: Error | undefined;
  readonly calls: number;
  close(): Promise<void>;
}
const MAX_BODY = 4194304;
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** Minimal MCP streamable-HTTP server for exactly the given tools, on 127.0.0.1 with an
 * unguessable path. Answers JSON only; no SSE stream, sessions, resources or prompts. */
export async function startMcpEndpoint(tools: readonly McpTool[], call: (name: string, args: unknown) => Promise<CodingToolResult>,
  onFatal: (error: Error) => void): Promise<McpEndpoint> {
  const secret = randomBytes(24).toString('base64url');
  const names = new Set(tools.map(t => t.name));
  let fatal: Error | undefined, calls = 0, port = 0;
  const fail = (error: unknown) => { fatal ??= error instanceof Error ? error : new Error('MCP session failed'); onFatal(fatal); };
  const reply = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // Loopback only: refuse DNS-rebinding hosts and browser origins outright.
    if (req.url !== `/mcp/${secret}` || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== undefined) return reply(res, 404);
    if (req.method !== 'POST') return reply(res, 405);
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return reply(res, 413);
      chunks.push(chunk as Buffer);
    }
    let message: Record<string, unknown>;
    try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400); }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') return reply(res, 400);
    const { id, method } = message, params = (message.params ?? {}) as Record<string, unknown>;
    if (id === undefined) return reply(res, 202);
    const ok = (result: unknown) => reply(res, 200, { jsonrpc: '2.0', id, result });
    const error = (code: number, text: string) => reply(res, 200, { jsonrpc: '2.0', id, error: { code, message: text } });
    if (method === 'initialize') {
      const requested = params.protocolVersion;
      return ok({ protocolVersion: typeof requested === 'string' && PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'forgemind', version: '1' } });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools });
    if (method !== 'tools/call') return error(-32601, 'Method not found');
    if (fatal) return error(-32000, 'Session stopped');
    const name = params.name;
    if (typeof name !== 'string' || !names.has(name)) return error(-32602, 'Unknown tool');
    calls++;
    try {
      const result = await call(name, params.arguments ?? {});
      return ok({ content: [{ type: 'text', text: result.text }], isError: result.isError });
    } catch (e) {
      fail(e);
      return error(-32000, 'Session stopped');
    }
  };
  const server = createServer((req, res) => { handle(req, res).catch(e => { fail(e); if (!res.headersSent) reply(res, 500); }); });
  server.headersTimeout = 10000; server.requestTimeout = 60000; // bounds receiving a request, not a long host_check reply
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('MCP endpoint did not bind');
  port = address.port;
  return {
    url: `http://127.0.0.1:${port}/mcp/${secret}`, port,
    get fatal() { return fatal; }, get calls() { return calls; },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
