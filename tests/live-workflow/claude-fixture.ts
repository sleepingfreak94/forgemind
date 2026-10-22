import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openClaudeSubscriptionSession, pinClaudeConformanceCli } from '../../src/live-workflow/claude-session.js';
import type { ClaudeCli, ClaudeRunner } from '../../src/live-workflow/claude-session.js';
import type { ProcessRequest } from '../../src/live-workflow/process.js';

/** Recorded Phase 0 stream shape for one structured answer; overrides patch individual events. */
export function claudeStream(model: string, output: unknown, patch: {
  init?: Record<string, unknown>; result?: Record<string, unknown>; limit?: Record<string, unknown>; extra?: unknown[]; toolName?: string;
} = {}): string {
  const events: unknown[] = [
    { type: 'system', subtype: 'init', model, claude_code_version: '2.1.308', apiKeySource: 'none', analytics_disabled: true,
      tools: ['StructuredOutput'], mcp_servers: [], permissionMode: 'default', slash_commands: [], skills: [],
      agents: ['claude', 'Explore', 'general-purpose', 'Plan'],
      plugins: [{ name: 'cc-plugin-agents-md', path: 'builtin' }, { name: 'cc-plugin-plugin-authoring', path: 'builtin' }],
      session_id: 'fixture', ...patch.init },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_fixture', name: patch.toolName ?? 'StructuredOutput', input: output }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: 'Structured output provided successfully' }] } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled',
      isUsingOverage: false, ...patch.limit } },
    ...(patch.extra ?? []),
    { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', stop_reason: 'tool_use', num_turns: 2,
      api_error_status: null, safety_stops: 0,
      structured_output: output, result: JSON.stringify(output), permission_denials: [], total_cost_usd: 0.01,
      usage: { input_tokens: 2, output_tokens: 73 }, modelUsage: { [model]: { inputTokens: 2, outputTokens: 73 } }, ...patch.result },
  ];
  return events.map(event => JSON.stringify(event)).join('\n') + '\n';
}

/* Native stand-in for the pinned CLI: it runs under the real Claude Seatbelt profile, which
 * cannot exec an interpreter. Call N replays $CLAUDE_CONFIG_DIR/stream-N.jsonl and records
 * argv and environment names; `hang` forks a child and sleeps; `fail` exits 1. */
const FAKE_SOURCE = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
extern char **environ;
static const char *dir;
static FILE *at(const char *name, const char *mode) { char p[4096]; snprintf(p, sizeof p, "%s/%s", dir, name); return fopen(p, mode); }
static int exists(const char *name) { FILE *f = at(name, "r"); if (f) fclose(f); return f != NULL; }
static void replay(const char *name) {
  FILE *f = at(name, "r"); char b[65536]; size_t n;
  if (!f) { fprintf(stderr, "fixture missing %s\n", name); exit(3); }
  while ((n = fread(b, 1, sizeof b, f)) > 0) fwrite(b, 1, n, stdout);
  fclose(f);
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--version")) { puts("2.1.308 (Claude Code)"); return 0; }
  if (!(dir = getenv("CLAUDE_CONFIG_DIR"))) return 4;
  if (argc == 3 && !strcmp(argv[1], "auth") && !strcmp(argv[2], "status")) { replay("status.json"); return 0; }
  char b[65536]; while (fread(b, 1, sizeof b, stdin) > 0) {}
  int n = 0; FILE *c = at("count", "r"); if (c) { fscanf(c, "%d", &n); fclose(c); }
  n++; c = at("count", "w"); fprintf(c, "%d", n); fclose(c);
  char name[64]; snprintf(name, sizeof name, "args-%d", n); FILE *a = at(name, "w");
  for (int i = 1; i < argc; i++) fprintf(a, "%s%c", argv[i], 0); fclose(a);
  snprintf(name, sizeof name, "env-%d", n); a = at(name, "w");
  for (char **e = environ; *e; e++) { const char *eq = strchr(*e, '='); fprintf(a, "%.*s\n", (int)(eq ? eq - *e : (long)strlen(*e)), *e); }
  fclose(a);
  if (exists("hang")) {
    pid_t child = fork();
    if (child == 0) { for (;;) pause(); }
    FILE *p = at("child.pid", "w"); fprintf(p, "%d", child); fclose(p);
    for (;;) pause();
  }
  snprintf(name, sizeof name, "stream-%d.jsonl", n); replay(name);
  if (exists("fail")) { fputs("fixture failure\n", stderr); return 1; }
  return 0;
}
`;
let compiled: ClaudeCli | undefined;
/** Pinned fake CLI, compiled once per test process; production pins only the reviewed build. */
export function fakeCli(): ClaudeCli {
  if (compiled) return compiled;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-claude-bin-')));
  writeFileSync(join(root, 'fake.c'), FAKE_SOURCE);
  const path = join(root, 'claude');
  execFileSync('/usr/bin/cc', ['-O1', '-o', path, join(root, 'fake.c')]);
  chmodSync(path, 0o755);
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  return compiled = pinClaudeConformanceCli(path, { version: '2.1.308', versionOutput: '2.1.308 (Claude Code)', sha256 });
}

/** False when the fake CLI compiles and pins; otherwise why Claude fake-CLI tests are skipped. */
export const fakeCliSkip: string | false = (() => {
  try { fakeCli(); return false; } catch { return 'Claude fake CLI needs a working C compiler (/usr/bin/cc)'; }
})();

/** Owner-only profile directory plus a session opened through `auth status`: replayed by
 * default, or through the real sandboxed fake when `supervised` is set. */
export async function fixtureSession(status: Record<string, unknown> = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' },
  options: { supervised?: boolean; cli?: ClaudeCli } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fm-claude-')));
  const profile = realpathSync(mkdtempSync(join(root, 'p-'))); chmodSync(profile, 0o700);
  const scratch = realpathSync(mkdtempSync(join(root, 's-')));
  writeFileSync(join(profile, 'status.json'), JSON.stringify(status));
  const requests: ProcessRequest[] = [];
  const replayed: ClaudeRunner = async request => { requests.push(request); return { stdout: JSON.stringify(status), stderr: '', code: 0 }; };
  const session = await openClaudeSubscriptionSession({ profileDirectory: profile, cli: options.cli ?? fakeCli(), scratchRoot: scratch,
    ...(options.supervised ? {} : { runner: replayed }) });
  return { root, profile, scratch, session, requests };
}
/** Arguments the fake CLI received on call `n`. */
export const fakeArgs = (profile: string, n: number) => readFileSync(join(profile, `args-${n}`), 'utf8').split('\0').slice(0, -1);
export const fakeEnv = (profile: string, n: number) => readFileSync(join(profile, `env-${n}`), 'utf8').trim().split('\n');
