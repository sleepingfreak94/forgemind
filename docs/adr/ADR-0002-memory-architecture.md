# ADR-0002: Memory Architecture

- Status: Accepted
- Date: 2026-08-23
- Deciders: ForgeMind maintainers

## Context

Engineering knowledge has different owners, applicability, retention, and authority. A debugging hypothesis for one task must not become a company standard. A project-specific workaround should not affect unrelated repositories. A flat vector store cannot reliably express these boundaries, and permanent conversation storage introduces noise, privacy, poisoning, and deletion problems.

## Decision

ForgeMind will separate memory into four mandatory scopes:

1. **Global memory:** reusable, source-independent engineering knowledge approved for all installations or a public distribution.
2. **Organization memory:** company standards, tools, workflows, ownership, and validated cross-project lessons.
3. **Project memory:** repository/service decisions, patterns, fixes, mistakes, and version-specific knowledge.
4. **Session memory:** current task state, checkpoints, hypotheses, inspected evidence, and next steps.

Scope is independent from memory type. Each scope may contain facts, decisions, lessons, mistakes, patterns, fixes, or checkpoints when allowed by policy.

Memory will use structured, provenance-bearing records. Complete conversations will not be stored as permanent memory. Raw session events may exist temporarily under an explicit retention policy for checkpoint construction and audit, then be deleted or minimized.

Retrieval must filter authorization, tenant, project, validity, retention, and sensitivity before semantic/lexical/graph ranking. Similarity is never authorization.

Promotion moves a validated derivative record to a broader scope; it does not simply relabel or copy raw session content. Organization and global promotion require authorized review and independent evidence.

## Alternatives considered

### One memory store per user

Simple, but it cannot model organizational authority, project isolation, or shared validated knowledge.

### One organization-wide vector database

Operationally convenient, but too easy to leak projects, lose precise provenance, and retrieve obsolete or contradicted memories.

### Store all conversations and summarize at query time

This preserves maximum raw material but creates high cost, privacy exposure, inconsistent summaries, and complex deletion obligations.

### Let each agent manage memory

This uses native features but prevents cross-agent continuity and consistent organization policy.

## Consequences

### Positive

- Memory applicability and authority are explicit.
- Project and tenant isolation can be enforced and tested.
- Session continuity does not require replaying full histories.
- Promotion and deletion can follow scope-specific governance.
- Records remain portable across agents and storage engines.

### Negative

- Users and validators must choose or infer a scope.
- Promotion, contradiction, supersession, and retention add lifecycle complexity.
- A record may need derived representations in several indexes, all of which must support deletion.

### Risks and mitigations

- **Cross-scope leakage:** physically/logically partition by tenant and apply mandatory pre-search filters.
- **Overpromotion:** quarantine candidates and require scope-specific evidence and authorization.
- **Staleness:** record temporal applicability, expiration, last verification, and supersession.
- **Deletion gaps:** maintain a derivative manifest and propagate tombstones to vectors, graphs, caches, packets, and backups.

## Compliance

- Every durable memory record has scope, owner, provenance, evidence, confidence features, status, ACL/policy reference, and lifecycle timestamps.
- Normal task agents cannot write organization or global memory directly.
- Secrets and raw credentials are rejected before memory extraction and embedding.
- Memory APIs expose inspect, correct, supersede, export, and delete operations subject to policy.

## Related documents

- [Memory architecture](../memory.md)
- [Learning system](../learning.md)
- [Security](../security.md)

