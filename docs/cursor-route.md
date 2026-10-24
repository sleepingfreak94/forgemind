# Cursor route

Supervised `project:run` coding (plan, code, review, checks, receipts, draft PR) through your own installed, unmodified Cursor CLI, run as a supervised child. Decision record: [ADR-0016](adr/ADR-0016-cursor-subscription-route.md). Background: [route plan](cursor-route-plan.md). macOS only, from an owner terminal.

## Owner setup

1. Install the Cursor CLI. The route accepts only the reviewed build `2026.10.22-27dcf5f`. Pass its canonical version directory, `~/.local/share/cursor-agent/versions/2026.10.22-27dcf5f`, as `--cursor`. The whole directory is pinned (canonical path, version name and a manifest digest over all its files) and re-verified at every launch. Any other build is refused until it has been reviewed.
2. Create an owner-only profile outside the project, `--state-root` and `--worktree-root`, and sign in yourself:

   ```sh
   mkdir -p -m 700 ~/.forgemind/cursor-profile
   HOME=$HOME/.forgemind/cursor-profile AGENT_CLI_CREDENTIAL_STORE=file <version dir>/cursor-agent login
   ```

   The file credential store keeps the login in the profile and out of the Keychain. ForgeMind passes only paths. It never reads, copies, stores, injects or logs the credential, never passes `--api-key`, and refuses to start when `CURSOR_API_KEY` or `CURSOR_API_ENDPOINT` is set.
3. On a personal plan, list the workspaces allowed to run in `~/.forgemind/cursor-route.json` (mode 600), using canonical paths:

   ```json
   {"schemaVersion":1,"personalWorkspaces":["/canonical/path"]}
   ```

   Company seats on Business, Teams or Enterprise do not need it. Company code needs a company seat and never goes through a personal account; routes are not mixed within a run.
4. Check readiness. This makes no model request:

   ```sh
   npm run probe:cursor -- <version dir> <profile> <workspace>
   ```

## Task manifest and run

Set `"provider": "cursor"` and `"model": "grok-4.7-high"` in the task manifest. The owner routing fixes `grok-4.7-high` for plan, coding and review, checked against the init label. There is no `auto`, no fallback and no substitution. The task provider must match `--provider`.

```sh
npm run project:run -- --workspace /absolute/project --task /absolute/task.json \
  --provider cursor --cursor ~/.local/share/cursor-agent/versions/2026.10.22-27dcf5f \
  --cursor-profile $HOME/.forgemind/cursor-profile \
  --state-root /absolute/private/runs --worktree-root /absolute/private/worktrees
```

`--connection`, `--codex`, `--claude` and `--claude-profile` are rejected on this route. Plan approval, checks, independent review and draft publication are those of the supervised pipeline.

Task splitting also works on this route, in tools or single-call mode; see [task splitting](task-splitting.md).

## Auto test mode

On the Free plan only Auto works, so a Grok 4.7 run needs a paid plan or a company seat. To prove the harness anyway, pass `--cursor-mode test-auto` (the only accepted value) with a task that sets `"model": "auto"`. Auto picks its own model, the model is recorded as `auto`, receipts are marked test-only and draft publication is refused. The terminal shows `TEST MODE: Auto picks the model, nothing is published`.

## What each call does

- One pinned process per call, run as `-p --mode ask --trust --output-format stream-json`, with the prompt on stdin, in an empty per-call scratch directory. `--trust` covers only that scratch; `--force` and `--yolo` are never used.
- Deny-default Seatbelt sandbox: no fork and no Keychain; reads of system paths and the pinned build; writes to scratch and the profile; `*:443` and DNS egress. The project, `~/.ssh` and your normal `~/.cursor` are unreadable. The profile itself, including the login file, stays readable and writable, because the CLI needs it.
- Tool lockdown: before every launch, including the status and about checks, the host writes deny-all tool permissions (`CURSOR_DENY_ALL`: Read and Write of relative and absolute paths, Shell, WebFetch, Mcp) into the profile `.cursor/cli-config.json` and the scratch `.cursor/cli.json`. It replaces each file by temporary file and rename, and refuses a symlinked `.cursor`.
- The stream must show one init with `apiKeySource: login`, text-only answers, thinking events only in their reviewed shape, and one successful result whose text is a JSON object the existing validators accept.
- Plan-limit errors, upgrade notices, tool calls, unknown events and malformed answers fail closed: the task stops with a receipt.

## Tools coding mode

Tools mode lets Cursor explore the repository through ForgeMind host tools. The lockdown above describes single-call mode. In tools mode, the rules below apply.

**Opt in.** Set this in the task manifest:

```json
{ "provider": "cursor", "codingMode": "tools", "maxToolCalls": 16 }
```

Add `"readScope": "repository"` to let the session read the repository, not only `readPaths`. It also works with split tasks.

**How it runs.**

- The process is `cursor-agent -p --mode ask --trust --approve-mcps`.
- The work `.cursor/mcp.json` names one server, `forgemind`. It points at a loopback endpoint (127.0.0.1, secret path).
- Both permission files allow only `Mcp(forgemind:<tool>)` for the granted host tools. They deny all built-ins (Read, Write, Shell, WebFetch).
- The profile `mcp.json` is always reset to no servers.
- The sandbox opens only that loopback port, beyond the existing rules.

**Stream checks.**

- The parser accepts only reviewed `tool_call` events. These are forgemind MCP calls to granted tools, and built-in calls only if Cursor refused them.
- The stream's successful tool-call count must equal the host's count.

**Phase 0 probes** (2026-10-23, Auto test mode, personal Free plan):

- Ask mode called two granted forgemind tools.
- The built-in read of a canary in the profile got "Permission denied". The canary appeared in no output.
- A forgemind tool missing from the allowlist came back "User rejected MCP", even with `--approve-mcps`.

**Live runs** (2026-10-23, Auto test mode, test only):

- Repository read: the task said the tax was far too high and to find the rule in the docs. The rule lives only in `docs/rules/TAX.md`. The planner, without the docs, guessed 0.18. The Cursor tools session explored and set `RATE = 0.125` in 5 host tool calls. The check passed and review passed. The outcome was completed-local, with 3 requests. The git-ignored `.env` never leaked.
- Coupon split task in tools mode: 2 subtasks, each checked, review pass, completed-local, 4 requests.

There is no Grok 4.7 tools-mode run yet.

**Residual risk.** Tools mode relies on Cursor's permission layer honouring allow and deny rules, as the existing lockdown does. This is not a guarantee.

## Limits

- **Credential lockdown and residual risk:** a live canary probe on 2026-10-23 showed that, without the lockdown, ask mode's read tool read a canary file planted in the profile, where the login lives. With the deny-all lockdown, the same probe run through the real route code from an unlocked profile config got "Permission denied" from the read tool, and the canary appeared in no output. This is not a guarantee: it relies on Cursor's own permission layer honouring deny rules, the profile stays readable and writable by the CLI process itself with open `*:443` egress, and tool use is rejected by the stream parser only after a call. Keep this profile dedicated to ForgeMind, and sign out and back in if you suspect misuse.
- Each session is bound to the workspace it was opened for. A personal-plan allowlist check can't be reused for another repository.
- The CLI keeps chats, projects and ACP sessions in the profile, with no ephemeral mode, so prompts that include source excerpts persist there.
- Cursor reports token usage but not cost or overage. No spend bound is claimed.
- Print mode has no JSON-schema option; the answer must parse and validate.
- A CLI update changes the manifest digest and needs a new review.
- Egress cannot be filtered by hostname.
- Opus planning is deferred.
