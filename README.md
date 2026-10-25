# ForgeMind

ForgeMind is a local-first harness for supervised AI coding. It brings project memory, explicit permissions, isolated edits, checks, and review evidence into one workflow around a coding agent.

**Status: early technical preview.** Supervised execution works on macOS through three routes: ChatGPT/Codex, a Claude subscription (pinned Claude Code CLI) and a Cursor subscription (pinned Cursor CLI build `2026.10.22-27dcf5f`). Each has verification gaps, described in the linked docs. Windows and Linux enforcement are unavailable. Linux containment is planned. Start with the offline demo.

It gives you project memory with citations, isolated worktrees, explicit grants, durable receipts, validated edits, baseline/candidate checks, a fresh review, draft PRs, and a central brain shared by Claude Code, Cursor and the harness.

[Contributing](docs/contributing.md) · [Architecture](docs/architecture.md) · [MIT license](LICENSE)

## Try the offline demo

Requires **Node.js 26.7.0 or newer** and Git.

```bash
git clone https://github.com/sleepingfreak94/forgemind.git
cd forgemind
npm ci
npm run verify:portable
npm run demo:codex
```

The demo makes no provider requests. On Windows, see [Windows setup](docs/windows.md).

## Project onboarding and visible plans

Register your project once with `npm run project:init -- --workspace /absolute/path/to/project --project-id project-a`. This sets plan approval, draft PR and evidence preferences. Add `--new` to scaffold draft PRD/SRS/ADR templates. `npm run project:plan` prepares a supplied plan. `npm run project:prepare` also onboards an unfamiliar project. See [workflow instructions](docs/project-workflow.md), [project memory](docs/project-memory.md) and [execution and evidence](docs/live-workflow.md). For document memory, run `npm run memory -- ingest --workspace /absolute/path/to/project`.

## Run the harness on your project (Claude or Cursor)

macOS only. Run every command from an owner terminal in the ForgeMind checkout. Run `npm ci` first. Details: [Claude route](docs/claude-driver.md), [Cursor route](docs/cursor-route.md).

### 1. Sign in once, into a private profile

Claude. The pinned build is `2.1.309`, for example `~/.local/share/claude/versions/2.1.309`.

```sh
mkdir -p -m 700 ~/.forgemind/claude-profile
CLAUDE_CONFIG_DIR=~/.forgemind/claude-profile <pinned claude> auth login
npm run probe:claude -- <pinned claude> $HOME/.forgemind/claude-profile
```

Cursor. The version directory is `~/.local/share/cursor-agent/versions/2026.10.22-27dcf5f`.

```sh
mkdir -p -m 700 ~/.forgemind/cursor-profile
HOME=$HOME/.forgemind/cursor-profile AGENT_CLI_CREDENTIAL_STORE=file <version dir>/cursor-agent login
```

On a personal Cursor plan, also list your project in `~/.forgemind/cursor-route.json` (mode 600, canonical path):

```json
{"schemaVersion":1,"personalWorkspaces":["/canonical/path/to/project"]}
```

Check readiness (no model request): `npm run probe:cursor -- <version dir> $HOME/.forgemind/cursor-profile /canonical/path/to/project`

A 401 means: log out and log in again in that profile. ForgeMind never reads these logins.

### 2. Register the project

`npm run project:init -- --workspace /absolute/path/to/project --project-id project-a`

### 3. Write a task manifest

Save it outside the project, for example `/absolute/task.json`:

```json
{
  "schemaVersion": 1,
  "taskId": "add-discount",
  "objective": "Add discount(subtotal, code) in src/discount.js as described in docs/COUPONS.md.",
  "readPaths": ["docs/COUPONS.md", "src/pricing.js"],
  "writePaths": ["src/discount.js", "src/pricing.js"],
  "checks": [{ "id": "unit", "executable": "/absolute/path/to/node", "args": ["--test"], "timeoutMs": 120000, "profile": "node-project" }],
  "model": "claude-sonnet-5-5", "provider": "anthropic", "effort": "medium",
  "maxModelRequests": 4, "maxPromptBytes": 262144, "maxOutputBytes": 2097152, "maxRuntimeMs": 900000,
  "draftPr": false,
  "codingMode": "tools", "maxToolCalls": 16,
  "readScope": "repository",
  "split": true
}
```

For Cursor use `"provider": "cursor"` and `"model": "grok-4.7-high"` (paid plan or company seat). On the Free plan use `"model": "auto"` with test mode below. Paths in `readPaths` and `writePaths` are relative to the project. Secret paths such as `.env` are refused.

- `"codingMode": "tools"`: the model explores the repo through host tools. `maxToolCalls` caps them (1 to 64). Claude and Cursor only. Omit both for single-call mode.
- `"readScope": "repository"`: the session may read the whole repository except secrets, not only `readPaths`. Needs tools mode.
- `"split": true`: the planner splits the task into 1 to 8 subtasks. You approve the split once. Each subtask is checked. The run stops at the first failure. Set `maxModelRequests` to plan + subtasks + review. See [task splitting](docs/task-splitting.md).
- `"draftPr"`: `true` asks for a draft PR. It needs the publication flags below.

### 4. Run

Paths must be absolute and canonical. The task `provider` must match `--provider`. The project source must be clean. The state and worktree roots must be outside the project.

Claude:

```sh
npm run project:run -- --workspace /absolute/project --task /absolute/task.json \
  --provider anthropic --claude <pinned claude> --claude-profile $HOME/.forgemind/claude-profile \
  --state-root /absolute/private/runs --worktree-root /absolute/private/worktrees \
  --node-modules /absolute/project/node_modules
```

Use `--node-modules` only for Node projects.

Cursor:

```sh
npm run project:run -- --workspace /absolute/project --task /absolute/task.json \
  --provider cursor --cursor <version dir> --cursor-profile $HOME/.forgemind/cursor-profile \
  --state-root /absolute/private/runs --worktree-root /absolute/private/worktrees \
  --node-modules /absolute/project/node_modules
```

Add `--cursor-mode test-auto` only for the personal Free plan test mode, with `"model": "auto"`. Auto picks its own model, receipts are marked test-only and nothing is published.

The terminal asks you to type `approve <digest>` for the plan. `--connection` and `--codex` are rejected on these routes.

### 5. What checks can run on macOS

Checks run in a sandbox that cannot fork.

- Works: `node --test`, and tools inside `node_modules`, through the `"profile": "node-project"` check profile ([ADR-0015](docs/adr/ADR-0015-node-project-checks.md)).
- Cannot run inside checks yet: `go build`, `go test`, `npm run`, bundlers, rspec and Docker. Run them on the host after the run.
- Linux containment is planned.

### 6. Where the results are

- Run directory: `<state-root>/<taskId>-<uuid>/`, with receipts and `artifacts/`.
- Worktree with the edits: under `--worktree-root`. Your project is not touched.
- Status `completed-local`: checks and review passed. Take the worktree changes yourself. Nothing was pushed.
- Draft PR: set `"draftPr": true` and add `--gh /canonical/gh --author-name "Your Name" --author-email "you@users.noreply.github.com"`. All three are required. Test mode never publishes.
- The run ends with `Brain: run recorded in the <space> space.` or `Brain: run not recorded (...)`. The second means the project is not mapped (see below).

## Central brain (memory across Claude Code, Cursor and the harness)

The brain is local owner state in `~/.forgemind/brain`, never in a repository. Full guide: [docs/brain.md](docs/brain.md).

- History facts (what each run or session did) are stored automatically.
- Rules (conventions, lessons, decisions) guide agents only after you approve them.
- There are two isolated spaces, `personal` and `company`. Map each project to one space, once.

Set up a project:

```sh
npm run brain -- map --workspace /absolute/project --space personal
npm run brain -- learn --workspace /absolute/project --source all --limit 100
npm run brain -- list --workspace /absolute/project --status proposed
npm run brain -- approve --workspace /absolute/project --id ID
npm run brain -- reject --workspace /absolute/project --id ID --note "why"
npm run brain -- history --workspace /absolute/project --limit 20
```

`learn` only proposes entries. Other commands: `add`, `show`, `retire`. All accept `--brain-dir`.

### Turn on the loop

Replace `<forgemind>` with the absolute path of this checkout. First run `npm run build`.

Claude Code. Register the MCP server (use `node`, not `npm run`), then add hooks in `~/.claude/settings.json`:

```sh
claude mcp add --scope user forgemind-brain -- node <forgemind>/dist/src/memory/brain-mcp.js --source claude-code
```

```json
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node <forgemind>/dist/src/memory/brain-hook.js session-start --source claude-code"}]}],"SessionEnd":[{"hooks":[{"type":"command","command":"node <forgemind>/dist/src/memory/brain-hook.js session-end --source claude-code"}]}]}}
```

Cursor. In `~/.cursor/mcp.json`:

```json
{"mcpServers":{"forgemind-brain":{"command":"node","args":["<forgemind>/dist/src/memory/brain-mcp.js","--source","cursor"]}}}
```

In `~/.cursor/hooks.json`:

```json
{"version":1,"hooks":{"sessionStart":[{"command":"node <forgemind>/dist/src/memory/brain-hook.js session-start --source cursor"}],"sessionEnd":[{"command":"node <forgemind>/dist/src/memory/brain-hook.js session-end --source cursor"}]}}
```

For the Cursor CLI, allow these four tools in `~/.cursor/cli-config.json`:

```
Mcp(forgemind-brain:brain_context)
Mcp(forgemind-brain:brain_search)
Mcp(forgemind-brain:brain_record)
Mcp(forgemind-brain:brain_propose)
```

Put them in the `permissions.allow` list of that file. The file is ~/.cursor/cli-config.json; keep any entries already there.

Token caps: `brain_context` returns at most 3200 characters (about 800 tokens). `brain_search` returns at most 5 items, 400 characters each and 2000 in total. Agents never get the whole store.

Check it works: start a session in a mapped project and look for the injected brain context. End it, then run `npm run brain -- history --workspace /absolute/project`. The session should be listed.

Hooks never call a model or block a session. Hooks run from `dist/`, so run `npm run build` again after every `git pull`.

## Supervised coding with your ChatGPT plan

This route uses **Sign in with ChatGPT** (OAuth) and Codex 0.161.0 on macOS. It never falls back to a paid API key. Connect from an owner terminal, using a private absolute directory outside every Git checkout:

```sh
npm run project:connect -- --connection /absolute/private/forgemind-account
npm run project:auth-status -- --connection /absolute/private/forgemind-account
```

Open the printed link and finish OpenAI's sign-in. Tokens stay in that directory. Expired credentials need a new connect. See the [official sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

Before running, open **ChatGPT → Settings → Usage** for that account and disable **Allow other apps to use credits after reaching your usage limit**. A Codex-only setting may not cover ForgeMind's separate connection. ForgeMind cannot read this toggle. If you cannot verify it, do not run. The first run shows the account and asks you to type `credits-disabled <account-fingerprint>`. That acknowledgement is remembered for the same host, client, account and email. [Official usage controls](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)

Run with a [task manifest](docs/live-workflow.md#task-manifest), an absolute canonical Codex 0.161.0 executable, and private run and worktree directories:

```sh
npm run project:run -- --workspace /absolute/project --task /absolute/task.json --connection /absolute/private/forgemind-account --codex /absolute/codex --state-root /absolute/private/runs --worktree-root /absolute/private/worktrees
```

There is no approval bypass, paid fallback or automatic replay. Without connection options the run is blocked (exit 2) and makes no worktree or request. Optional: `--browser-qa-config /private/browser-qa.json` for automatic browser QA ([contract](docs/live-workflow.md#automatic-browser-qa-handoff)). Use `npm run project:inspect -- --workspace /absolute/project` for a credential-free readiness check. Acceptance scope and limits: [live workflow](docs/live-workflow.md#project-acceptance).

To make ForgeMind ask for the credits acknowledgement again:

```bash
node dist/src/local-runtime/live-cli.js billing-reset --connection /absolute/private/forgemind-account
```

This clears only the saved local record (fingerprints, timestamp, review ID). It does not change OpenAI billing settings.

## Other routes and checks

- **Claude and Cursor:** covered above. See [Claude route](docs/claude-driver.md), [ADR-0014](docs/adr/ADR-0014-claude-subscription-route.md), [Cursor route](docs/cursor-route.md) and the [ACP adapter](docs/cursor-driver.md).
- **Codex demo:** `npm run demo:codex`. See [driver instructions](docs/codex-driver.md) for the native probe.
- **Enforced offline host (macOS):** `npm run test:host`, and `npm run probe:host -- /absolute/path/to/codex`. See [host enforcement](docs/host-enforcement.md). This host grants no provider access. The older `npm run harness -- "task"` launcher stays disabled.
- **Ruflo diagnostic:** `npm run harness -- --check` inspects temporary MCP configuration. It is separate from the application host. State is ignored under `.askme-harness/`.

## This repository

ForgeMind's project profile is `config/forgemind-project.json` for [sleepingfreak94/forgemind](https://github.com/sleepingfreak94/forgemind). To attach another project, pass its absolute path to `project:init`. Do not change ForgeMind's origin.

After cloning, run `npm ci` and `npm run doctor`. Then pick a test suite:

| Command | What it runs | Time limit |
|---|---|---|
| `npm run test:portable` | Portable fixtures. No Codex needed. | 5 minutes |
| `npm run test:local` | Full set. Skips tests whose reviewed Codex binaries are missing. | 30 minutes |
| `npm test` | Strict full set. Needs reviewed Codex 0.161.0 and 0.162.1 (`FORGEMIND_TEST_CODEX_0161`, `FORGEMIND_TEST_CODEX_0162`). | 30 minutes |
| `npm run test:host` | macOS Seatbelt host tests. | 10 minutes, 15 s per test |

On a Mac, run long suites with `caffeinate -i`, for example `caffeinate -i npm run test:local`. Sleep would otherwise stop them.

Historical `docs/artifacts/` links refer to local, unpublished validation evidence; raw runtime artifacts are excluded from this repository.
