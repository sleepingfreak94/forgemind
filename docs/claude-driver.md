# Claude subscription route

Supervised `runTask` coding with your own Claude subscription, through the
unmodified Claude Code CLI. Decision record: [ADR-0014](adr/ADR-0014-claude-subscription-route.md).
Spike evidence: [route plan](claude-route-plan.md). macOS only.

## Owner setup

1. Install Claude Code. The route accepts only the reviewed build: version
   `2.1.308`, SHA-256 `ca923c86…4dd37`. Pass its canonical versioned path, for
   example `~/.local/share/claude/versions/2.1.308`. A different build is refused
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
  - at most three turns;
  - usage from the routed model only;
  - overage reported `rejected` and unused;
  - a single successful final result.
- Anything else fails closed: refusals, errors, quota exhaustion, timeouts,
  cancellation, unexpected tools or models, permission denials and source drift.
  There is no retry, no `--fallback-model` and no model substitution.
- Each call reserves one task request and a provider receipt. The receipt records
  the phase, model, effort, prompt and schema hashes, profile hash and pin. Usage
  and the CLI's notional list-price figure are recorded as a `model-usage` phase.

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
- The Claude native route (host tools over MCP) is not implemented yet.
