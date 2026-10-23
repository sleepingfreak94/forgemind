# Claude subscription route

Supervised `runTask` coding with your own Claude subscription, through the
unmodified Claude Code CLI. Decision record: [ADR-0014](adr/ADR-0014-claude-subscription-route.md).
Spike evidence: [route plan](claude-route-plan.md). macOS only.

## Owner setup

1. Install Claude Code. The route accepts only the reviewed build: version
   `2.1.309`, SHA-256 `5eadc000…0619c`. Pass its canonical versioned path, for
   example `~/.local/share/claude/versions/2.1.309`. A different build is refused
   until it has been reviewed.
2. Create an owner-only profile outside every checkout and sign in yourself, using
   Anthropic's own flow:

   ```sh
   mkdir -p -m 700 ~/.forgemind/claude-profile
   CLAUDE_CONFIG_DIR=$HOME/.forgemind/claude-profile claude auth login
   ```

   Claude Code keeps that login in your macOS Keychain under a per-profile entry.
   ForgeMind never reads, copies, stores or forwards it. It passes only the
   directory path to the child process.
3. Check readiness. This makes no inference request:

   ```sh
   npm run probe:claude -- /absolute/claude-binary /absolute/claude-profile
   ```

## Task manifest and run

Set `"provider": "anthropic"` and `"model": "claude-sonnet-5-5"` in the
[task manifest](live-workflow.md#task-manifest). The models are fixed by the owner
routing, not by the task: planning runs on `claude-opus-5-5`, and coding and the
fresh review run on `claude-sonnet-5-5`. `effort` (`low`/`medium`/`high`) is passed
through unchanged.

```sh
npm run project:run -- --workspace /absolute/project --task /absolute/task.json \
  --provider anthropic --claude /absolute/claude-binary --claude-profile /absolute/claude-profile \
  --state-root /absolute/private/runs --worktree-root /absolute/private/worktrees
```

`--connection` and `--codex` are not accepted on this route. Plan review,
isolated worktrees, baseline/candidate checks, browser QA, video delivery and
draft publication behave exactly as on the ChatGPT route.

To split a task into reviewed subtasks, see [task splitting](task-splitting.md).

## What each model call does

- One pinned CLI process per call, under a deny-default Seatbelt profile.
- Disabled: built-in tools, MCP servers, setting sources, slash commands, session
  persistence, telemetry, error reporting, auto-update and non-essential traffic.
- Writes are allowed only to per-call scratch, the Claude profile and the Keychain
  module cache that Claude Code's own credential lookup needs.
- The answer arrives through `--json-schema` structured output.
- The stream must match the reviewed shape:
  - the routed model and pinned version;
  - subscription credentials (`apiKeySource: none`), with telemetry off;
  - only the `StructuredOutput` tool;
  - at most three turns (also passed as `--max-turns`), with CLI retries off and any
    reported retry rejected;
  - no MCP servers, skills, slash commands or unreviewed plugins or agents;
  - no `system` events besides the first `init` (the first event other than
    content-free `ui_invalidate` render hints, accepted anywhere only in their exact
    reviewed shape) and numeric `thinking_tokens` progress estimates; fallback, refusal-fallback and other subtypes fail closed;
  - usage from the routed model only;
  - overage reported `rejected` and unused;
  - a single successful final result with no API error or safety stop.
- Anything else fails closed: refusals, errors, quota exhaustion, timeouts,
  cancellation, unexpected tools or models, permission denials and source drift.
  There is no retry, no `--fallback-model` and no model substitution.
- Each call reserves one task request and a provider receipt. The receipt records
  the phase, model, effort, prompt and schema hashes, profile hash and pin. Usage
  and the CLI's notional list-price figure are recorded as a `model-usage` phase; a
  failed or rejected call records its status fields and the reason.
- The profile must sit outside the project, `--state-root` and `--worktree-root`.
  Per-call scratch is removed after each call.

## Tools coding mode

This is a separate, opt-in mode ([ADR-0014](adr/ADR-0014-claude-subscription-route.md)
Phase 2). The bullets above about disabled MCP servers describe the default
single-call mode.

- **Opt in.** Set `"codingMode": "tools"` and `"maxToolCalls"` (1 to 64) in the
  task manifest. It works on the Claude route only. Planning and the fresh review
  stay single structured-output calls.

  ```json
  { "provider": "anthropic", "model": "claude-sonnet-5-5", "codingMode": "tools", "maxToolCalls": 16 }
  ```

- **Tools.** The coding phase becomes one Sonnet session whose only tools are:
  - `host_read`: reads one granted read or write path and returns its path, sha256
    and content (null for an absent file);
  - `host_apply`: applies edits in the same formats and with the same validator as
    a single-call answer, against granted write paths only;
  - `host_check`: runs one predefined check by id, after the checks listed before
    it in the task.

  Calls run one at a time.
- **Transport and sandbox.** ForgeMind serves these tools from a local MCP endpoint
  named `forgemind` on 127.0.0.1, with a random port and a secret path. Besides the
  CLI's own HTTPS, the Claude sandbox may reach only that loopback port. Built-in
  tools stay off. `--safe-mode` is not used in this mode because it disables MCP.
- **Failures.** A rejected call that leaves source and authority intact is returned
  to Claude as a tool error so it can correct it. These end the session and fail
  the task, with no retry: budget exhaustion (tool calls or tool-result bytes),
  source changes made outside the host tools, cancellation, and a lost authority.
  A session that applies no edits also fails.
- **Checks on the stream and records.** The stream must report the connected
  `forgemind` server and a tool-call count equal to the host's; the host count is
  authoritative. Every apply is recorded as a `tool-apply` phase with before and
  after source. The reviewed result is the final Git diff.
- **Real builds and tests.** Combine this mode with
  [ADR-0015](adr/ADR-0015-node-project-checks.md) `node-project` checks so
  `host_check` can run real builds and tests.

## Limits

- `maxModelRequests` counts CLI invocations. Upstream request count, full prompt
  bytes and raw response bytes cannot be observed without a broker, and no bound
  on them is claimed.
- Subscriptions have no hard spend cap. The overage check runs after a request has
  started: a run that reports overage is discarded, but its usage may already have
  been incurred.
- Egress cannot be filtered by hostname: the child may reach any `*:443` host and
  DNS.
- `maxOutputBytes` covers the whole stream-json output, including about 5 KiB of
  session metadata per call.
- A tools session counts as one ForgeMind request regardless of its turns. Host
  tool calls are bounded by `maxToolCalls` and the prompt byte budget
  (`maxPromptBytes`, which also covers tool results).
