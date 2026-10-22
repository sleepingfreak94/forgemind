import { isDeepStrictEqual } from 'node:util';

/** Facts the trusted host expects from one pinned Claude Code `-p --output-format stream-json` run. */
export interface ClaudeStreamExpectation {
  model: string;
  version: string;
  /** Exact tool inventory the CLI must report; structured output alone is ['StructuredOutput']. */
  tools: readonly string[];
  maxTurns: number;
}
export interface ClaudeStreamResult {
  output: Record<string, unknown>;
  numTurns: number;
  /** Notional list-price figure reported by the CLI; not a subscription charge. */
  listCostUsd: number | null;
  usage: unknown;
}

const MAX_LINES = 4096;
const MAX_USAGE_BYTES = 4096;
/** Built-ins the reviewed 2.1.308 reports under `--safe-mode`; none is callable without tools. */
const REVIEWED_PLUGINS = ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'];
const REVIEWED_AGENTS = new Set(['claude', 'Explore', 'general-purpose', 'Plan']);
const allowedTypes = new Set(['system', 'assistant', 'user', 'rate_limit_event', 'result']);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Fail closed on anything outside the reviewed stream shape. Never retries or substitutes. */
export function parseClaudeStream(stdout: string, expected: ClaudeStreamExpectation): ClaudeStreamResult {
  const lines = stdout.split('\n').filter(line => line.trim());
  if (!lines.length || lines.length > MAX_LINES) throw new Error('Claude stream missing or oversized');
  const events = lines.map(line => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('Malformed Claude stream'); }
    if (!record(value) || typeof value.type !== 'string' || !allowedTypes.has(value.type))
      throw new Error('Unreviewed Claude stream event');
    return value;
  });
  const system = events.filter(e => e.type === 'system');
  if (system.some(e => e.subtype === 'api_retry')) throw new Error('Claude CLI retried a request; no automatic retry');
  if (system.length !== 1 || system[0]!.subtype !== 'init' || events[0] !== system[0]) throw new Error('Unreviewed Claude session start');
  const session = system[0]!;
  if (session.model !== expected.model) throw new Error('Claude model mismatch; no substitution');
  if (session.claude_code_version !== expected.version) throw new Error('Claude CLI version mismatch');
  // Subscription login only: an API key or third-party provider is a different billing route.
  if (session.apiKeySource !== 'none') throw new Error('Claude credential source is not the owner subscription');
  if (session.analytics_disabled !== true) throw new Error('Claude telemetry was not disabled');
  if (!Array.isArray(session.tools) || !isDeepStrictEqual([...session.tools].sort(), [...expected.tools].sort()))
    throw new Error('Claude tool inventory differs from the reviewed set');
  const plugins = Array.isArray(session.plugins) ? session.plugins.map(p => record(p) && p.path === 'builtin' ? p.name : undefined) : undefined;
  if (!isDeepStrictEqual(session.mcp_servers, []) || !isDeepStrictEqual(session.skills, []) || !isDeepStrictEqual(session.slash_commands, [])
    || session.permissionMode !== 'default' || !isDeepStrictEqual(plugins && [...plugins].sort(), REVIEWED_PLUGINS)
    || !Array.isArray(session.agents) || !session.agents.every(agent => REVIEWED_AGENTS.has(String(agent))))
    throw new Error('Claude session configuration differs from the reviewed profile');
  for (const event of events.filter(e => e.type === 'assistant')) {
    const content = record(event.message) ? event.message.content : undefined;
    if (!Array.isArray(content)) throw new Error('Malformed Claude message');
    for (const block of content)
      if (record(block) && block.type === 'tool_use' && !expected.tools.includes(String(block.name)))
        throw new Error('Claude called an unreviewed tool');
  }
  const limits = events.filter(e => e.type === 'rate_limit_event');
  if (!limits.length) throw new Error('Claude overage status unavailable');
  for (const event of limits) {
    const info = record(event.rate_limit_info) ? event.rate_limit_info : {};
    if (info.overageStatus !== 'rejected' || info.isUsingOverage !== false)
      throw new Error('Claude usage beyond the plan is not observably disabled');
  }
  const results = events.filter(e => e.type === 'result');
  if (results.length !== 1 || events[events.length - 1] !== results[0]) throw new Error('Claude run has no single final result');
  const result = results[0]!;
  if (result.subtype !== 'success' || result.is_error !== false || result.terminal_reason !== 'completed' || result.stop_reason === 'refusal'
    || result.api_error_status !== null || result.safety_stops !== 0)
    throw new Error('Claude run did not complete; no automatic retry or fallback');
  if (!Array.isArray(result.permission_denials) || result.permission_denials.length)
    throw new Error('Claude run reported permission denials');
  if (!Number.isSafeInteger(result.num_turns) || (result.num_turns as number) < 1 || (result.num_turns as number) > expected.maxTurns)
    throw new Error('Claude turn limit');
  if (!record(result.modelUsage) || !isDeepStrictEqual(Object.keys(result.modelUsage), [expected.model]))
    throw new Error('Claude usage reports an unexpected model');
  if (!record(result.structured_output)) throw new Error('Claude returned no structured output');
  const cost = result.total_cost_usd;
  const usage = record(result.usage) && Buffer.byteLength(JSON.stringify(result.usage)) <= MAX_USAGE_BYTES ? result.usage : null;
  return {
    output: result.structured_output,
    numTurns: result.num_turns as number,
    listCostUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
    usage,
  };
}

/** Status fields of a failed run's final result, for the receipt; never model text. */
export function claudeFailureSummary(stdout: string): Record<string, string | number | boolean | null> | null {
  const last = stdout.trimEnd().split('\n').at(-1);
  let value: unknown;
  try { value = JSON.parse(last ?? ''); } catch { return null; }
  if (!record(value) || value.type !== 'result') return null;
  const summary: Record<string, string | number | boolean | null> = {};
  for (const key of ['subtype', 'is_error', 'terminal_reason', 'stop_reason', 'api_error_status', 'num_turns']) {
    const field = value[key];
    if (field === null || typeof field === 'boolean' || typeof field === 'number' || typeof field === 'string' && field.length <= 80) summary[key] = field;
  }
  return summary;
}
