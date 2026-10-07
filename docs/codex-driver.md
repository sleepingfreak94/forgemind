# Initial Codex Driver

The TypeScript App Server stdio adapter targets **Codex CLI 0.160.0** with pass-through context. Deterministic conformance and an installed-binary handshake are verified; protected live coding execution is not enabled.

## Run

```bash
npm run demo:codex
npm run typecheck
npm test
npm run probe:codex -- /absolute/path/to/codex
```

The demo uses a deterministic Node subprocess, preserves E42 evidence, verifies the result and reaps the worker. Its host/receipts are fixtures. The optional native probe checks version and only sends `initialize`/`initialized`, with an empty temporary workspace, isolated Codex home, PATH-only inheritance and analytics disabled. It loads no user login/configuration and starts no thread/model turn. Its main-process shutdown is a diagnostic, not a production process-tree supervisor.

## Behavior

- One ephemeral read-only thread/turn per invocation, explicit model/provider/effort and standard tier; no automatic retries or model substitution.
- Exact protected sections in developer instructions and canonical serialized view as user input, bound by digests.
- Validate effective CLI version, model/provider/effort, workspace, tier, approval policy/reviewer, ephemeral state, read-only/no-network sandbox and empty instruction sources before inference. Reject nonempty/incomplete MCP inventory.
- Bound JSONL lines/total bytes, RPC waits, output and runtime. Malformed frames, unknown/duplicate IDs, disconnections and unsupported tool types fail closed.
- Reconcile pre-acknowledgement notifications and final per-item text; export no private reasoning. Only matching terminal completion counts as success. Returned events are a result list, not a live progress subscription.
- Immediately deny command/file/permission/tool/elicitation/unknown callbacks and stop, regardless of reply backpressure.
- Caller cancellation and packet expiry interrupt a known turn best-effort, then require shutdown. Interrupt acknowledgement is not completion.
- Reap before the terminal receipt. Cleanup uncertainty is `indeterminate` and poisons reuse; receipt failure prevents success. Late-open leases receive shutdown and terminal handling.

Only reviewed `userMessage`, `agentMessage`, `reasoning` and `commandExecution` items are accepted. Automatic commands still require host environment authority. Writes, native resume, persistent checkpoints, MCP injection, native delegation, per-native-tool receipts and Cursor parity are unsupported.

## Host authorization gate

`CodexDriver` requires `DriverHost` and `PassThroughContextOptimizer`. The concrete [offline host](./host-enforcement.md) now supplies SQLite launch reservations, native read/write/network/fork restrictions and supervised shutdown. It successfully runs the deterministic protocol fixture and native initialize-only probe; live provider/spend/write permissions remain closed.

Before startup, `open` durably reserves the exact scope/source/workspace, CLI/model/provider/effort, view digest and runtime/output intent. The host binds executable/configuration/environment identities and isolates credentials and ambient instructions/MCP/plugins/hooks. The offline host authorizes no provider spending; a future online envelope must enforce it separately.

The host supervises expiry/revocation/fencing. `lease.check` revalidates authority and source state at awaited boundaries, immediately before inference and output release. `stop` reaps the full worker tree; `finish` remains usable afterward and records accurate terminal/indeterminate outcomes. Host calls must honor cancellation and receipt denied, failed or late startup attempts. Model JSON never supplies these ports.

The local policy `execute` endpoint still executes fake actions. Its separate privileged `reserveExternal` API durably reserves real host envelopes; neither grants provider access. Stable Codex read-only mode alone does not enforce exact file grants or project-only reads; the outer host supplies that boundary. Notifications do not intercept automatic commands, startup reads or provider calls. An online host must budget the complete native prompt, including base/developer instructions and framing; context-view budgets alone are insufficient. A stale-output check cannot undo an issued provider request, so durable reservations must retain uncertainty without retrying it.

## Next gate

Generated 0.160.0 schemas are the wire compatibility authority. Regenerate before adding versions: `codex app-server generate-json-schema --out /approved/temporary/schema-directory`. The installed CLI labels App Server experimental. See [official App Server documentation](https://learn.chatgpt.com/docs/app-server).

The original initialize-only diagnostic does not certify native thread settings, account access, model turns, billing or sandbox boundaries. The real offline host now has native denial/lifecycle tests and its own passing native initialize-only probe. Next implement provider egress/credential/spend/write enforcement before an authorized raw Codex task, Headroom activation or Cursor certification.
