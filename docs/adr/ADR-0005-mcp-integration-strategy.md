# ADR-0005: MCP Integration Strategy

- Status: Accepted
- Date: 2026-08-23
- Deciders: ForgeMind maintainers

## Context

ForgeMind needs to interoperate with coding agents and external systems such as GitHub, Jira, Confluence, Google Docs, Slack, and Microsoft Teams. The Model Context Protocol (MCP) provides an open host-client-server architecture and common tools, resources, and prompts. However, connectors have different APIs, permissions, change models, and security obligations, and not all agents or systems expose MCP.

## Decision

External systems are optional connectors behind ForgeMind connector contracts. MCP is the preferred connector/context interoperability protocol where available, but it does not replace coding-agent drivers, native source adapters, or ForgeMind's internal domain model. The current 2026-07-28 protocol is stateless; ForgeMind task continuity therefore uses explicit durable state handles rather than transport sessions.

ForgeMind operates in two roles:

- As an **MCP server**, it exposes permission-aware intelligence, task packets, checkpoints, skills, and result-submission capabilities to agent hosts.
- As an **MCP host/client**, it can consume optional external MCP servers after capability negotiation, policy evaluation, and user/administrator authorization.

Native connectors remain supported when required for incremental indexing, webhook handling, ACL synchronization, API-specific queries, or stronger source/version semantics.

Each connector is isolated by organization and source account. It declares supported resources/actions, auth method, scopes, change capture, freshness, rate limits, and deletion behavior. Read and write capabilities are separate; connectors are read-only by default. Source permissions are preserved at ingestion and revalidated at retrieval/action time.

MCP registration or capability advertisement is not evidence of configuration, reachability, health, or authorization. These states are checked separately.

## Alternatives considered

### Require every integration to be an MCP server

This maximizes uniformity but excludes systems without capable servers and may not expose indexing, ACL, or change-feed details ForgeMind needs.

### Build only native connectors

This provides deep control but duplicates a growing protocol ecosystem and makes third-party extension harder.

### Let agents connect directly to every external system

Native agent integrations remain useful, but direct connections bypass ForgeMind's evidence provenance, retrieval policy, shared indexing, and audit model.

### Centralize broad connector credentials

Operationally simple but violates least privilege and magnifies breach impact.

## Consequences

### Positive

- ForgeMind interoperates with the MCP ecosystem without depending exclusively on it.
- Connectors can be deployed locally, inside a company network, or as remote services.
- Native adapters can support source-specific indexing and permissions.
- Coding agents receive one ForgeMind interface instead of company credentials for every source.

### Negative

- MCP and native connector paths both need conformance tests.
- Capability negotiation and degraded behavior add complexity.
- OAuth, consent, webhook verification, and token lifecycle vary by source.

### Risks and mitigations

- **Confused deputy/token passthrough:** audience-bound tokens, per-connector credentials, explicit purpose, no token forwarding.
- **Overbroad scopes:** least-privilege presets, admin review, per-user/delegated grants where feasible.
- **Malicious MCP server:** allowlists, capability review, isolation, output validation, network policy, and tool confirmations.
- **Stale authorization:** revocation events, short-lived grants, cache invalidation, and live checks before protected retrieval.

## Compliance

- Remote MCP authorization follows the current official MCP authorization and security guidance.
- Connector secrets remain in a broker and are never placed in task packets or memory.
- Every connector action records principal, purpose, source account, resource, scopes/capability, and result.
- Disabling or removing a connector stops retrieval and schedules derived index deletion according to policy.

## Related documents

- [Knowledge connectors](../connectors.md)
- [Security](../security.md)
- [MCP architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture)
