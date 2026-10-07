# ADR-0004: Context Retrieval Strategy

- Status: Accepted
- Date: 2026-08-23
- Deciders: ForgeMind maintainers

## Context

Whole repositories and complete conversation histories are expensive and often reduce model quality by mixing relevant, stale, duplicated, and contradictory information. ForgeMind must provide sufficient context for engineering work while respecting token, latency, cost, permissions, and source freshness.

## Decision

ForgeMind will never load an entire repository or all conversations by default. It uses a staged, evidence-budgeted retrieval pipeline:

```text
Task
  ↓
Intent and risk classification
  ↓
Code graph retrieval
  ↓
Memory retrieval
  ↓
Skill retrieval
  ↓
Knowledge retrieval and evidence fusion
  ↓
Context packet
```

The stages may execute concurrently after classification; the diagram expresses logical dependency, not mandatory serialization.

Retrieval first applies tenant, principal, project, sensitivity, source ACL, temporal validity, and policy filters. It then combines exact/lexical search, semantic similarity, graph traversal, metadata, freshness, and source authority. The context builder deduplicates, resolves supersession, identifies contradictions, and allocates explicit budgets to mandatory constraints, checkpoint state, code, knowledge, memory, and skills.

Every included evidence item has a stable source, version/hash, retrieval reason, relevance information, timestamp, and ACL label. The task packet states material omissions, stale sources, conflicts, and budget exhaustion.

Agents may request evidence expansion through ForgeMind rather than receiving unbounded context initially.

## Alternatives considered

### Load the whole repository when it fits

Simple, but size is not relevance; it increases cost and distraction and produces unstable behavior near limits.

### Replay the full conversation

Preserves dialogue but retains failed reasoning, duplicates, secrets, and obsolete assumptions. Structured checkpoints are safer and smaller.

### Use vector search only

Semantic similarity is weak for exact error strings, symbols, versions, permissions, and graph relationships.

### Let each agent choose its own retrieval

Native search remains useful for local exploration, but a shared platform requires consistent provenance, ACLs, budgets, and cross-source evidence.

## Consequences

### Positive

- Context cost and latency become measurable and controllable.
- Evidence remains attributable and permission-aware.
- Checkpoints support cross-agent continuation.
- Retrieval quality can be evaluated independently of generation quality.

### Negative

- Retrieval can omit necessary evidence.
- Ranking, compression, and contradiction handling require ongoing evaluation.
- Index freshness must be visible and managed.

### Risks and mitigations

- **False negatives:** query decomposition, graph expansion, evidence-on-demand, user pinning, and retrieval evaluation sets.
- **Compression distortion:** retain citations and allow source expansion; do not summarize mandatory policy beyond approved forms.
- **Stale indexes:** bind revisions, expose freshness, process change events, and live-fetch before consequential decisions.
- **Prompt injection in evidence:** delimit evidence as untrusted data and keep policy/instructions in separate packet sections.

## Compliance

- Every agent invocation binds to an immutable task-packet hash.
- Mandatory constraints cannot be silently dropped to meet a budget.
- Full-repository or full-history loading requires an explicit exceptional mode, policy approval, and an audit event.
- Retrieval benchmarks compare against source-bound baselines and include ACL leakage tests.

## Related documents

- [Context engine](../context-engine.md)
- [Architecture](../architecture.md)

