# ADR-0010: Real authorization and enforced offline host

Status: Accepted for the offline MVP gate
Date: 2026-10-07

## Decision

Implement a concrete macOS `OfflineSeatbeltHost` before permitting live coding. Persist exact command-envelope reservations and ancestor charges in SQLite, then execute only through a default-deny native sandbox and independent supervisor. Use private selected-file snapshots, pinned runtime identities, a credential-free environment and source-bound terminal evidence. Fail closed on unavailable sandbox, drift, cancellation, stale authority or uncertain cleanup.

Disable the older direct workspace-write launcher. Keep native provider/network/spend/write access closed until independently implemented and tested. Native Codex 0.160.0 initialize-only startup and deterministic protocol execution through the real host both pass. Neither establishes live inference compatibility.

## Consequences

No permissive fallback, retry, fork, external networking or project writes. Only macOS is currently supported. Revocation is checked every 25 ms and at task/release boundaries. Runtime/output bounds are not hard CPU/RAM/disk quotas. The local owner and host installation remain trusted; this is not protection against hostile same-UID host code.

Restarted sessions mark unresolved reservations indeterminate, preserving at-most-once launch accounting. Only confirmed reaping allows completion; uncertain attempts retain private state. The full launch descriptor is stored privately in the external attempt, while public receipts expose its digest and terminal view/output digests.

## Evidence

See [host enforcement](../host-enforcement.md), [native test log](../artifacts/host-enforcement/native-tests.txt), [native initialize result](../artifacts/host-enforcement/native-handshake.txt) and the source-bound validation/review artifacts alongside them.
