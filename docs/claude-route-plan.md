# Claude subscription route plan

Status: **planning; Phase 0 in progress.** Decision record: [ADR-0014](adr/ADR-0014-claude-subscription-route.md). Branch `task/claude-cli-route`, based on
`origin/main` at `ba295e9`. No Claude route exists yet: `project:run` and the
native owner CLI accept only the Codex/ChatGPT connection.

## Owner decisions

- Billing: the owner's own Claude subscription through the unmodified Claude Code
  CLI. No API-key fallback.
- Refusals and unavailable models fail closed with a receipt. `--fallback-model`
  and server-side refusal fallbacks are never enabled.
- Model routing (owner-fixed, not task-selectable): planning uses
  `claude-opus-5-5`; coding and the fresh review use `claude-sonnet-5-5`. Effort
  comes from the task. An unavailable model stops the phase; it is never replaced.

## Credential boundary (Phase 0 step 1 result)

Anthropic's [Claude Code legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance)
permit "an end user signing in to the unmodified Claude Code binary with their own
Claude subscription", and state that developers "may not collect, store, or
intermediate Claude.ai credentials or session tokens — sign-in to a Claude account
must complete through Anthropic's own flow." The binary must not be modified and its
built-in authentication methods must not be removed or restricted. Pro/Max limits
assume ordinary, individual use.

Consequences for ForgeMind:

- ForgeMind never reads, copies, stores, injects or logs a Claude OAuth token,
  including `CLAUDE_CODE_OAUTH_TOKEN` and `setup-token` output. The owner signs in
  with Claude Code's own flow; Claude Code keeps its own credentials.
- No proxy is placed on the authenticated request path. The Codex-style broker
  (`provider.ts`) is **not** reused for this route.
- Each user brings their own subscription; ForgeMind never shares a seat.
- `--bare` is unusable: it accepts only API keys and ignores OAuth.
- Re-check these terms whenever the pinned CLI changes. If they change, the route
  stays blocked; no automatic switch to another credential happens.

Without a broker, ForgeMind cannot independently count provider requests or bound
full prompt and raw response bytes. This matches the native executor's documented
`unavailableNativeMetrics`; the route must report the same limits, not claim them.

## Integration points

ForgeMind has two coding routes on current `main`:

1. **Supervised** `runTask` route: `ModelPort.complete(instructions, input, schema,
   signal)` returns plan/edit/review JSON. The model has no tools; trusted adapters
   apply edits. Coupled to `ChatGPTPlanSession` at `orchestrator.ts:59-61, 70,
   163-169, 433-438`.
2. **Native executor** route: the agent reasons and calls exactly `host_read`,
   `host_apply`, `host_check` (`native-executor-tools.ts`). `NativeTask.model` is
   fixed to `gpt-6.1-sol`.

Phase 1 adds a Claude `ModelPort` (smaller, reuses all supervised gates). Phase 2
adds a Claude native route that exposes the three host functions through a
ForgeMind stdio MCP server, with every built-in Claude Code tool disabled.

## Phase 0: spikes (owner-authorized, small subscription usage)

1. ~~Terms~~ — done above.
2. **Owner sign-in isolation.** Confirm a dedicated `CLAUDE_CONFIG_DIR` signed in
   by the owner via `claude auth login` (Anthropic's flow) works headless, and where
   Claude Code keeps that credential on macOS (file vs Keychain). Compare with the
   default profile plus `--safe-mode`. ForgeMind must not read the credential.
3. **Isolated invocation.** Verify with the pinned binary:
   `claude -p --output-format stream-json --verbose --json-schema <schema>
   --model <phase model> --effort <effort> --tools "" --strict-mcp-config
   --mcp-config '{"mcpServers":{}}' --setting-sources "" --disable-slash-commands
   --no-session-persistence --permission-prompts none --system-prompt <text>`,
   input on stdin. Record where structured output appears, and the refusal,
   quota-exhausted, invalid-schema and cancellation shapes.
4. **Network and sandbox.** Seatbelt cannot filter by hostname. Determine the
   minimal profile (binary, config dir, scratch, Keychain/securityd if needed, TLS
   egress) and which non-inference traffic can be disabled by environment
   (auto-updater, telemetry, non-essential traffic).
5. **Extra usage.** Identify the Claude account setting that prevents usage beyond
   the plan; it becomes a remembered owner acknowledgement, like the ChatGPT
   credits acknowledgement. ForgeMind cannot inspect it.
6. **Host tools over MCP (for Phase 2).** Confirm `--tools ""` plus
   `--allowedTools mcp__forgemind__host_read,...` exposes only those functions.

Evidence goes to `docs/artifacts/claude-route/` (gitignored, local only). Any failed
spike blocks the route and is reported; it is not worked around.

### Step 3 first probe (2026-10-22)

Pinned binary `~/.local/share/claude/versions/2.1.308`, SHA-256
`ca923c86ac84b30574a82331a05b6e066c27477a926ceaffe46a845a33e4dd37`. One call with
the step 3 flags plus `--safe-mode`, the owner's existing login, an empty scratch
working directory and effort `low`. Raw output: `step3-structured-output.jsonl`,
SHA-256 `6da8800f3e6ac5cb47239dd28f90b7e5fbf85625b6a421c91926527c9b66f2b7`.

- Exit 0, `result.subtype: success`, `terminal_reason: completed`.
  `result.structured_output` held the schema-valid object.
- `apiKeySource: none`, so the subscription login was used. No API key involved.
- The only tool offered was `StructuredOutput`. `--json-schema` is implemented as a
  synthetic tool call, so one answer costs `num_turns: 2` and ends with
  `stop_reason: tool_use`. Budgets must count this.
- MCP servers, skills and slash commands were empty. Built-in plugins still loaded
  (`cc-plugin-telemetry`, `cc-plugin-agents-md`, `cc-plugin-plugin-authoring`), and
  `analytics_disabled: false`. Step 4 must disable telemetry and non-essential
  traffic through the environment and verify.
- The CLI opened a messaging socket under `/tmp/cc-socks/`, outside the scratch
  directory. The Seatbelt profile must handle or redirect this.
- `rate_limit_event` reported `overageStatus: rejected`,
  `overageDisabledReason: org_level_disabled`, `isUsingOverage: false`. ForgeMind can
  fail closed on every run unless overage is observably rejected and unused, without
  touching credentials. This reading arrives only after a request has started.
- Usage and notional list-price cost (`costBasis: list`) are reported per run for
  receipts. List price is not a subscription charge.

### Steps 2 and 4 progress (2026-10-22)

- Dedicated profile `~/.forgemind/claude-profile` (mode 700). The owner signed in
  with `CLAUDE_CONFIG_DIR=… claude auth login`, Anthropic's own browser flow.
  `auth status` reports `loggedIn: true`, `authMethod: claude.ai`. The owner's default
  profile is unaffected.
- Claude Code stores the credential in the macOS login Keychain under a
  per-profile service name (`Claude Code-credentials-<suffix>`), not in the profile
  directory. Claude Code reads it by spawning `/usr/bin/security`. ForgeMind must
  let the child run that executable, and must not read the item itself.
- Environment that held under Seatbelt: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR` (the
  CLI otherwise writes to fixed `/tmp/claude-<uid>`), `DISABLE_TELEMETRY`,
  `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. With these, `analytics_disabled` and
  `product_feedback_disabled` were true, the telemetry plugin did not load, and no
  messaging socket was opened.
- With a deny-default profile, the CLI reported "Not logged in" and sent no
  inference request. `security` inside that profile failed with "A Module Directory
  Service error". It succeeded once file writes were broadly allowed, so the Keychain
  stack needs at least one writable path the profile does not grant.
- **Resolved by narrowing with sandboxed `claude auth status`** (login yes/no only,
  no inference, no direct Keychain queries). Changing one permission class at a
  time, the minimal additions to the deny-default base profile are:
  - `process-exec` of `/usr/bin/security`;
  - `file-read*` of `/private/var/db/mds`, `/Library/Keychains`,
    `~/Library/Keychains`, and `<DARWIN_USER_CACHE_DIR>/mds`;
  - `file-write*` of `<DARWIN_USER_CACHE_DIR>/mds` only. Symlinks must be resolved:
    Seatbelt matches `/private/var/folders/…`, not `/var/folders/…`;
  - `mach-lookup` of `com.apple.system.opendirectoryd.membership`, beyond the base
    list (SecurityServer, trustd, opendirectoryd.libinfo, DNS, cfprefsd).
  The base still allows TLS egress to any `*:443` and DNS, because hostnames cannot
  be filtered.
- With that profile, the sandboxed ForgeMind profile completed one structured call
  each on `claude-sonnet-5-5` and `claude-opus-5-5` at effort `low`. Both succeeded
  with schema-valid output, `num_turns: 2`, `analytics_disabled: true`, no messaging
  socket, and overage `rejected`/unused. Opus 5.5 is available on the owner's Pro
  plan. Local evidence: `claude-min.sb` (SHA-256 `ca2624ce…`),
  `step4-sandboxed-sonnet.jsonl` (`11f602d9…`), `step4-sandboxed-opus.jsonl`
  (`65ad2a5b…`).
- Steps 2 and 4 are done. Remaining in Phase 0: step 6, host tools over MCP.

## Phase 1: supervised Claude ModelPort

| Change | Files |
|---|---|
| Task `provider: "openai" \| "anthropic"` (default `openai`); for `anthropic` the per-phase models are fixed by the owner routing below, not by the task | `contracts.ts`, `validation.ts` |
| Per-phase routing: plan → `claude-opus-5-5`; coding and review → `claude-sonnet-5-5`. The orchestrator currently shares one `ModelPort` across plan (`orchestrator.ts:178`), coding (`:268`) and review (`:307`); it must request a port per phase | `routing-profile.ts`, `orchestrator.ts` |
| `NativeClaudeModel`: one pinned CLI process per call, schema output, bounded stdout/runtime, source-drift and cancellation checks, fail-closed refusals, receipts with observed usage | new `src/live-workflow/claude-cli-model.ts` |
| Pin binary by realpath, exact `--version` and SHA-256 (currently `~/.local/share/claude/versions/2.1.308`) | `claude-cli-model.ts`, `host-enforcement/manifest.ts` |
| Claude Seatbelt profile | `process.ts` |
| Owner session: dedicated config dir path, extra-usage acknowledgement, no token access | new `claude-plan.ts` |
| Orchestrator accepts either session type | `orchestrator.ts` |
| CLI: `project:run --provider anthropic --claude /canonical/claude --claude-config /private/dir` | `live-cli.ts` |
| Readiness reporting per provider | `readiness.ts`, `scripts/doctor.mjs` |

## Phase 2: Claude native route

Claude Code with built-in tools disabled and a ForgeMind stdio MCP server exposing
`host_read`, `host_apply`, `host_check` backed by existing `nativeTool` authority,
checkpoints and receipts. Generalize `NativeTask.model` to a reviewed per-provider
catalog; the native coding session uses `claude-sonnet-5-5`.

## Tests and acceptance

- Fake `claude` executable replaying recorded stream-json (no provider requests):
  schema mismatch, refusal, truncation, quota error, timeout, cancellation and
  process-tree cleanup, source drift, full `runTask` on the Claude route.
- `probe:claude`: version/hash pin and sandbox startup, no inference.
- Existing suites, `typecheck` and `verify:portable` stay green.
- One owner-authorized live task on a scratch project, before/after evidence,
  independent review, draft PR per `AGENTS.md`.

## Known limits

- No hard provider request count or full prompt/response byte bound (no broker).
- No hard spend cap on a subscription; relies on the owner's extra-usage setting.
- CLI updates require re-running Phase 0 steps 3–6 and the terms check.
