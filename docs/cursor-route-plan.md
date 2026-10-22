# Cursor route plan

Status: **Phase 0 complete; Phase 1 implemented ([ADR-0016](adr/ADR-0016-cursor-subscription-route.md), [guide](cursor-route.md)) and validated with one live Auto test task on the Free plan. A live Grok 4.7 run needs a paid or company seat.** Branch `task/cursor-route`, based on `origin/main` at `b0bc462`. Goal: run the same supervised `project:run` workflow used with Claude (plan, code, review, checks, receipts, draft PR) through the owner's Cursor CLI, starting from the existing ACP adapter ([ADR-0011](adr/ADR-0011-cursor-acp-protocol-slice.md), [Cursor driver](cursor-driver.md)). Decision record: [ADR-0016](adr/ADR-0016-cursor-subscription-route.md).

## Owner decisions (2026-10-23)

| Decision | Choice |
|---|---|
| Account | Target: the company Cursor seat, with Other Models allowed when authorized. Now: the personal **Free** plan on this laptop, for testing only. |
| Scope | Phase 0 checks, then Phase 1: plan, coding and review as single calls in `project:run`. A tools coding mode (as Claude Phase 2) is later work. |
| Models | `grok-4.7-high` for plan, coding and review. No `auto`, no fallback, no substitution. |
| Opus planning | Deferred (owner, 2026-10-23). Later option: at the start of each run ForgeMind asks whether to plan with `claude-opus-5-5-high` through Cursor (Other Models), used only on an explicit yes for that run. Phase 0 and Phase 1 use Grok 4.7 only. |
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
5. **One tiny ACP call.** A read-only ask-mode prompt asking for a fixed JSON answer, on `grok-4.7-high` only. Record what the stream reports: the model actually used, usage or plan errors, and how Free-plan limits fail.
6. **Workspace exposure.** Confirm the agent can see only what ForgeMind puts in the prompt: the session runs in scratch, the sandbox denies project reads, and file, terminal and permission callbacks are rejected.

Expected cost: a handful of tiny calls on the Free plan.

## Phase 0 findings (2026-10-23)

Raw evidence stays local under `docs/artifacts/cursor-route/` (gitignored).

1. **Terms.**
   - Cursor's CLI docs describe print mode for "non-interactive scripting and automation" and document browser login and API keys for scripts.
   - The [Terms of Service](https://cursor.com/terms-of-service) §1.5 forbid reverse engineering, scraping, resale, model extraction and training competing models, and letting third parties do so. §3 makes the account holder responsible for all activity.
   - The owner's own account running the owner's tasks on the owner's machine is none of these. Nothing is decompiled: only the shell launcher, which is plain text, was read.
2. **Profile isolation works.**
   - `HOME=~/.forgemind/cursor-profile` together with `AGENT_CLI_CREDENTIAL_STORE=file` started out "Not logged in".
   - The owner ran `cursor-agent login` into it. Status then reported signed in, Free tier.
   - The credential is `<profile>/.cursor/auth.json`, mode 0600. ForgeMind never reads it.
   - The owner's normal login is unaffected.
   - With the file store the launcher skips the system-CA path, so no Keychain access is needed.
3. **Direct launch.**
   - The bundled `node` runs `index.js` directly, so no shell is needed.
   - The version directory is about 623 MB; it holds native modules and worker binaries.
   - The pin must cover the whole directory, not one file.
4. **Sandboxed status, no inference.**
   - `status`, `about` and `models` all work under a deny-default Seatbelt profile.
   - The profile allows: no fork; reads of system paths and the version directory only; writes to scratch and the profile; `*:443` and DNS egress.
   - `models` lists 265 entries, including `grok-4.7-high`.
5. **One tiny call per transport, on `grok-4.7-high`.**
   - **ACP:**
     - It offers Grok 4.7 only as `grok-4.7[context=256k,reasoning_effort=high,fast=true]`; `fast=false` forms are rejected as invalid.
     - On the Free plan it answered "Upgrade your plan to continue" as an ordinary agent message, with stop reason `end_turn` and no error. A plan limit is indistinguishable from an answer.
   - **Print mode** (`-p --mode ask --trust --model grok-4.7-high --output-format stream-json`, sandboxed, cwd an empty scratch):
     - It emitted an init event: `apiKeySource: "login"`, `model: "Grok 4.7 256K High"`, `permissionMode: "default"`.
     - It then failed explicitly with exit 1: `ActionRequiredError: Named models unavailable Free plans can only use Auto.`
     - `--trust` is required even in ask mode. It applies only to that scratch directory. `--force`/`--yolo` are never used.
   - **Decision:** print mode. It fails explicitly, reports the model and the login source, and supports the non-fast model. The ACP adapter is not reused for this route.
6. **Workspace exposure.** Inside the profile, reads of the project, `~/.ssh` and the owner's normal `~/.cursor` all fail with EPERM, and `/bin/sh` cannot be started. The agent sees only the prompt.

**Free plan:** only `Auto` works there. A live Grok 4.7 task needs a paid personal plan or the company seat.

The owner chose an explicit, test-only Auto mode to prove the harness end to end now:
- It is enabled by an owner flag, never by a task or model.
- The model is recorded as `auto`.
- Receipts are marked test-only.
- Draft PRs are refused.

One Auto print-mode call with the prompt on **stdin** succeeded. Its stream was:
- `system/init` with model "Auto", `apiKeySource: "login"` and `permissionMode: "default"`;
- `user`, then `assistant` text;
- `result` with subtype `success`, `is_error: false`, the answer, and `usage` (input, output and cache tokens).

**Retention:** the CLI keeps `chats`, `projects` and `acp-sessions` in the profile, and there is no ephemeral flag. Prompts, including source excerpts, therefore persist in the owner-only profile until removed.

## Phase 1: supervised Cursor ModelPort

| Change | Files |
|---|---|
| Task `provider: "cursor"`; routing: plan/coding/review `grok-4.7-high` | `contracts.ts`, `validation.ts`, `routing-profile.ts` |
| Owner session: dedicated profile, sandboxed status check, account tier | new `cursor-session.ts` |
| `NativeCursorModel`: one pinned print-mode process per call (`-p --mode ask --trust` in scratch, `stream-json`), fixed model checked against the init event, JSON answer validated by the existing plan/coding/review validators, explicit plan-limit and other errors fail closed | new `cursor-cli-model.ts`, `cursor-stream.ts` |
| Personal-plan guard: refuse workspaces outside an owner allowlist (ForgeMind and test repositories) | `cursor-session.ts`, `live-cli.ts` |
| CLI: `project:run --provider cursor --cursor <pinned entry> --cursor-profile <dir>` and `probe:cursor` | `live-cli.ts`, new `cursor-probe.ts` |
| Docs: ADR-0016 and a guide | `docs/` |

Tests: replayed print-mode streams (recorded in Phase 0) for success, refusal, model mismatch, plan-limit errors, malformed JSON, timeout, cancellation and process-tree cleanup; the session and allowlist rules; an end-to-end `runTask` on the Cursor branch. Then one owner-authorized live task on a scratch repository, independent review and a draft PR, as for Claude.

## Known limits (expected)

- Cursor may not report token usage or overage the way Claude Code does; whatever it reports is recorded, and no spend bound is claimed beyond it.
- ACP has no JSON-schema mode; the answer is free text that must parse and validate, or the call fails.
- `*:443` egress cannot be filtered by hostname.
