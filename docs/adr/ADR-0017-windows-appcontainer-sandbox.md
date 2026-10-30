# ADR-0017: Windows AppContainer sandbox for checks

- Status: Proposed. Phase 1a (launcher, wrapper and Windows tests) and phase 1b (setup, Windows ownership checks, contained single-process checks) and phase 2a (the contained Claude CLI route through an allow-list proxy) are implemented. `project:run` does not load the Windows host yet (phase 3), and the Cursor route is blocked (phase 2b).
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

A small C# 5 launcher, `src/host-enforcement/windows/sandbox-launcher.cs` and `sandbox-acl.cs`, runs one command contained. Each machine builds it from the reviewed source with the in-box `csc.exe` during a one-time setup (`npm run windows:setup -- <owner folder outside the repo>`). The host pins that build's SHA-256 and checks it again before every run. Nothing is compiled at run time. The binary isn't reproducible, because the in-box compiler has no `/deterministic`. That is acceptable because nobody runs a binary built on another machine (owner decision, 2026-10-30). A signed prebuilt release can come later.

For each run the launcher does the following:
1. It refuses a state root where any AppContainer or capability SID may do more than read attributes. It then opens the report exclusively, before any child exists.
2. It picks a random name, `forgemind.<random>`, and derives its package SID.
3. It writes a complete journal to the owner's state root by temp file and rename, then holds it open read-shared. The profile and grants are created only after the journal exists.
4. It grants the SID read on the `readPaths` trees and modify on `writePaths`.
   - **Denied paths are never granted.** AppContainer access checks ignore deny ACEs for the package SID; this was verified in the VM, where an explicit deny on `.env` did not stop a read.
   - A folder above a denied entry gets a this-folder-only ACE, and its other entries are granted one by one.
   - Reparse points under such a folder are never granted.
5. It grants the SID limited window-station and desktop rights, because `user32` start-up fails without them in service sessions such as SSH. The station gets enumerate, read and atoms; the desktop gets read, write, windows and menus. Hooks and journaling are not granted, the job has every UI restriction, and UIPI separates the low-integrity container from other windows.
6. It creates the child suspended and detached, so no console host is created. The child gets no network capability and only one capability, `forgemindRuntime`, which setup grants just read-attributes on chosen folders. Its handles are limited to stdio, and it receives an explicit environment.
7. The child is assigned to a job with kill-on-close, die-on-unhandled-exception, all UI limits and no breakaway, then resumed. `activeProcessLimit: 1` also sets the child-process policy, so creating a process fails immediately.
8. The launcher waits until the job has no processes left. At `timeoutMs` it terminates the job.
9. It revokes every grant, deletes the profile and journal, and writes the result into the report it has held open. It exits 0 after a clean reap and 3 after any other result.

The host accepts a report only when the launcher's exit code agrees with it. A missing or disagreeing report counts as `cleanup-uncertain`. The child can't plant a report for three reasons:
- the state root must be separate from every granted path;
- the state root's ACL must not let containers write;
- the report is already held exclusively before the child starts.

The review found the first version trusted any file at `reportPath`.

If the launcher is killed, the kernel kills the job. The journal stays behind, and `launcher sweep <state root>` revokes its grants and profile. If the report is missing, the host reports `cleanup-uncertain`.

`launcher setup <folders>` is a one-time step run as administrator. It gives the `forgemindRuntime` capability read-attributes and traverse, but no contents, on each folder and its ancestors, because Node's `realpath` stats every path component. It uses `SetKernelObjectSecurity` so a volume root's tree is never walked.

## Phase 1b: setup, ownership and checks

Owner decisions (2026-10-30):
- each machine builds its own launcher;
- runs use an owner-private copy of `node.exe`;
- the provider route reaches the internet through an allow-list proxy (phase 2);
- both the Claude and Cursor CLIs.

**Setup.** `scripts/windows-setup.mjs`, run elevated once, does the following:
1. Builds the launcher into `<owner>\bin`.
2. Copies `node.exe` into `<owner>\runtime`.
3. Creates the launcher state root `<owner>\sandbox-state`.
4. Removes inheritance and grants only the user, SYSTEM and Administrators.
5. Runs `launcher setup` on the runtime, state and any extra folders.
6. Locks the folder before anything is built or run in it, because setup runs elevated: it takes ownership of the folder and everything below, resets every ACE, then grants only the user, SYSTEM and Administrators (review finding B1). A handle someone opened before the lock keeps its access, so the owner folder must sit in a folder only the owner can reach, such as the user profile.
7. Grants the runtime capability read and execute on `runtime\` once. A per-run grant there would propagate to `node.exe`, change its ctime, and trip the pin's drift check (seen in the VM).
8. Checks that the folder, `bin\`, the launcher and the state root are private and that `runtime\` is trusted, then writes `windows-host.json`.

`loadWindowsHost` then:
- refuses paths outside the folder;
- refuses a launcher source digest other than the checkout's (`launcherSourceDigest`);
- pins the launcher and node.exe;
- checks that the folder, the file, the state root, `bin\` and the launcher are private, and that `runtime\` is trusted;
- sweeps leftovers from killed runs.

Every contained run can read all of `runtime\`, so it must hold only executables meant for the sandbox (today `node.exe`).

**Ownership.** `owner-acl.ts` translates POSIX checks:
- `isPrivate` replaces "owner uid and no group or world bits";
- `isTrusted` replaces "no group or world write, owned by root or the owner".

On Windows both call `launcher acl`:
- **private:** the owner is the user, SYSTEM or Administrators. Every allow ACE belongs to one of them (or CREATOR OWNER), or grants at most read-attributes and traverse. Inherit-only ACEs count too: every user may traverse folders by default, so a folder that hands future files to others is not private.
- **trusted:** additionally allows TrustedInstaller as owner, and other SIDs that hold no write, delete, WRITE_DAC or WRITE_OWNER rights.
- A NULL DACL or an unsupported ACE type fails.

`privateDirectory`, the run ledger, `PolicyStore` and `pinFile` use them. The owner identity is the uid or the user SID. Drift polls compare identity only (an ACL edit changes ctime), and full checks run when a file is pinned and when it is verified with a hash.

**Checks.**
- `supervised()` on win32 calls `supervisedWindows`, where the launcher is the supervisor. It polls pins, aborts by killing the launcher and then sweeps, and maps statuses to the macOS failure reasons.
- `runChecks` on win32 runs only the pinned `node.exe`, under `windowsCheckPolicy`: read the tree, write scratch, deny `.git`, `.codex` and `.env*`, one process. Its environment holds only `SystemRoot`, `USERPROFILE` and `HOME` (pointing at scratch), the real `LOCALAPPDATA`, and `FORGEMIND_NESTED_SANDBOX`. Windows points an AppContainer's `TEMP` and `TMP` at `<LOCALAPPDATA>\Packages\<container>\AC\Temp`, which the profile creates and deletes. With `LOCALAPPDATA` set to scratch, that folder didn't exist (seen in the VM).
- `node-project` checks are refused.
- `runtimeFiles` returns only the executable, and refuses a DLL beside it, because the loader searches that folder first.

## Phase 2a: the Claude route

**Container.**
- `windows:setup -- <owner> --claude <claude.exe>` copies Claude Code (one executable) to `runtime\claude\` and settles it like `node.exe`. The installer's copy updates itself, so runs pin the private copy.
- Setup gives two fixed containers, `forgemind.claude` and `forgemind.cursor`, a loopback exemption (`CheckNetIsolation LoopbackExempt`, admin, once).
- A policy may name one of them as `container`. The launcher then keeps that profile instead of deleting it and journals `keep`.
- Runs of the same container take turns through a `Global\` mutex, across logon sessions. Otherwise one run's cleanup would revoke another's grants.
  - A run that waits 30 s gets a written `error` report ("fixed container busy"), not a missing one, so the host doesn't sweep.
  - While holding the mutex, a run first sweeps leftovers of dead runs, so it never inherits a dead run's grants on the shared SID.
- Sweep now skips a journal that a live launcher still holds open (sharing violation). A sweep can no longer revoke a running command's grants.
- A kept profile's `%LOCALAPPDATA%\Packages\<name>\AC` folder persists across runs, and Windows points the container's `TEMP` there. It's writable only by that container, but it isn't per-run scratch (residual).
- The window-station and desktop ACL edits are serialised by a session mutex, which fixes the concurrency race noted below.

**Egress.**
- The CONNECT relay (`native-executor-tunnel.ts`) now takes an exact host allow-list on port 443 and reports refused targets. Codex keeps `api.openai.com`.
- On Windows, `NativeClaudeModel` starts one relay per call for `CLAUDE_PROXY_HOSTS` (`api.anthropic.com`). It passes the relay through `HTTPS_PROXY` and records refused targets as `proxy-refused` phase evidence.
- The container has no internet capability, so a client that ignores the proxy fails.

**Session.**
- `claudeSession.launch` on Windows returns a containment policy: write scratch and the profile; read the CLI through the runtime capability; one process; the fixed container.
- Its environment holds `SystemRoot`, the real `LOCALAPPDATA`, `USERPROFILE`/`HOME` set to scratch, `CLAUDE_CONFIG_DIR`, the same `DISABLE_*` and no-retry settings as macOS, and the proxy variables.
- Pinning uses `isTrusted` and `PINNED_CLAUDE_CLI_WINDOWS` (2.1.314, win32-arm64). Only its contained conformance is checked here; the ADR-0014 Phase 0 review (terms, flags, stream shape) is pending, so receipts record `reviewedBuild: false`.
- `runContained` now passes stdin into the container. The child inherits the open pipe and creates none, and the prompt arrives correctly.

**Verified in the VM.**
- Contained `claude auth status` reports the owner's sign-in.
- A real `NativeClaudeModel.complete()` returned its structured answer in about 25 s. It ran contained, in one process, with no refused targets.
- From the `forgemind.claude` container, a direct connection to `1.1.1.1:443` fails, and a CONNECT to another host is refused and reported.

**Residual (needs explicit owner sign-off).**
- The loopback exemption covers every listener on 127.0.0.1, not just the proxy and MCP ports. The test shows a container reaching an unrelated host listener. macOS pins one exact port.
- The MCP endpoint takes a secret URL path, which mitigates this.
- Closing it needs fixed ports plus per-package firewall rules, or accepting the residual.

**Cursor (2b) is blocked.**
- Cursor's bundled `node.exe` runs contained.
- Its `index.js` stalls synchronously early in start-up. That happens with no child processes or workers, with the file credential store, and even with its install folder writable.
- Uncontained it works.
- The cause is not yet found, so the Cursor route stays refused on Windows.

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
- **Refused before running:**
  - a changed launcher;
  - a state root inside a granted path, or one that ALL APPLICATION PACKAGES may write (nothing runs, and no report or journal is left);
  - a missing grant target;
  - a hardlinked file in a granted tree.
- **Loopback:** a host listener on 127.0.0.1 receives no connection from the container.
- **Mutation check:** a launcher that ignores the deny list fails the containment test.

## Limits

- **What is still readable:** whatever already grants ALL APPLICATION PACKAGES, which covers much of `C:\Windows` and parts of HKLM and Program Files. RPC services that accept AppContainers are also reachable. LPAC is a later hardening step.
- **Spawning with stdio pipes hangs:** when an AppContainer process spawns a child with stdio pipes, Node (libuv) retries its named pipe and hangs until the deadline instead of failing at once. It is still contained.
- **Cost:** a contained run costs about 5 s in a 2-vCPU VM, mostly profile creation. The host's backup timer is `timeoutMs + 60 s`, and only catches a hung launcher.
- **Hardlinks:** one ACL covers every name of a hardlinked file, so `runContained` refuses any file with `nlink > 1` in a granted tree.
- **Quiet tree:** the grant plan is made once, at launch. A `.env`, `.git` or `.codex` created during a run, under a folder that had no denied entry, inherits the read grant. The worktree must be quiet while a check runs, which the single-writer rule already requires.
- **Concurrent runs:** they edit the shared window-station and desktop ACLs by read-modify-write. Since phase 2a, a session mutex serialises those edits. Before that, a race could drop another run's ACE.
- **Sweep during a live run:** since phase 2a it skips journals a live launcher holds.
- **Leftover ACEs:** window-station and desktop ACEs for a killed run's SID can remain. The SID is random and its profile is deleted, so nothing can use them.
- **Elevation:** the tests run elevated over SSH. Setup needs an administrator once; runs themselves don't.

## Next

- **Phase 2b:** find why Cursor's start-up stalls in an AppContainer, then mirror 2a with `forgemind.cursor`.
- **Phase 3:** worktree, git and gh, artifacts and a draft PR on Windows, then a full `project:run`.
- **Later:** job-only whole-tree kill for `evidence.ts` and browser QA, then LPAC.

## Owner questions

Answered 2026-10-30: owner-built per machine (1), allow-list proxy (2), private node.exe copy (4), both the Claude and Cursor CLIs (5).

3. Should elevated sessions be refused once testing no longer needs SSH?
6. Smart App Control is in evaluation mode on the VM. If it switches on, it blocks the unsigned launcher. Is it in scope?
