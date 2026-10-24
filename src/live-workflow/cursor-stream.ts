/** Init `model` labels the reviewed Cursor CLI reports for each routed model id (Phase 0 evidence). */
export const CURSOR_MODEL_LABELS: Readonly<Record<string, string>> = Object.freeze({ 'grok-4.7-high': 'Grok 4.7 256K High', auto: 'Auto' });
export interface CursorStreamResult {
  output: Record<string, unknown>;
  usage: Record<string, number> | null;
  requestId: string | null;
  toolCalls: number;
}
/** The one MCP server and tool names Cursor may call in tools coding mode. */
export interface CursorStreamTools { server: string; names: readonly string[] }
const MAX_LINES = 4096;
const allowedTypes = new Set(['system', 'user', 'thinking', 'assistant', 'result']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const label = (value: unknown) => typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'unlabelled';

/** Fail closed on anything outside the reviewed `cursor-agent -p --mode ask --output-format stream-json`
 * shape: one login-authenticated init on the routed model, text-only answers, one successful final result
 * whose text is a JSON object. Never retries or substitutes. */
export function parseCursorStream(stdout: string, model: string, tools?: CursorStreamTools): CursorStreamResult {
  if (tools !== undefined && (!record(tools) || typeof tools.server !== 'string' || !tools.server || !Array.isArray(tools.names)
    || tools.names.some(name => typeof name !== 'string' || !name))) throw new Error('Cursor tools profile is invalid');
  const expected = CURSOR_MODEL_LABELS[model];
  if (!expected) throw new Error('Cursor model is not reviewed');
  const lines = stdout.split('\n').filter(line => line.trim());
  if (!lines.length || lines.length > MAX_LINES) throw new Error('Cursor stream missing or oversized');
  const events = lines.map(line => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('Malformed Cursor stream'); }
    if (!record(value) || typeof value.type !== 'string' || !(allowedTypes.has(value.type) || (tools && value.type === 'tool_call')))
      throw new Error(`Unreviewed Cursor stream event (${label(record(value) ? value.type : undefined)})`);
    return value;
  });
  const system = events.filter(e => e.type === 'system');
  if (system.length !== 1 || system[0]!.subtype !== 'init' || events[0] !== system[0]) throw new Error('Unreviewed Cursor session start');
  const init = system[0]!;
  if (init.model !== expected) throw new Error('Cursor model mismatch; no substitution');
  // Owner login only: an API key is a different billing and authority route.
  if (init.apiKeySource !== 'login') throw new Error('Cursor credential source is not the owner login');
  if (init.permissionMode !== 'default') throw new Error('Cursor permission mode differs from the reviewed profile');
  // Reasoning models stream thinking before the answer (observed live under Auto); it is never used as output.
  for (const event of events.filter(e => e.type === 'thinking')) {
    const keys = Object.keys(event).filter(key => !['session_id', 'timestamp_ms'].includes(key)).sort().join();
    if (!(event.subtype === 'delta' && keys === 'subtype,text,type' && typeof event.text === 'string')
      && !(event.subtype === 'completed' && keys === 'subtype,type'))
      throw new Error('Unreviewed Cursor thinking event');
  }
  for (const event of events.filter(e => e.type === 'assistant')) {
    const content = record(event.message) ? event.message.content : undefined;
    if (!Array.isArray(content) || content.some(block => !record(block) || block.type !== 'text'))
      throw new Error('Cursor answer contains a tool call or non-text content');
  }
  const results = events.filter(e => e.type === 'result');
  if (results.length !== 1 || events[events.length - 1] !== results[0]) throw new Error('Cursor run has no single final result');
  const result = results[0]!;
  if (result.subtype !== 'success' || result.is_error !== false || typeof result.result !== 'string')
    throw new Error('Cursor run did not complete; no automatic retry or fallback');
  let toolCalls = 0, text = result.result;
  if (tools) {
    for (const event of events.filter(e => e.type === 'tool_call')) if (checkToolCall(event, tools)) toolCalls++;
    const assistants = events.filter(e => e.type === 'assistant');
    if (!assistants.length) throw new Error('Cursor tools stream has no answer');
    const content = (assistants[assistants.length - 1]!.message as { content: Record<string, unknown>[] }).content;
    text = content.map(block => typeof block.text === 'string' ? block.text : '').join('');
    if (!text || !result.result.endsWith(text)) throw new Error('Cursor final answer mismatch');
  }
  return { output: answerObject(text), usage: usage(result.usage), requestId: typeof result.request_id === 'string' ? result.request_id.slice(0, 80) : null, toolCalls };
}
/** Validates one tool_call event; returns whether it is a successful call to a reviewed MCP tool. */
function checkToolCall(event: Record<string, unknown>, tools: CursorStreamTools): boolean {
  const call = event.tool_call;
  const kinds = record(call) ? Object.keys(call).filter(key => key.endsWith('ToolCall')) : [];
  if ((event.subtype !== 'started' && event.subtype !== 'completed') || !record(call) || kinds.length !== 1)
    throw new Error('Unreviewed Cursor tool call event');
  const kind = kinds[0]!, inner = call[kind];
  if (!record(inner) || !record(inner.args)) throw new Error('Unreviewed Cursor tool call event');
  const args = inner.args, result = inner.result, completed = event.subtype === 'completed';
  if (kind === 'getMcpToolsToolCall') {
    if (args.server !== tools.server) throw new Error('Cursor called an unreviewed MCP tool');
    return false;
  }
  if (kind === 'mcpToolCall') {
    if (args.providerIdentifier !== tools.server || typeof args.toolName !== 'string' || !tools.names.includes(args.toolName))
      throw new Error('Cursor called an unreviewed MCP tool');
    return completed && record(result) && record(result.success);
  }
  if (completed && !(record(result) && (result.error !== undefined || result.rejected !== undefined) && result.success === undefined))
    throw new Error('Cursor used a built-in tool');
  return false;
}
/** The answer must be one JSON object; a single surrounding ```json fence is tolerated, prose is not.
 * A plan-limit or upgrade notice therefore fails here instead of passing as an answer. */
function answerObject(text: string): Record<string, unknown> {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1]! : text); } catch { throw new Error('Cursor answer is not the required JSON object'); }
  if (!record(value)) throw new Error('Cursor answer is not the required JSON object');
  return value;
}
function usage(raw: unknown): Record<string, number> | null {
  if (!record(raw)) return null;
  const out: Record<string, number> = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
    if (Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0) out[key] = raw[key] as number;
  return out;
}
/** Event types, in order and capped, for rejection receipts; never content. */
export function cursorStreamShape(stdout: string): string[] {
  return stdout.split('\n').filter(line => line.trim()).slice(0, 64).map(line => {
    try {
      const value: unknown = JSON.parse(line);
      if (!record(value)) return 'invalid';
      return value.subtype === undefined ? label(value.type) : `${label(value.type)}/${label(value.subtype)}`;
    } catch { return 'invalid'; }
  });
}
