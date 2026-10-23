# ADR-0014: Claude subscription route through the unmodified Claude Code CLI

- Status: Accepted; Phase 0 evidence complete; supervised route (Phase 1) and tools coding mode (Phase 2) implemented, each validated with one live task
- Date: 2026-10-22
- Basis: owner decisions to use their own Claude subscription through the Claude Code CLI and to fail closed on refusals; Anthropic's [Claude Code legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance) as read on 2026-10-22
- Plan: [Claude subscription route plan](../claude-route-plan.md)

## Decision

Add Claude as a coding provider by running the owner's installed, unmodified Claude Code CLI as a supervised child process. Pin it by canonical path, exact version and SHA-256. Use the owner's own Claude subscription. There is no API-key route or fallback.

The owner signs in through Claude Code's own flow, into a dedicated profile directory outside every checkout (default `~/.forgemind/claude-profile`, owner-only). ForgeMind passes only that directory path to the child. ForgeMind never reads, copies, stores, injects, logs or relays a Claude OAuth token, `setup-token` output or Keychain item. No ForgeMind proxy sits on the authenticated request path, so the ChatGPT-route broker is not reused. Each user brings their own subscription; ForgeMind never shares a seat.

Each invocation disables every built-in tool, all MCP servers except a ForgeMind-supplied one where a route needs host functions, all setting sources, slash commands, session persistence, telemetry, error reporting, auto-update and non-essential traffic. `--bare` is not used because it rejects subscription login. `--safe-mode` is not used on routes with host tools because it disables MCP servers; isolation relies on the dedicated profile, empty setting sources, strict MCP configuration and a scratch working directory. The model has no file, shell or network authority of its own. Repository reads, edits and checks stay with ForgeMind's existing trusted adapters and receipts.

Model routing is fixed by the owner, not selected by a task: planning uses `claude-opus-5-5`; coding, the native coding session and the fresh review use `claude-sonnet-5-5`. Effort comes from the task.

Refusals, unavailable models, schema mismatches, quota exhaustion and errors stop the task with a receipt. `--fallback-model` and server-side fallbacks are never enabled. Each call passes `--max-turns` and turns CLI retries off, and a reported retry is rejected. On a 401 the CLI emitted two `api_retry` events despite `CLAUDE_CODE_MAX_RETRIES=0`, so that setting is not fully honoured; the parser's rejection of `api_retry` is the guard. Each run must observably report subscription overage as rejected and unused. Otherwise the result is discarded and the task stops.

Two integration points exist: a Claude `ModelPort` for the supervised `runTask` route, and a tools coding mode in that same pipeline (Phase 2), where one Sonnet session drives exactly `host_read`, `host_apply` and `host_check` through a ForgeMind MCP endpoint. That endpoint runs in the trusted host over HTTP on `127.0.0.1` with a random port and secret path, not as a stdio child inside the Claude sandbox. The sandbox may reach only that loopback port besides the CLI's own HTTPS. Planning, plan approval, candidate checks, the fresh review and publication are unchanged.

Phase 2 is built into `runTask`, not the Codex native executor. That executor's runner is bound to the ChatGPT session, the Codex app-server and its broker. The provider-neutral pieces are reused through the supervised authority:
- the exact path and check grants;
- the edit validator;
- the check runner;
- receipts.

A tools session keeps the run authority bound to its starting source, because a provider receipt cannot span authority source changes. Each apply records its before and after tree sources, and the host verifies the tree before every call.

## Consequences and limits

- With no broker, ForgeMind cannot count upstream provider requests or bound full prompt and raw response bytes. Like the native executor's `unavailableNativeMetrics`, these limits must be reported, not claimed.
- Subscriptions have no hard spend cap. The overage check is observed after a request starts, so it detects use beyond the plan; it does not prevent it.
- Seatbelt cannot filter egress by hostname. The child gets TLS egress plus whatever Keychain access Claude Code needs to read its own credential.
- Only the Keychain additions to the profile were bisected. The system base (preference reads, cfprefs, logging and notification services) is broader than strictly needed; the child has no tools, and narrowing it is open work.
- `--json-schema` is delivered as a synthetic `StructuredOutput` tool call, so one answer costs two turns. Turn budgets must account for this.
- A Claude Code update changes the pin. The terms review and Phase 0 invocation checks must be repeated before the new version is accepted.
- If Anthropic's terms stop permitting this use, the route stays blocked. No automatic switch to another credential type happens.
- In tools mode `--safe-mode` is off, because it disables MCP. Isolation relies on:
  - the dedicated profile;
  - empty setting sources;
  - strict MCP configuration;
  - an exact tool inventory;
  - the stream checks: a connected `forgemind` server only, and a tool-call count equal to the host's.
- Without `--safe-mode` the CLI lists one more built-in agent, `statusline-setup`. No agent is callable.

## Validation

Phase 0 evidence is recorded in the plan; raw output stays local under `docs/artifacts/claude-route/`. Phase 1 is covered by:

- a compiled fake CLI run under the real Claude Seatbelt profile, covering:
  - sign-in, flags and environment;
  - binary drift;
  - cancellation and timeout with process-tree cleanup;
  - the output limit and CLI failure;
  - a full `runTask` through the production branch;
- replayed streams for refusal, missing answers, retries, configuration drift, quota errors, safety stops and overage;
- a no-inference `probe:claude`;
- one owner-authorized live task: plan on Opus, code and review on Sonnet, completed with 3 requests and overage rejected each time.

Phase 2 is covered by:
- tools-host tests: grants, rejected-versus-fatal calls, budgets, outside drift, cancellation, and a full tools-mode `runTask` holding a provider receipt across applies;
- MCP endpoint tests: protocol, loopback host and origin refusal, size and batch limits, and stop on fatal;
- `codeWithTools` tests: arguments, loopback-only egress, tool-call accounting, and failure paths;
- one owner-authorized live tools-mode task: Opus plan, a Sonnet session with 5 turns and 3 host calls, Sonnet review, 3 requests, overage rejected.

Owner-run live re-pin evidence, 2026-10-23, for Claude Code 2.1.309:
- all route flags are present;
- sandboxed calls complete with `apiKeySource` `none` and overage rejected;
- both 2.1.308 and 2.1.309 intermittently emit `system/ui_invalidate` `{event: "ui.render"}` before init, and the parser accepts it only in that exact shape;
- on a 401 the CLI emitted two `api_retry` events despite `CLAUDE_CODE_MAX_RETRIES=0`, so the parser rejection of `api_retry` is the guard.

Independent review and draft PRs follow `AGENTS.md`.
