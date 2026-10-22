# ADR-0015: Reviewed node-project check profile

- Status: Accepted; implementation in progress on `task/node-project-checks`
- Date: 2026-10-22
- Basis: owner decision to let harness checks run real builds and tests while model-written code stays sandboxed

## Context

Supervised checks run one pinned executable under a deny-default Seatbelt profile with no process fork, reads limited to the task worktree and private scratch, scratch-only writes and no network. A fresh task worktree has no `node_modules` or build output. Checks therefore cannot run `tsc`, `npm` or `node --test` with test isolation, and a project's real suite must be verified on the host after the run.

macOS refuses to apply a Seatbelt profile inside a sandboxed process (`sandbox_apply: Operation not permitted`). A test that starts its own `sandbox-exec` can never run inside any check, whatever profile the check uses.

Running checks outside Seatbelt would execute model-written code with the owner's full user authority. That is rejected.

## Decision

Add an owner-selected `node-project` check profile alongside the existing behaviour (`single-process`, the default):

- The executable must be the host's pinned Node runtime. The check may fork and exec only that runtime; no shell, `npm`, `git` or other tool is allowed.
- The owner enables the profile per run with an explicit `--node-modules /canonical/path/node_modules` on `project:run`. Task manifests and model output cannot supply it. Without it, `node-project` checks are refused before any worktree is created.
- `node_modules` is read-only to the check. The host requires the `package-lock.json` beside it to be byte-identical to the worktree's, and records the lockfile hash and directory identity in the command receipt. Package contents are not hashed; that residual is disclosed.
- All `node-project` checks in one phase share a single private scratch directory, in manifest order, so a build check can be followed by a test check. Arguments may use the literal placeholders `{scratch}` and `{nodeModules}`, which the host substitutes with canonical paths. Other checks may not use them.
- The scratch directory contains a host-created `node_modules` symlink to the selected directory, so compiled output under `{scratch}` resolves packages.
- Writes stay limited to the scratch directory. Network, source writes, `.git`, `.codex` and `.env*` reads remain denied.
- `FORGEMIND_NESTED_SANDBOX=1` is set in the check environment. Tests that need their own Seatbelt profile detect it and skip with a reason.

## Consequences

- Harness checks can run the TypeScript build, type check and tests that do not nest a sandbox, so most candidate verification happens inside the run.
- Tests that start `sandbox-exec` (Seatbelt, native executor and fake Claude CLI tests) still need host verification after the run. This is a macOS limit, not a policy choice.
- A child process may exhaust the check's own timeout and output bounds, which are unchanged; the supervisor still reaps the whole process tree.
- `node_modules` is trusted owner-installed code, as it is for the host build.
