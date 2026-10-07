# ADR-0006: Local Storage and Staged Semantic Search

- Status: Accepted
- Date: 2026-10-07
- Deciders: ForgeMind maintainer (confirmed in project conversation)

## Context

The local-first MVP needs durable task state and reusable evidence across sessions and tickets. Harness coordination and application persistence have separate responsibilities. Semantic similarity can discover related work described differently, but cannot establish ownership, authorization, or verified equivalence between tickets.

## Decision

Use SQLite as the authoritative local application store for structured tasks, checkpoints, memory, policy decisions, audit events, and code graph nodes/edges. Store large evidence artifacts and immutable skill packages in local files referenced by content digest.

Each bounded context owns its tables behind typed interfaces; other contexts must use those interfaces. Storage replacement remains possible but requires explicit migrations and compatibility validation.

Implement retrieval in this order:

1. Persist structured records with project scope, lifecycle status, source version, and evidence references.
2. Add SQLite FTS5 keyword search and labeled ticket/retrieval fixtures.
3. Add semantic retrieval behind a replaceable interface and combine it with lexical results. Compare the hybrid candidate against the keyword baseline on the same source-bound fixtures.

Semantic retrieval is required for the full MVP but deferred for the first deterministic vertical slice. Its index is derived, rebuildable data rather than authoritative memory. The embedding provider and vector implementation remain undecided until that milestone.

Apply authorization, project scope, and validity filters before semantic ranking. Exclude superseded findings by default and propagate deletion to derived indexes. Similarity can suggest relevant tickets or findings; structured records and explicit ownership govern coordination.

Keep Ruflo as the development coordination ledger, separate from ForgeMind application storage. This decision does not establish that existing harness sessions share durable records or enforce ownership; those behaviors require verification. Writing workers still need isolated worktrees and an assigned integration owner.

## Consequences

- Local persistence has no separate database server requirement.
- SQLite permits one writer at a time per database; the local runtime must coordinate short write transactions.
- Keyword retrieval provides a measurable baseline before embedding/index complexity is introduced.
- Deferring semantic retrieval for the prototype does not remove it from MVP acceptance.

## Implementation validation

- Verify schema migrations, restart/checkpoint recovery, and write contention handling.
- Verify module ownership and project/access isolation across retrieval paths.
- Verify deletion of records and their file/search/vector derivatives.
- Bind keyword and hybrid evaluation results to source and embedding/index versions.

## Related documents

- [Context retrieval strategy](./ADR-0004-context-retrieval-strategy.md)
- [Architecture](../architecture.md)
- [Memory](../memory.md)
- [Context engine](../context-engine.md)
- [Handoff](../handoff.md)
