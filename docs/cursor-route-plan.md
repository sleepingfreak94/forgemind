# Cursor route plan

Status: **plan; Phase 0 not started.** Branch `task/cursor-route`, based on `origin/main` at `b0bc462`. Goal: run the same supervised `project:run` workflow used with Claude (plan, code, review, checks, receipts, draft PR) through the owner's Cursor CLI, starting from the existing ACP adapter ([ADR-0011](adr/ADR-0011-cursor-acp-protocol-slice.md), [Cursor driver](cursor-driver.md)). A decision record (ADR-0016) follows Phase 0, as ADR-0014 did for Claude.

## Owner decisions (2026-10-23)

| Decision | Choice |
|---|---|
| Account | Target: the company Cursor seat, with Other Models allowed when authorized. Now: the personal **Free** plan on this laptop, for testing only. |
| Scope | Phase 0 checks, then Phase 1: plan, coding and review as single calls in `project:run`. A tools coding mode (as Claude Phase 2) is later work. |
| Models | `grok-4.7-high` for plan, coding and review. No `auto`, no fallback, no substitution. |
| Opus planning | At the start of each run ForgeMind asks whether to plan with `claude-opus-5-5-high` through Cursor (Other Models). Only an explicit yes for that run uses it; the default is Grok 4.7. |
| Code allowed | While signed in to the personal plan: only ForgeMind and test repositories. Company repositories are refused until the company seat is configured. |
| Data boundary | Company code never goes through the personal Claude subscription or the personal Cursor account. Routes are not mixed within a run. |

## Starting point (observed 2026-10-23, no inference)

- Installed CLI `cursor-agent` **2026.10.22-27dcf5f**; the ACP adapter was written against `2026.07.09-a3815c0`, so this build needs its own review and pin.
- The launcher is a bash script that runs a bundled `node` with `index.js` in the version directory. The pin should be that direct entry point and its files, so the sandbox needs no shell.
- `-p` (print mode) "has access to all tools, including write and shell"; it is unusable unless restricted. `--mode ask` and ACP ask mode are read-only. `cursor-agent acp` starts the ACP server.
- Credentials: `cursor-agent login` (browser), `--api-key` / `CURSOR_API_KEY`, and a credential store that can be the macOS Keychain or a file (`AGENT_CLI_CREDENTIAL_STORE=file`).
- Signed in as the owner's personal account, **Subscription Tier: Free**. `cursor-agent models` lists `grok-4.7-high` and `claude-opus-5-5-high`; listing does not prove the Free plan may use them.

## Credential boundary

Same rule as the Claude route: the owner signs in with Cursor's own `cursor-agent login`, into a dedicated ForgeMind profile outside every checkout. ForgeMind never reads, copies, stores, injects, logs or relays a Cursor token, API key or Keychain item, never passes `--api-key`, and refuses to start when `CURSOR_API_KEY` or `CURSOR_API_ENDPOINT` is set. Phase 0 step 1 checks Cursor's terms for this use first; if they do not permit it, the route stays blocked.

## Phase 0: checks (owner-authorized, minimal usage)

1. **Terms.** Read Cursor's current terms and CLI documentation for scripted CLI/ACP use on an individual and a team seat. Record the conclusion and links.
2. **Profile isolation.** Find how to give the CLI a private profile (HOME/XDG or a config variable) so ForgeMind never uses the owner's normal `~/.cursor` state. The owner runs `cursor-agent login` into it. Decide between Keychain and the file credential store inside the owner-only profile.
3. **Pin and direct launch.** Pin the bundled `node`, `index.js` and version files by path, version and hash. Launch `node index.js acp` directly under a deny-default Seatbelt profile: no shell, scratch-only writes, `*:443` egress.
4. **Sandboxed status, no inference.** `status`, `about` and `models` inside the sandbox: signed in, plan tier, and the model list.
5. **One tiny ACP call per model.** A read-only ask-mode prompt asking for a fixed JSON answer, on `grok-4.7-high` (and `claude-opus-5-5-high` only if the owner authorizes that call). Record what the stream reports: the model actually used, usage or plan errors, and how Free-plan limits fail.
6. **Workspace exposure.** Confirm the agent can see only what ForgeMind puts in the prompt: the session runs in scratch, the sandbox denies project reads, and file, terminal and permission callbacks are rejected.

Expected cost: a handful of tiny calls on the Free plan.

## Phase 1: supervised Cursor ModelPort

| Change | Files |
|---|---|
| Task `provider: "cursor"`; routing: plan/coding/review `grok-4.7-high`, or plan `claude-opus-5-5-high` for an authorized run | `contracts.ts`, `validation.ts`, `routing-profile.ts` |
| Owner session: dedicated profile, sandboxed status check, account tier, Opus prompt per run | new `cursor-session.ts` |
| `NativeCursorModel`: one pinned ACP process per call, ask mode, fixed model, JSON answer validated by the existing plan/coding/review validators, fail closed on anything else | new `cursor-cli-model.ts`, reusing `agent-drivers/cursor*.ts` |
| Personal-plan guard: refuse workspaces outside an owner allowlist (ForgeMind and test repositories) | `cursor-session.ts`, `live-cli.ts` |
| CLI: `project:run --provider cursor --cursor <pinned entry> --cursor-profile <dir>` and `probe:cursor` | `live-cli.ts`, new `cursor-probe.ts` |
| Docs: ADR-0016 and a guide | `docs/` |

Tests: replayed ACP streams for success, refusal, model mismatch, plan-limit errors, malformed JSON, timeout, cancellation and process-tree cleanup; the session and allowlist rules; an end-to-end `runTask` on the Cursor branch. Then one owner-authorized live task on a scratch repository, independent review and a draft PR, as for Claude.

## Known limits (expected)

- Cursor may not report token usage or overage the way Claude Code does; whatever it reports is recorded, and no spend bound is claimed beyond it.
- ACP has no JSON-schema mode; the answer is free text that must parse and validate, or the call fails.
- `*:443` egress cannot be filtered by hostname.
