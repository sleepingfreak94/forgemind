import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openClaudeSubscriptionSession } from '../../src/live-workflow/claude-session.js';
import type { ClaudeCli, ClaudeRunner } from '../../src/live-workflow/claude-session.js';
import type { ProcessRequest } from '../../src/live-workflow/process.js';

/** Recorded Phase 0 stream shape for one structured answer; overrides patch individual events. */
export function claudeStream(model: string, output: unknown, patch: {
  init?: Record<string, unknown>; result?: Record<string, unknown>; limit?: Record<string, unknown>; extra?: unknown[]; toolName?: string;
} = {}): string {
  const events: unknown[] = [
    { type: 'system', subtype: 'init', model, claude_code_version: '2.1.308', apiKeySource: 'none', analytics_disabled: true,
      tools: ['StructuredOutput'], mcp_servers: [], session_id: 'fixture', ...patch.init },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_fixture', name: patch.toolName ?? 'StructuredOutput', input: output }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: 'Structured output provided successfully' }] } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false, ...patch.limit } },
    ...(patch.extra ?? []),
    { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', stop_reason: 'tool_use', num_turns: 2,
      structured_output: output, result: JSON.stringify(output), permission_denials: [], total_cost_usd: 0.01,
      usage: { input_tokens: 2, output_tokens: 73 }, modelUsage: { [model]: { inputTokens: 2, outputTokens: 73 } }, ...patch.result },
  ];
  return events.map(event => JSON.stringify(event)).join('\n') + '\n';
}
export const fakeCli: ClaudeCli = { path: '/fixture/claude', version: '2.1.308', sha256: '0'.repeat(64) };
/** Owner-only profile directory plus a session opened through a replayed `auth status`. */
export async function fixtureSession(status: Record<string, unknown> = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-claude-')));
  const profile = realpathSync(mkdtempSync(join(root, 'p-'))); chmodSync(profile, 0o700);
  const scratch = realpathSync(mkdtempSync(join(root, 's-')));
  const requests: ProcessRequest[] = [];
  const runner: ClaudeRunner = async request => { requests.push(request); return { stdout: JSON.stringify(status), stderr: '', code: 0 }; };
  const session = await openClaudeSubscriptionSession({ profileDirectory: profile, cli: fakeCli, scratchRoot: scratch, runner });
  return { root, profile, scratch, session, requests };
}
