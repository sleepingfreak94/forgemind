# Cursor ACP driver

`CursorDriver` implements one fresh, text-only ACP v1 session with a deterministic conformance fixture. The fixture also runs through real SQLite authorization and the macOS Seatbelt host. Native Cursor login, model turns, office model availability and billing have not been verified. Live coding remains disabled.

## Verify

```bash
npm test
npm run test:host
```

The second command requires macOS and permission to apply Seatbelt. Its Cursor test launches a synthetic Node ACP server, persists synthetic history in private scratch, completes a canonical packet, reaps the process and checks the durable terminal receipt. It never launches native Cursor or contacts a model. The in-memory driver tests use explicitly synthetic authority and transport; only the native fixture test uses real command authorization.

## Contract

The caller supplies an absolute canonical workspace, a `PassThroughContextOptimizer`, a trusted `DriverHost`, explicit model and configuration IDs/values, runtime and output caps. The host reserves the exact Cursor intent before launch. `DriverIntent` is now a Codex/Cursor discriminated union; old callers must add `driver: 'codex'` to Codex intents. Host envelopes use `macos-offline-v2`; grants for v1 envelopes do not authorize v2 launches.

Cursor intents bind CLI package target `2026.07.09-a3815c0`, ACP version 1, read-only/ask mode, model, selected configuration, scope, source, view digest, expiry and limits. This package target is not a native compatibility certificate. ACP's optional agent identity may be absent; the owner must pin the actual executable, package and loaded runtime files in the host plan.

The adapter sends `initialize`, `session/new` with the snapshot cwd and no requested MCP servers, explicit `session/set_config_option` selections when needed, then `session/prompt` containing the canonical view. It does not authenticate or load prior sessions. All frames require JSON-RPC 2.0; responses correlate to exact request IDs. See [Cursor ACP](https://cursor.com/docs/cli/acp) and [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization).

Configuration IDs and values come from the agent and must be supplied by the owner. The model selector must equal the requested model, the mode selector must equal `ask`, and any additional selected setting must be advertised and confirmed. Missing configuration support, mismatched values and drift fail closed. Display labels do not prove model identity, effort, speed or billing. The synchronous response hook preserves wire order when a configuration response and a conflicting notification arrive in the same read. See [ACP configuration options](https://agentclientprotocol.com/protocol/v1/session-config-options).

Agent text chunks are collected only within the active prompt. Private thought chunks and user echoes are excluded from results. Only `end_turn` establishes completion; truncation or agent cancellation returns `interrupted` with empty output, refusal is denied, and unknown stop reasons fail. Foreign sessions, unsupported tool/plan updates, post-terminal updates and output overflow prevent release. The public `threadId` carries the ACP session ID; `turnId` is a ForgeMind-local identifier. See [ACP prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn).

Permission callbacks select an advertised reject option by its `kind`, preserving its opaque ID, or return cancelled. File/terminal callbacks, Cursor interactive requests, native delegation/artifact extensions and unknown requests are denied. A denied callback also denies the run, even if a terminal response follows. Cancellation uses the `session/cancel` notification; shutdown, reaping and durable terminal evidence remain mandatory. See [ACP tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls).

## Host and retention

Native Cursor does not provide a verified ephemeral flag here. Its intent explicitly says `ephemeral: false` and `persistence: 'private-scratch'`. The shared host supplies private HOME, XDG_CACHE_HOME and TMPDIR, no ambient credentials or account settings, and default-deny network/fork/source writes. Confirmed cleanup removes scratch; uncertain cleanup retains private state with an indeterminate receipt. This implements invocation history isolation, not durable project memory or application-wide retention defaults.

The installed shell launcher requires subprocess execution. A future native offline handshake must pin a direct runtime entry point and exact package/runtime files without broadening fork, network or home access. An empty requested MCP list and ask mode do not themselves enforce host security. See [host assembly and limits](./host-enforcement.md).

## Remaining gates

Native initialize/configuration/cancellation behavior needs a source-bound safe probe. Native full prompts then require controlled provider egress, isolated credentials and spend reservations; write tasks need exact file/command capabilities. Office Cursor and personal Codex accounts stay separate. Native delegation, cross-agent checkpoint restart, Headroom activation and live model routing are not certified by these fixtures. [Windows portable verification](./windows.md) is available; native Windows policy/sandbox execution is pending.

See [ADR-0011](./adr/ADR-0011-cursor-acp-protocol-slice.md) and [validation evidence](./artifacts/cursor-driver/validation.json).
