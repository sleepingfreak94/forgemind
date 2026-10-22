# ADR-0015: Reviewed node-project check profile

- Status: Accepted; implemented
- Date: 2026-10-22
- Basis: owner decision to let harness checks run real builds and tests while model-written code stays sandboxed

## Context

Supervised checks run one pinned executable under a deny-default Seatbelt profile with no process fork, reads limited to the task worktree and private scratch, scratch-only writes and no network. A fresh task worktree has no `node_modules` or build output. Checks therefore cannot run `tsc`, `npm` or `node --test` with test isolation, and a project's real suite must be verified on the host after the run.

macOS refuses to apply a Seatbelt profile inside a sandboxed process (`sandbox_apply: Operation not permitted`). A test that starts its own `sandbox-exec` can never run inside any check, whatever profile the check uses.

Running checks outside Seatbelt would execute model-written code with the owner's full user authority. That is rejected.

## Decision

Add an owner-selected `node-project` check profile alongside the existing behaviour (`single-process`, the default):

- The executable must be the host's pinned Node runtime or an executable file inside the selected `node_modules`, such as the native TypeScript compiler (`@typescript/typescript-<platform>-<arch>/lib/tsc`).
  - **No profile allows `process-fork`.** The check is a single process, so no child can detach into a new session and outlive the supervisor's process-group reap.
  - Tests therefore run in one process, for example `node --test --test-isolation=none`, and the `tsc` JavaScript shim, which spawns the native compiler, cannot be used.
  - Nothing the check can write is executable, and no shell, `npm`, `git` or other tool is allowed.
- The owner enables the profile per run with an explicit `--node-modules /canonical/path/node_modules` on `project:run`. Task manifests and model output cannot supply it. Without it, `node-project` checks are refused before any worktree is created.
- `node_modules` is read-only to the check. The host requires the `package-lock.json` beside it to be byte-identical to the worktree's, and records the lockfile hash and directory identity in the command receipt. Package contents are not hashed; that residual is disclosed.
- All `node-project` checks in one phase share a single private scratch directory, in manifest order, so a build check can be followed by a test check. Arguments may use the literal placeholders `{scratch}` and `{nodeModules}`, which the host substitutes with canonical paths. Other checks may not use them.
- The scratch directory contains a host-created `node_modules` symlink to the selected directory, so compiled output under `{scratch}` resolves packages.
- Compilers such as `tsc` resolve packages upward from the source files, so the host also links the selected `node_modules` at the checked tree's root for the phase. It does this only when no `node_modules` exists there, or when the existing one already is the selected directory.
  - The source identity must be unchanged with the link present, so the project must ignore `/node_modules`; otherwise the phase is refused.
  - The link is always removed after the phase.
- Writes stay limited to the scratch directory. Network, source writes, `.git`, `.codex` and `.env*` reads remain denied.
- `FORGEMIND_NESTED_SANDBOX=1` is set in the check environment. Tests that need their own Seatbelt profile detect it and skip with a reason.

## Consequences

- Harness checks can run the TypeScript build, type check and tests that do not nest a sandbox, so most candidate verification happens inside the run.
- Tests that start `sandbox-exec` (Seatbelt, native executor and fake Claude CLI tests) still need host verification after the run. This is a macOS limit, not a policy choice.
- Tests that spawn helper processes (other CLIs, `git`, test isolation) cannot run inside a check.
- Fork was considered and removed. A check could detach a grandchild with `{detached: true}` (setsid), which leaves the process group the supervisor kills; it was reproduced surviving cleanup. macOS offers no unprivileged way to tie such a process back to the check's sandbox.
- `node_modules` is trusted owner-installed code, as it is for the host build.
