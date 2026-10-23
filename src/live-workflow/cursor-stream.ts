/** Init `model` labels the reviewed Cursor CLI reports for each routed model id (Phase 0 evidence). */
export const CURSOR_MODEL_LABELS: Readonly<Record<string, string>> = Object.freeze({ 'grok-4.7-high': 'Grok 4.7 256K High', auto: 'Auto' });
export interface CursorStreamResult {
  output: Record<string, unknown>;
  usage: Record<string, number> | null;
  requestId: string | null;
}
const MAX_LINES = 4096;
const allowedTypes = new Set(['system', 'user', 'thinking', 'assistant', 'result']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const label = (value: unknown) => typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'unlabelled';

/** Fail closed on anything outside the reviewed `cursor-agent -p --mode ask --output-format stream-json`
 * shape: one login-authenticated init on the routed model, text-only answers, one successful final result
 * whose text is a JSON object. Never retries or substitutes. */
export function parseCursorStream(stdout: string, model: string): CursorStreamResult {
  const expected = CURSOR_MODEL_LABELS[model];
  if (!expected) throw new Error('Cursor model is not reviewed');
  const lines = stdout.split('\n').filter(line => line.trim());
  if (!lines.length || lines.length > MAX_LINES) throw new Error('Cursor stream missing or oversized');
  const events = lines.map(line => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('Malformed Cursor stream'); }
    if (!record(value) || typeof value.type !== 'string' || !allowedTypes.has(value.type))
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
  return { output: answerObject(result.result), usage: usage(result.usage), requestId: typeof result.request_id === 'string' ? result.request_id.slice(0, 80) : null };
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
