# ADR-0014: Claude subscription route through the unmodified Claude Code CLI

- Status: Accepted for planning; implementation gated on Phase 0 evidence
- Date: 2026-10-22
- Basis: owner decisions to use their own Claude subscription through the Claude Code CLI and to fail closed on refusals; Anthropic's [Claude Code legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance) as read on 2026-10-22
- Plan: [Claude subscription route plan](../claude-route-plan.md)

## Decision

Add Claude as a coding provider by running the owner's installed, unmodified Claude Code CLI as a supervised child process. Pin it by canonical path, exact version and SHA-256. Use the owner's own Claude subscription. There is no API-key route or fallback.

The owner signs in through Claude Code's own flow, into a dedicated profile directory outside every checkout (default `~/.forgemind/claude-profile`, owner-only). ForgeMind passes only that directory path to the child. ForgeMind never reads, copies, stores, injects, logs or relays a Claude OAuth token, `setup-token` output or Keychain item. No ForgeMind proxy sits on the authenticated request path, so the ChatGPT-route broker is not reused. Each user brings their own subscription; ForgeMind never shares a seat.

Each invocation disables every built-in tool, all MCP servers except a ForgeMind-supplied one where a route needs host functions, all setting sources, slash commands, session persistence, telemetry, error reporting, auto-update and non-essential traffic. `--bare` is not used because it rejects subscription login. The model has no file, shell or network authority of its own. Repository reads, edits and checks stay with ForgeMind's existing trusted adapters and receipts.

Refusals, unavailable models, schema mismatches, quota exhaustion and errors stop the task with a receipt. `--fallback-model` and server-side fallbacks are never enabled. Each run must observably report subscription overage as rejected and unused. Otherwise the result is discarded and the task stops.

Two integration points are planned: a Claude `ModelPort` for the supervised `runTask` route, then a Claude native route that exposes exactly `host_read`, `host_apply` and `host_check` over a ForgeMind stdio MCP server.

## Consequences and limits

- With no broker, ForgeMind cannot count upstream provider requests or bound full prompt and raw response bytes. Like the native executor's `unavailableNativeMetrics`, these limits must be reported, not claimed.
- Subscriptions have no hard spend cap. The overage check is observed after a request starts, so it detects use beyond the plan; it does not prevent it.
- Seatbelt cannot filter egress by hostname. The child gets TLS egress plus whatever Keychain access Claude Code needs to read its own credential.
- `--json-schema` is delivered as a synthetic `StructuredOutput` tool call, so one answer costs two turns. Turn budgets must account for this.
- A Claude Code update changes the pin. The terms review and Phase 0 invocation checks must be repeated before the new version is accepted.
- If Anthropic's terms stop permitting this use, the route stays blocked. No automatic switch to another credential type happens.

## Validation

Phase 0 evidence is recorded in the plan; raw output stays local under `docs/artifacts/claude-route/`. Implementation requires deterministic tests against a fake CLI that replays recorded stream output, covering refusal, schema mismatch, truncation, quota, timeout, cancellation, process-tree cleanup, source drift and overage-status rejection. It also requires a no-inference `probe:claude`, one owner-authorized live task, independent review and a draft PR.
