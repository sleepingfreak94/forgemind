# Repository read and task splitting plan

Status: **plan.** Branch `task/repo-read-and-splitting`, stacked on #33. Goal: let the harness handle real project work end to end. That means exploring a codebase without the owner listing every file, and splitting a hard task into a sequence of reviewed steps. Each change is built with the harness itself and supervised by the lead; ADR-0017 follows.

## Owner decisions (2026-10-23)

| Decision | Choice |
|---|---|
| Owner's stack | Go, JavaScript, Ruby, Docker, performance testing, Linux servers. |
| Read scope (tools mode) | The whole repository, minus secrets: any tracked file except `.git`, `.env*`, key and credential-looking files, and ignored files. Writes stay limited to the granted `writePaths`. |
| Task splitting | Opus proposes ordered subtasks, and the owner approves the split once. The subtasks then run in sequence, stop at the first failure, and produce one draft PR at the end. |
| Go | First, run the harness as it is on one of the owner's Go projects, to see how it behaves. |

## Part 1: repository read in tools mode

- **Contract:** a task opts in with `"readScope": "repository"`, which is valid only with `"codingMode": "tools"` on the Claude route. `readPaths` then become hints, not a limit.
- **Readable files:** `host_read` accepts any path that Git tracks (`git ls-files` at the session source), except a reviewed secret denylist:
  - `.git/`, `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `*.keystore`, `.npmrc`, `.netrc`, `credentials*`, `secrets*`;
  - anything ignored or untracked.
- **New read-only tools:**
  - `host_list {prefix?}`: tracked paths under a prefix, capped;
  - `host_search {text, path?}`: a literal substring search over readable files, with no regular expressions (so no runaway regex), capped by matches and bytes.
- **Budgets:** the existing read, byte and tool-call budgets still bind. Every read, list and search is receipted with the tree it saw.
- **Unchanged:** `host_apply` still accepts only `writePaths`.

## Part 3: automatic task splitting

- **Contract:** a task opts in with `"split": true`, which requires the Claude route in tools mode.
- **Split plan:** after planning, Opus returns ordered subtasks. Each has a title, an objective, `writePaths` that are a subset of the task's, and check ids from the task.
- **Approval:** the host validates the split and shows it, and the owner approves the whole list once.
- **Each subtask:** one Sonnet tools session on the same worktree, then that subtask's checks. A failing subtask stops the run with the worktree and receipts kept, and later subtasks don't start.
- **At the end:** all task checks, one fresh review of the whole diff, and one draft PR.
- **Budgets:** `maxModelRequests` and runtime bound the whole run.
- **Resume:** resuming from the failed subtask is the next step after this. It can build on the existing continuation checkpoints (`docs/continuation.md`).

## Go trial (before Part 1)

- Run `project:run` on an owner Go repository with the Claude route.
- **Checks:** `go build` and `go test` start compiler, linker and test-binary processes, which the no-fork sandbox refuses. The trial therefore uses single-process checks such as `gofmt -l` and content checks. The lead runs `go test` on the host afterwards.
- **What it should show:** how planning, editing and review behave on Go code, and where the harness's limits bite.

## Not in scope

Linux sandboxing and running Go, Ruby or Docker tests inside checks. Those need a different containment model; containment on Linux is the likely route.

## Part 4: central brain (owner decisions 2026-10-23)

One owner-wide memory for every project, usable from harness runs and from the owner's own Claude Code and Cursor sessions. It learns how the owner pushes code, and only owner-approved items guide agents.

| Decision | Choice |
|---|---|
| Store | ForgeMind central memory, owner-only, under `~/.forgemind/brain/` |
| Separation | Two walled spaces, **personal** and **company**. A project belongs to exactly one space, mapped in an owner config; unmapped projects are refused. Nothing crosses spaces unless the owner copies it. |
| Learns from | Commit and branch style (git history), PR and review habits (GitHub) |
| Approval | A daily digest at **14:00 Asia/Kolkata** to **Slack and Teams**: what it learned, what it wants to change and why, each item with evidence links. The owner approves or rejects afterwards (CLI or by asking an agent). Proposed items never guide agents. |

**Entries.** Each entry has:
- a kind: convention, lesson, decision or pattern;
- a space;
- an optional project;
- text;
- evidence: commit SHAs, PR URLs and source hashes;
- a status: proposed, approved, rejected or retired;
- timestamps.

Commit, PR and review text is untrusted input; it is never followed as an instruction. Secrets are redacted before anything is stored.

**Phases:**
1. **Store and CLI:** spaces, the project-to-space map, and the commands add, list, approve, reject and retire.
2. **Learners:** these read history read-only, through `git log` and `gh`, and turn it into proposals with evidence. Sources:
   - commit message format, branch names and commit size from git;
   - PR titles and descriptions, review comments, and what gets sent back from GitHub.
3. **Daily digest:** reuse the existing Slack and Teams delivery (outbox, destination binding, consent), plus a 14:00 IST local schedule that the owner installs.
4. **Serving:**
   - a local MCP server (`forgemind-brain`) gives Claude Code and Cursor read access to **approved** entries for the current project's space, plus a tool that can only *propose*;
   - harness runs add approved entries to the plan, coding and review prompts as cited, untrusted evidence.

**Reuse:** project memory (`src/memory/`), run history, weekly delivery, and the Slack and Teams adapters.

**Open questions for the owner:**
- which projects belong to which space;
- the Slack and Teams destinations and consent.

### Part 4b: project memory, corrections and service groups (owner decisions 2026-10-23)

- **Run memory, automatic.** When a harness run ends, its facts are stored in the project's brain as history, not as guidance:
  - the task;
  - the files changed;
  - the checks and their results;
  - the review verdict;
  - the PR link and the outcome.

  Rules never come from this record directly.
- **Correction learning, approved.** After a harness PR merges, ForgeMind compares the harness's final commit with the merged result: the owner's extra commits, edits and review comments.
  - Sonnet, on the route allowed for that space, summarizes each correction into a short proposed lesson. The diff hunks are its evidence, and they are treated as untrusted.
  - It appears in the 2 PM digest. It only guides future work once the owner approves it.
- **Service groups, auto-detected.**
  - ForgeMind proposes groups of related projects inside one space. Signals: the same GitHub owner, Go module paths and `package.json` names that reference each other, shared API or proto files, and Docker Compose service names.
  - The owner confirms or edits each group.
  - When a task runs in a project, its context holds the project's approved memory first, then approved group memory: shared contracts, error formats, how services call each other.
  - Groups never cross spaces.

**Provider parity (owner requirement).** All of Part 4 applies equally to the Cursor route and to the owner's interactive Cursor sessions:
- run memory, correction lessons and service groups;
- the digest and approved-memory serving through the `forgemind-brain` MCP server.

Correction summaries use the model route allowed for the project's space:
- **company space:** the company Cursor seat;
- **personal space:** the owner's Claude subscription or personal Cursor plan.

Company code never goes through a personal account.
