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

  What remains: the protection relies on Cursor's own permission layer honouring deny rules. The profile stays readable and writable by the CLI process itself, with open `*:443` egress. The stream parser rejects tool events only after the call, so it detects tool use without preventing it.
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

## Consequences and limits

- The deny-all tool lockdown is implemented and was probed (see Sandbox); that follow-up is done. A residual credential risk remains: protection relies on Cursor's own permission layer honouring deny rules, the profile stays readable and writable by the CLI process with open `*:443` egress, and tool use is rejected by the stream parser only after a call. Possible follow-up:
  - recorded evidence that ask mode exposes no file or web tool.
- The CLI keeps chats, projects and ACP sessions in the profile; there is no ephemeral mode. Prompts, which include source excerpts, persist in the owner-only profile.
- Cursor reports token usage but not cost or overage. No spend bound is claimed. Other Models and usage-based pricing on a company seat are governed by the account, not by ForgeMind.
- Print mode has no JSON-schema option. The answer is free text that must parse and validate.
- A CLI update changes the manifest digest. The route refuses the new build until it is reviewed again.
- Opus planning through Cursor is deferred. A Cursor tools coding mode, like ADR-0014 Phase 2, is not implemented.
