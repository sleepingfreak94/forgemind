# Enforced offline host

`OfflineSeatbeltHost` is a real `DriverHost` backed by durable local policy and macOS Seatbelt. It authorizes and supervises offline commands. Live coding remains disabled: provider credentials/network/spend, native write commands and Cursor conformance are separate gates.

## Run

```bash
npm test
npm run test:host
npm run probe:host -- /absolute/path/to/codex
```

`test:host` requires macOS and permission to apply Seatbelt and bind synthetic loopback fixtures. An enclosing development sandbox may prohibit these operations; this is a failed prerequisite, never a reason to run the worker unsandboxed. Unsupported platforms fail closed.

For native Windows clone/build/fixture checks, use [Windows verification](./windows.md). `test:portable` selects context and protocol fixtures explicitly; `test:host` rejects unavailable native backends. Portable success does not authorize real host execution. Windows ACL/SID policy and sandbox enforcement remain unimplemented.

The native Codex 0.160.0 probe passes `initialize`/`initialized` inside this host, with a private empty home, durable receipts and confirmed reaping. No model thread/turn or provider request is issued. The deterministic Codex protocol fixture also completes through real authorization and Seatbelt. These checks certify offline startup and fixture integration, not native inference or billable-task behavior.

## Assembly

1. Select explicit, non-secret source paths and call `snapshotWorkspace(sourceRoot, privateStagingRoot, paths)`. It rejects traversal, symlinks, hardlinks and unsafe staging. It copies and hashes the selected bytes into a private read-only workspace; ordinary edits to the original repository do not change that snapshot.
2. Open `LocalPolicyRuntime` with the snapshot workspace, repository identity, trusted source callback and a private state directory outside the worker workspace. Keep this facade in the host; give workers no database or owner endpoints.
3. Build the canonical pass-through packet/view, then prepare a `DriverIntent` with exact scope, source, expiry, model/provider/effort, CLI version, workspace, view digest and runtime/output limits.
4. `prepareHostPlan` pins an absolute executable, exact argument list, explicit read files/runtime libraries, standalone supervisor and Node runtime by canonical path and SHA-256. Pins reject group/world-writable and setuid/setgid files; the immutable plan rejects accessor-bearing payloads. Production callers supply explicit runtime files; test-only `otool` discovery is not a production permission resolver.
5. Issue a task grant for `command.run` with the exact `hostResource(plan)`. Construct `OfflineSeatbeltHost({runtime, grantId, plan, scratchRoot})`, then pass it to `CodexDriver` or `CursorDriver`. The host is single-use and rejects differing intents before launch. A grant alone never starts a process.

Version `macos-offline-v2` binds separate Codex and Cursor intents and driver-specific environment templates. Codex retains its explicit ephemeral intent and private CODEX_HOME; Cursor binds explicit ACP configuration and private-scratch persistence, using private XDG_CACHE_HOME. Old envelope grants cannot authorize the new descriptor. The [Cursor ACP fixture](./cursor-driver.md) now passes through the same real host; native Cursor startup and model tasks remain unverified.

## Enforced boundary

SQLite commits the reservation, canonical launch envelope and ancestor action charges before spawning. The envelope binds arguments, files, supervisor, environment template and actual Seatbelt policy template. Failed launches consume their reservation; no automatic retry occurs. Restart fences previous sessions and records unfinished attempts as indeterminate.

Seatbelt denies by default. The worker can execute only the pinned executable, read explicit files plus OS libraries/root and snapshot directories/metadata, and write only a fresh invocation scratch directory. Reading the snapshot directory itself permits `getcwd()`; it does not grant recursive file contents. The worker cannot fork, read other project/home credentials, connect TCP/UDP/Unix sockets, access Mach credential services, or write source files. Symlink/hardlink aliases do not expand those rights. It inherits no account configuration, keys, proxy variables, Node options, loader overrides or host IPC; HOME/TMPDIR and driver-specific CODEX_HOME or XDG_CACHE_HOME point at its private scratch, and ambient OpenSSL configuration is suppressed.

The independently running supervisor bounds combined stdout/stderr and wall-clock runtime, kills on host IPC disconnect, and reports child reaping. Because the worker cannot fork, reaping this worker accounts for its entire process tree. PID values are diagnostic only. Host checks also monitor grant/ancestor revocation, expiry, policy/session fencing and pinned file identity on a 25 ms timer. Polling compares inode, ownership, permissions, link count, size and nanosecond change timestamps; launch, awaited checks and release also rehash the bytes. Polling can be delayed by host scheduling and is not instantaneous kernel fencing.

Completion requires confirmed shutdown and another source/runtime/cancellation/deadline check. Durable terminal receipts bind the view and optional output digest. Unexpected exit, output overflow, cancellation, expired authority and source drift prevent success. Cleanup uncertainty can produce an indeterminate receipt without asserting reaping; scratch/state are retained in that case. Only authenticated host supervisor IPC provides shutdown evidence.

## Limits and next gate

This is a trusted local owner model, not isolation from a hostile administrator or another unsandboxed process with the same UID. The installed executable, runtime libraries and host code are part of the trusted installation; keep them outside writable agent workspaces. Source snapshots are private copies, and pinned installation identity is rechecked, but path/hash checks are not an atomic defense against malicious host-side replacement. OS libraries and file metadata are platform allowances, not exact per-file project grants.

Wall-clock and output caps do not impose hard CPU, RAM, thread or scratch-disk quotas. There are no provider/model-token spending permissions: all network is denied. No native subagents, MCP tools, PTYs, shell subprocesses or writable coding tasks are enabled. The older `npm run harness -- "task"` path now stops before resolving/launching an agent; `--check` remains an explicitly separate development diagnostic with ambient CLI configuration.

Before live coding, implement controlled provider egress/credential use and full-prompt spending reservations, then enforce exact write/command capabilities and validate a native task. Do not broaden network or fork permissions simply to make a task pass. Headroom activation and Cursor certification follow the raw enforced baseline. See [ADR-0010](./adr/ADR-0010-offline-host-enforcement.md).

The profile design was checked against [OpenAI's Seatbelt implementation](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt.rs) and [base policy](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl); ForgeMind uses a narrower standalone offline policy and validates its own denied operations.
