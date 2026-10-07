# ADR-0001: Agent-Independent Architecture

- Status: Accepted
- Date: 2026-08-23
- Deciders: ForgeMind maintainers

## Context

ForgeMind must serve users of Codex, Claude Code, Cursor, and other MCP-compatible agents. These products expose different session formats, permission systems, tool schemas, orchestration features, and lifecycle events. Binding ForgeMind's task, memory, or context model to one agent SDK would make accumulated engineering intelligence non-portable and would force core migrations whenever that product changes.

Agent independence does not mean lowest-common-denominator behavior. ForgeMind needs a stable core plus negotiated extensions for richer runtimes.

## Decision

ForgeMind will use protocol-neutral, versioned domain contracts for tasks, authorization, evidence, task packets, agent invocations, results, checkpoints, policy receipts, and memory.

Each agent integration is an anti-corruption adapter implementing a common Agent Driver interface. The driver declares capabilities, maps a canonical task packet into the agent's native form, converts native events to ForgeMind events, and returns a canonical result. ACP, native SDK/App Server protocols, agent-as-MCP surfaces, and CLI subprocesses are possible driver transports. MCP remains the preferred connector/context edge but is not the internal domain model or a complete coding-agent lifecycle protocol.

Agent adapters may support optional capabilities such as native checkpoints, structured outputs, subagents, streaming, or sandbox receipts. The orchestrator must create an explicit degraded plan when a capability is unavailable.

No durable ForgeMind record may require a proprietary transcript or provider object to be interpreted.

## Alternatives considered

### Standardize on one agent SDK

This offers faster initial implementation and access to mature orchestration features. It was rejected because it creates vendor and language coupling and conflicts with the product's portability goal.

### Use MCP as the complete internal architecture

MCP provides interoperable tools, resources, prompts, capability negotiation, and transport semantics. It does not define ForgeMind's workflow state, evidence model, tenant policy, code graph, memory lifecycle, or learning governance. It remains an edge protocol.

### Build separate products per agent

Native integration would be deep but would fragment memory, skills, evaluations, and behavior. The duplication would prevent a shared engineering intelligence layer.

### Support only command-line agents

CLI subprocesses are broadly available, but text parsing and process control are weaker than structured SDK/MCP integrations. CLI can be a fallback adapter, not the canonical contract.

## Consequences

### Positive

- Teams can change or combine agent vendors without losing ForgeMind knowledge.
- Core tests can use a deterministic fake driver.
- Agent capabilities and limitations become explicit and comparable.
- Provider-specific innovation remains accessible through negotiated extensions.
- Task packets and checkpoints can be archived and replayed independently of an agent service.

### Negative

- Adapters require ongoing compatibility work.
- Some provider-native features cannot be represented uniformly.
- Conformance and capability-negotiation suites become critical infrastructure.
- Debugging spans both the ForgeMind orchestration layer and the selected agent runtime.

### Risks and mitigations

- **Semantic drift:** require golden contract tests and adapter certification.
- **False equivalence:** expose capability matrices and explicit degraded behavior.
- **Provider objects leaking into storage:** validate domain schemas at bounded-context boundaries.
- **Permission mismatch:** intersect ForgeMind policy with native agent permissions; never assume one implies the other.

## Compliance

- Every supported adapter must pass task, checkpoint, tool-grant, cancellation, error, and result conformance tests.
- Every invocation records adapter name/version, declared capabilities, packet hash, and native session reference as optional metadata.
- Core packages must not import an agent vendor SDK.

## Related decisions

- [ADR-0004](./ADR-0004-context-retrieval-strategy.md)
- [ADR-0005](./ADR-0005-mcp-integration-strategy.md)
