# ADR-0009: Codex protocol before protected live execution

Status: Accepted for initial implementation  
Date: 2026-10-07

Implement a version-pinned App Server stdio adapter with pass-through, one ephemeral read-only invocation, strict effective-configuration checks, bounded RPC and denied server callbacks. Require a trusted host lease; supply no default allow host.

Protocol correctness and execution authority have separate evidence gates. The current policy runtime executes fake actions; native read-only mode does not establish exact file-grant enforcement. The host must isolate configuration/tools/credentials, bind source/process identities, reserve provider/spend intent durably and recheck fencing. No real model turn is performed in this slice.

Validate with deterministic lifecycle/race/failure fixtures, a subprocess demo, generated CLI 0.160.0 schemas and an isolated initialize-only native probe. Record source-bound before/after evidence and independent review. These checks do not certify live billing, sandbox enforcement or writing.

Native resume, MCP injection, delegation, writes and real-driver policy integration remain unsupported until their conformance gates. Unknown requests/tools fail closed. Success requires matching completion, live host checks, worker cleanup and a terminal receipt.

See [driver instructions](../codex-driver.md). Headroom remains disabled; Cursor will reuse canonical contracts through a separate adapter.
