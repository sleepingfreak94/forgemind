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
