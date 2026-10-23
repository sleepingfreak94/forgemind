# ADR-0016: Cursor route through the owner's pinned Cursor CLI

- Status: Accepted; supervised route implemented and validated with one live Auto test task on the Free plan; Grok 4.7 live run pending a paid or company seat
- Date: 2026-10-23
- Basis: owner decisions in the [Cursor route plan](../cursor-route-plan.md); Cursor's [Terms of Service](https://cursor.com/terms-of-service) and [headless CLI docs](https://cursor.com/docs/cli/headless) as read on 2026-10-23

## Decision

Add Cursor as a `project:run` provider (`--provider cursor`) by running the owner's installed, unmodified Cursor CLI as a supervised child. The plan, plan approval, checks, independent review and draft publication stay those of the supervised pipeline.

- **Pin.**
  - The whole version directory is pinned: canonical path, version name and a manifest digest over all 437 files.
  - The bundled `node` runs `index.js` directly, with no shell launcher.
  - The pin is re-verified at every launch, and each session is bound to the CLI it was opened with.
- **Credentials.**
  - The owner signs in with Cursor's own `cursor-agent login` into a dedicated owner-only profile (`HOME`). The file credential store (`AGENT_CLI_CREDENTIAL_STORE=file`) keeps the login there and out of the Keychain.
  - ForgeMind passes only paths. It never reads, copies, stores, injects or logs the credential, never passes `--api-key`, and refuses to start when `CURSOR_API_KEY` or `CURSOR_API_ENDPOINT` is set.
- **Transport.** Print mode, not ACP: `-p --mode ask --trust --output-format stream-json`, with the prompt on stdin, in an empty per-call scratch directory. Phase 0 found three reasons:
  - ACP offers Grok 4.7 only as its fast variant;
  - ACP returned a Free-plan upgrade notice as an ordinary answer;
  - print mode fails explicitly and reports the model and the login source.

  `--trust` covers only that scratch directory, and `--force`/`--yolo` are never used.
- **Sandbox.** Deny-default Seatbelt:
  - no fork and no Keychain;
  - reads of system paths and the pinned build;
  - writes to scratch and the profile only;
  - `*:443` and DNS egress.

  The project, `~/.ssh` and the owner's normal `~/.cursor` are unreadable. ForgeMind sends only the prompt.

  The profile is the exception. The CLI must read its own login (`.cursor/auth.json`) and keeps its state there, so the sandbox can read and write the whole profile, and egress is open to any `*:443` host. A live canary probe on 2026-10-23 showed that, without the lockdown, ask mode's read tool read a canary file planted in the profile, where the login lives.

  The host therefore locks tools down. Before every launch, including the status and about checks, it writes deny-all permissions (`CURSOR_DENY_ALL`: Read and Write of relative and absolute paths, Shell, WebFetch and Mcp) into the profile `.cursor/cli-config.json` and the scratch `.cursor/cli.json` (in the per-call work directory). It replaces each file by temporary file and rename, so links planted by the sandboxed CLI are never followed, and it refuses a symlinked `.cursor`. With the lockdown, the same probe, run through the real route code from an unlocked profile config, got "Permission denied" from the read tool, and the canary did not appear in any output.

  Each `.cursor` directory must be a real directory owned by the current user and not group or world writable, and it is re-checked after locking.

  Owner-run live probes on 2026-10-23 used the real launch path (the Seatbelt sandbox plus the deny-all locks written by `lockCursorPermissions`):
  - a shell tool call to echo a marker failed with `spawn EPERM` and nothing ran, because the no-fork sandbox blocked it;
  - a web fetch tool call was rejected with "User Rejected" by the deny-all permissions;
  - an MCP probe could only list Cursor's built-in tool catalog (names and descriptions) and called no tool.

  What remains: the catalog listing is a residual (metadata only, with no file or network access). The protection relies on Cursor's own permission layer honouring deny rules. The profile stays readable and writable by the CLI process itself, with open `*:443` egress. The stream parser rejects tool events only after the call, so it detects tool use without preventing it.
- **Routing.** `grok-4.7-high` for plan, coding and review, owner-fixed and checked against the init label. There is no `auto`, no fallback and no substitution.
- **Fail closed.** The stream must show:
  - one init with `apiKeySource: login`;
  - text-only answers;
  - thinking events only in their reviewed shape;
  - one successful result whose text is a JSON object that the existing validators accept.

  Plan-limit errors, upgrade notices, tool calls, unknown events and malformed answers stop the task with a receipt.
- **Account boundary.** `about` reports the plan tier, and each session is bound to the workspace it was checked for. On a personal tier (anything but Business, Teams or Enterprise), only workspaces listed in the owner's `~/.forgemind/cursor-route.json` may run. Company code needs a company seat. Company code never goes through personal accounts, and routes are not mixed within a run.
- **Auto test mode.** With `--cursor-mode test-auto`, the owner may run an `auto` task:
  - Auto picks its own model, so receipts are marked test-only;
  - draft publication is refused.

  It exists to prove the harness on a Free plan.
- **Tools coding mode (2026-10-23).** With `"codingMode": "tools"`, a Cursor task can explore the repository through host tools.
  - The process is `cursor-agent -p --mode ask --trust --approve-mcps`.
  - The work `.cursor/mcp.json` names one server, `forgemind`, at a loopback endpoint (127.0.0.1, secret path).
  - Both permission files allow only `Mcp(forgemind:<tool>)` for the granted host tools. They deny all built-ins (Read, Write, Shell, WebFetch).
  - The profile `mcp.json` is always reset to no servers. The sandbox opens only that loopback port.
  - The stream parser accepts only reviewed `tool_call` events: forgemind MCP calls to granted tools, and built-in calls only if Cursor refused them.
  - The stream's successful tool-call count must equal the host's.
  - `readScope: "repository"` and task splitting work with it.

  Phase 0 probes (2026-10-23, Auto test mode, personal Free plan): ask mode called two granted forgemind tools. The built-in read of a canary in the profile got "Permission denied", and the canary appeared in no output. A forgemind tool missing from the allowlist came back "User rejected MCP", even with `--approve-mcps`.

  Live runs (2026-10-23, Auto test mode, test only): the repository-read task, where the rule lives only in `docs/rules/TAX.md`. The planner without the docs guessed 0.18. The tools session set `RATE = 0.125` in 5 host tool calls. Check and review passed, the outcome was completed-local with 3 requests, and the git-ignored `.env` never leaked. The coupon split task ran 2 subtasks, each checked, review pass, completed-local, 4 requests.

## Consequences and limits

- The deny-all tool lockdown is implemented and was probed (see Sandbox); that follow-up is done. A residual credential risk remains: protection relies on Cursor's own permission layer honouring deny rules, the profile stays readable and writable by the CLI process with open `*:443` egress, and tool use is rejected by the stream parser only after a call. The shell, web fetch and MCP probes are recorded (see Sandbox); the MCP catalog listing is a residual that exposes metadata only, with no file or network access.
- Tools mode has the same residual risk. It relies on Cursor's permission layer honouring the allow and deny rules, and the stream parser detects misuse only after a call. Evidence is from Auto test mode on a Free plan only.
- The CLI keeps chats, projects and ACP sessions in the profile; there is no ephemeral mode. Prompts, which include source excerpts, persist in the owner-only profile.
- Cursor reports token usage but not cost or overage. No spend bound is claimed. Other Models and usage-based pricing on a company seat are governed by the account, not by ForgeMind.
- Print mode has no JSON-schema option. The answer is free text that must parse and validate.
- A CLI update changes the manifest digest. The route refuses the new build until it is reviewed again.
- Opus planning through Cursor is deferred.
