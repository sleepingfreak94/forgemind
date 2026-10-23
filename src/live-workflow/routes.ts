import { NativeCodexModel } from './provider.js';
import { NativeClaudeModel } from './claude-cli-model.js';
import { NativeCursorModel } from './cursor-cli-model.js';
import { assertClaudeSession, assertPinnedClaudeCli } from './claude-session.js';
import { assertCursorSession, assertPinnedCursorCli } from './cursor-session.js';
import { assertChatGPTPlanSession } from './chatgpt-plan.js';
import { CURSOR_TEST_MODEL } from './routing-profile.js';
import type { ClaudeCli, ClaudeSubscriptionSession } from './claude-session.js';
import type { CursorCli, CursorSubscriptionSession } from './cursor-session.js';
import type { ChatGPTPlanSession } from './chatgpt-plan.js';
import type { CheckRuntime } from './check-runtime.js';
import type { RunAuthority } from './authority.js';
import type { LiveTask, ModelPort } from './contracts.js';

/** Owner-supplied model routes; never read from a task manifest, project files or model output. */
export interface RouteOptions {
  /** The run's workspace; route sessions bound to a workspace must match it. */
  workspace?: string;
  /** Required for the ChatGPT/Codex route only. */
  codexExecutable?: string;
  /** Dependency injection for conformance tests; CLI never accepts executable model plugins. */
  modelFactory?: (authority: RunAuthority, source: () => string) => ModelPort;
  /** Authenticated owner-reviewed subscription route. */
  planSession?: ChatGPTPlanSession;
  /** Owner-selected node_modules for ADR-0015 node-project checks. */
  checkRuntime?: CheckRuntime;
  /** Owner's Claude sign-in plus the pinned CLI (ADR-0014). */
  claude?: { cli: ClaudeCli; session: ClaudeSubscriptionSession };
  /** Owner's Cursor sign-in plus the pinned CLI (docs/cursor-route-plan.md); `testAuto` is the owner's Auto test mode. */
  cursor?: { cli: CursorCli; session: CursorSubscriptionSession; testAuto?: boolean };
  /** Present when the run may publish a draft PR. */
  publication?: unknown;
}

/** Exactly one of fixture, ChatGPT, Claude or Cursor routes; the task provider must match a production route. */
export function assertSingleRoute(options: RouteOptions, task: LiveTask): void {
  const routes = [options.modelFactory, options.planSession, options.claude, options.cursor].filter(Boolean).length;
  if (!routes)
    throw new Error(
      'Live requests blocked: subscription-only use is not enforceable. No worktree or provider request was created.',
    );
  if (routes > 1) throw new Error('Production and fixture dependencies cannot be combined');
  if (options.planSession) {
    assertChatGPTPlanSession(options.planSession);
    if (task.provider === 'anthropic' || task.provider === 'cursor') throw new Error('Task provider does not match the ChatGPT route');
    if (!options.codexExecutable) throw new Error('Codex executable required for the ChatGPT route');
  }
  if (options.claude) {
    assertClaudeSession(options.claude.session);
    assertPinnedClaudeCli(options.claude.cli);
    if (task.provider !== 'anthropic') throw new Error('Task provider does not match the Claude route');
  }
  if (options.cursor) {
    assertCursorSession(options.cursor.session);
    assertPinnedCursorCli(options.cursor.cli);
    if (!options.workspace) throw new Error('The Cursor route needs the run workspace');
    options.cursor.session.assertWorkspace(options.workspace);
    if (task.provider !== 'cursor') throw new Error('Task provider does not match the Cursor route');
    // Auto picks its own model: owner-enabled test runs only, and never published.
    if ((task.model === CURSOR_TEST_MODEL) !== (options.cursor.testAuto === true))
      throw new Error('Cursor Auto requires the owner test mode, and the test mode requires an Auto task');
    if (options.cursor.testAuto && (task.draftPr || options.publication)) throw new Error('Cursor Auto test runs cannot publish');
  }
  if (task.checks.some(c => c.profile === 'node-project') && !options.checkRuntime)
    throw new Error('node-project checks require an owner-selected --node-modules');
}

export function routeModel(options: RouteOptions, task: LiveTask, authority: RunAuthority, source: () => string): ModelPort {
  if (options.modelFactory) return options.modelFactory(authority, source);
  if (options.claude) return new NativeClaudeModel({ cli: options.claude.cli, task, authority, source, session: options.claude.session });
  if (options.cursor) return new NativeCursorModel({ cli: options.cursor.cli, task, authority, source, session: options.cursor.session,
    ...(options.cursor.testAuto ? { testAuto: true } : {}) });
  return new NativeCodexModel({ executable: options.codexExecutable!, task, authority, source,
    ...(options.planSession ? { planSession: options.planSession } : {}) });
}

export const routeName = (options: RouteOptions) => options.claude ? 'Claude' : options.cursor ? 'Cursor' : 'Codex';
