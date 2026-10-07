# ADR-0011: Cursor ACP protocol slice

Status: Accepted for deterministic offline conformance
Date: 2026-10-07

## Decision

Add a separate Cursor ACP v1 driver behind the shared `DriverHost`. Use explicit owner-selected model/mode configuration, a canonical pass-through packet, strict JSON-RPC framing, conservative text-only updates, denied callbacks and bounded cancellation/reaping. Validate deterministic protocol behavior and real offline SQLite/Seatbelt assembly before permitting native provider execution.

Split driver intents into Codex and Cursor variants. Bind Cursor configuration and private-scratch persistence in version 2 host envelopes. Cursor sessions are fresh but are not declared native ephemeral. Keep the existing default-deny host permissions; no network, fork, account access or source writes are enabled.

## Consequences

Configuration support is required; legacy mode/model fallback is intentionally absent. Unavailable selections deny the run. Owner-provided option IDs never infer billing or plan entitlement. Unknown extensions and native tools stop the run. Codex callers must specify the driver discriminant and receive new envelope identities.

Deterministic tests certify fixture behavior, not native Cursor package/model/account compatibility. The next gate is a pinned native offline handshake, followed by controlled egress/credential/spend enforcement and exact write capabilities. Headroom and checkpoint interoperability remain later gates. Windows is deferred.

## Evidence

See [driver contract](../cursor-driver.md), [unit tests](../artifacts/cursor-driver/after-tests.txt), [native offline fixture tests](../artifacts/cursor-driver/native-tests.txt), and the source-bound validation/review records alongside them.
