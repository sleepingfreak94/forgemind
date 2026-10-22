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

## Auto test mode

On the Free plan only Auto works, so a Grok 4.7 run needs a paid plan or a company seat. To prove the harness anyway, pass `--cursor-mode test-auto` (the only accepted value) with a task that sets `"model": "auto"`. Auto picks its own model, the model is recorded as `auto`, receipts are marked test-only and draft publication is refused. The terminal shows `TEST MODE: Auto picks the model, nothing is published`.

## What each call does

- One pinned process per call, run as `-p --mode ask --trust --output-format stream-json`, with the prompt on stdin, in an empty per-call scratch directory. `--trust` covers only that scratch; `--force` and `--yolo` are never used.
- Deny-default Seatbelt sandbox: no fork and no Keychain; reads of system paths and the pinned build; writes to scratch and the profile; `*:443` and DNS egress. The project, `~/.ssh` and your normal `~/.cursor` are unreadable. The profile itself, including the login file, stays readable and writable, because the CLI needs it.
- The stream must show one init with `apiKeySource: login`, text-only answers, thinking events only in their reviewed shape, and one successful result whose text is a JSON object the existing validators accept.
- Plan-limit errors, upgrade notices, tool calls, unknown events and malformed answers fail closed: the task stops with a receipt.

## Limits

- **Residual credential risk:** a prompt-injected model with a file-read or web tool in ask mode could read the login in the profile, which the sandbox must leave readable, and send it to any `*:443` host. Tool use is rejected only after the call. Keep this profile dedicated to ForgeMind, and sign out and back in if you suspect misuse.
- Each session is bound to the workspace it was opened for. A personal-plan allowlist check can't be reused for another repository.
- The CLI keeps chats, projects and ACP sessions in the profile, with no ephemeral mode, so prompts that include source excerpts persist there.
- Cursor reports token usage but not cost or overage. No spend bound is claimed.
- Print mode has no JSON-schema option; the answer must parse and validate.
- A CLI update changes the manifest digest and needs a new review.
- Egress cannot be filtered by hostname.
- Opus planning is deferred, and there is no tools coding mode.
