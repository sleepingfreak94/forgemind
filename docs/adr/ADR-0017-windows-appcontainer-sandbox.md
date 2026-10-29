# ADR-0017: Windows AppContainer sandbox for checks

- Status: Proposed. Phase 1a (launcher, wrapper and Windows tests) is implemented; nothing is wired into a run yet.
- Date: 2026-10-30
- Basis: the owner authorized building a Windows sandbox, designed and reviewed with Opus 5.5. The design was checked against a Windows 11 ARM VM (build 26300).

## Context

Supervised coding and checks run only on macOS, under Seatbelt. Every other platform refuses (`live-cli.ts`, `process.ts`, `native-executor-*.ts`, `host.ts`, `readiness.ts`). On macOS a check:
- may read the worktree, scratch, its executable and system libraries;
- may not read `.git`, `.codex` or `.env*`;
- may write only private scratch;
- may not fork and has no network;
- gets only an explicit environment (`checks.ts:17-30`).

The alternatives were weighed:

| Mechanism | Outcome |
|---|---|
| Restricted tokens and low integrity | Rejected: the user's reads stay open. |
| Windows Sandbox and WSL2 | Rejected: disabled, nested Hyper-V on ARM, and they don't isolate one tree on the Windows side. |
| Firewall rules alone | Rejected: they cover network only. |
| AppContainer + Job Object | Chosen. An AppContainer process can open only what an ACL grants its package SID or a capability it holds. A Job Object gives whole-tree lifetime that the kernel enforces. |

## Decision

A small C# 5 launcher, `src/host-enforcement/windows/sandbox-launcher.cs`, runs one command contained. The owner builds it once with the in-box `csc.exe` (`npm run build:windows-launcher -- <folder outside the repo>`). The host pins the printed SHA-256 with `pinWindowsLauncher` and checks it again before every run. Nothing is compiled at run time. The source is reviewed. The binary isn't reproducible, because the in-box compiler has no `/deterministic`, so the binary digest is whatever the owner's build printed.

For each run the launcher does the following:
1. It picks a random name, `forgemind.<random>`, and derives its package SID.
2. It writes a complete journal to the owner's state root by temp file and rename. The profile and grants are created only after the journal exists.
3. It grants the SID read on the `readPaths` trees and modify on `writePaths`.
   - **Denied paths are never granted.** AppContainer access checks ignore deny ACEs for the package SID; this was verified in the VM, where an explicit deny on `.env` did not stop a read.
   - A folder above a denied entry gets a this-folder-only ACE, and its other entries are granted one by one.
   - Reparse points under such a folder are never granted.
4. It grants the SID limited window-station and desktop rights, because `user32` start-up fails without them in service sessions such as SSH. The station gets enumerate, read and atoms; the desktop gets read, write, windows and menus. Hooks and journaling are not granted, the job has every UI restriction, and UIPI separates the low-integrity container from other windows.
5. It creates the child suspended and detached, so no console host is created. The child gets no network capability and only one capability, `forgemindRuntime`, which setup grants just read-attributes on chosen folders. Its handles are limited to stdio, and it receives an explicit environment.
6. The child is assigned to a job with kill-on-close, die-on-unhandled-exception, all UI limits and no breakaway, then resumed. `activeProcessLimit: 1` also sets the child-process policy, so creating a process fails immediately.
7. The launcher waits until the job has no processes left. At `timeoutMs` it terminates the job.
8. It revokes every grant, deletes the profile and journal, and writes the trusted result to `reportPath`. The child can't reach that file, because the state root must be separate from every granted path.

If the launcher is killed, the kernel kills the job. The journal stays behind, and `launcher sweep <state root>` revokes its grants and profile. If the report is missing, the host reports `cleanup-uncertain`.

`launcher setup <folders>` is a one-time step run as administrator. It gives the `forgemindRuntime` capability read-attributes and traverse, but no contents, on each folder and its ancestors, because Node's `realpath` stats every path component. It uses `SetKernelObjectSecurity` so a volume root's tree is never walked.

## Verified in the VM (tests/host-enforcement/windows-sandbox.test.ts)

- **Allowed:** reading source and writing scratch.
- **Denied:**
  - reading `.env` and `.git`;
  - writing source and alternate data streams;
  - reading a user-only secret, directly or through a junction in scratch;
  - writing `C:\Users\Public`, the worktree's parent or the state root (a forged report);
  - spawning a child;
  - outbound TCP, DNS and loopback;
  - inherited environment secrets.
- **Lifetime:** a deadline ends an infinite loop, and also a grandchild that outlives its parent. Killing the launcher kills the contained process, and sweep removes the leftover grants.
- **Refused before running:** a changed launcher, a state root inside a granted path, or a missing grant target.
- **Mutation check:** a launcher that ignores the deny list fails the containment test.

## Limits

- **What is still readable:** whatever already grants ALL APPLICATION PACKAGES, which covers much of `C:\Windows` and parts of HKLM and Program Files. RPC services that accept AppContainers are also reachable. LPAC is a later hardening step.
- **Spawning with stdio pipes hangs:** when an AppContainer process spawns a child with stdio pipes, Node (libuv) retries its named pipe and hangs until the deadline instead of failing at once. It is still contained.
- **Cost:** a contained run costs about 5 s in a 2-vCPU VM, mostly profile creation. The host's backup timer is `timeoutMs + 60 s`, and only catches a hung launcher.
- **Hardlinks:** a hardlink inside a granted tree is readable through any of its names. Worktrees come from git, which writes no hardlinks; wiring must still reject `nlink > 1` in granted trees.
- **Leftover ACEs:** window-station and desktop ACEs for a killed run's SID can remain. The SID is random and its profile is deleted, so nothing can use them.
- **Elevation:** the tests run elevated over SSH. Setup needs an administrator once; runs themselves don't.

## Next

- **1b:** run plain checks through this launcher on Windows, behind the existing gates.
  - Pin it in `process.ts`.
  - Add a Windows branch in the supervisor, with an environment containing `SystemRoot`, `LOCALAPPDATA`, `TEMP`/`TMP` and `USERPROFILE` set to scratch.
  - Skip the uid and mode checks in `manifest.ts`, keeping the link checks.
  - `node-project` checks and provider CLIs stay refused.
- **Phase 2:** provider CLIs, with an egress choice for the owner: per-SID firewall rules, or a loopback exemption plus a host-side CONNECT proxy that allows only provider hosts.
- **Phase 3:** job-only whole-tree kill for `evidence.ts` and browser QA, then LPAC.

## Owner questions

1. Is an owner-built, non-reproducible binary acceptable? The alternatives are a signed prebuilt binary or a deterministic compiler.
2. Which provider egress option should phase 2 use?
3. Should elevated sessions be refused once testing no longer needs SSH?
4. Should a run use an owner-private copy of `node.exe` (the current approach), or should setup grant the runtime capability on `C:\Program Files\nodejs`?
5. Which Windows builds of Claude Code and Cursor should be reviewed?
6. Smart App Control is in evaluation mode on the VM. If it switches on, it blocks the unsigned launcher. Is it in scope?
