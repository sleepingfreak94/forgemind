# ForgeMind Roadmap

Status: Proposed  
Last updated: 2026-08-23

## Roadmap principles

- Prove portable contracts and retrieval quality before distributing services.
- Start local-first and read-only; add cloud and external writes only after security gates.
- Benchmark against source-bound baselines before claiming context or productivity gains.
- Keep policy, tenant isolation, deletion, provenance, and audit in every phase.
- A phase exits on evidence, not feature count.

## Phase 1: MVP — portable local intelligence

### Outcome

An engineer can use multiple supported coding agents with the same repository intelligence, skills, scoped project/session memory, bounded task packet, and cross-chat checkpoint.

### Scope

- Publish versioned canonical schemas and conformance fixtures.
- Local modular-monolith service with API/CLI and MCP server facade.
- Agent Driver interface plus three proven adapters: prioritize ACP/native structured interfaces and keep CLI as fallback.
- Multiple local Git workspace registration with exact source/snapshot identity.
- TypeScript-first code graph with a documented language-analyzer interface; add one second language only if evaluation capacity permits.
- Intent classification, deterministic orchestration, Research/Debugger/Coder/QA/Reviewer profiles.
- Hybrid code, project/session memory, and skill retrieval.
- Context budgets, immutable task packets, checkpoint/resume, and provenance.
- Four memory scopes in schema; only project/session writes enabled by default.
- Filesystem/Git skill registry, semantic versions/digests, validation, and `webrtc-debugging` example.
- Read-only GitHub connector and common connector contract.
- Candidate lesson extraction with manual project validation.
- Security/audit baseline, deletion propagation, and offline mode.

### Exit criteria

- Codex, Claude Code, and Cursor/equivalent adapters pass the same task/checkpoint/result conformance suite.
- At least 80% continuation success on the approved benchmark.
- At least 50% context-token reduction versus full-history/full-file baseline at equal or better task quality.
- At least 80% precision@10 on a labeled local code/project-memory set.
- Zero unauthorized items in ACL/isolation tests.
- Process restart resumes from the last durable checkpoint.
- Every evidence item and invocation has source/packet provenance.

### Explicitly excluded

Distributed orchestration, tenant-wide chat indexing, connector writes, public marketplace, automatic shared-memory promotion, enterprise SSO/SCIM, and broad language coverage.

## Phase 2: Knowledge integrations

### Outcome

Teams retrieve authorized organizational evidence across engineering systems with source permissions, freshness, and deletion intact.

### Scope

- Google Docs/Drive, Confluence, and Jira connectors; Slack and Teams after privacy review.
- Backfill, incremental change capture, reconciliation, tombstones, and connector health.
- ACL-aware hybrid indexed/live retrieval and source citations.
- Organization identity/group mapping and delegated/resource-specific consent.
- Organization memory read path and authorized document-to-memory proposals.
- More language analyzers and cross-repository dependency/ownership graph.
- Self-hosted deployment, secret manager, queue/workers, and enterprise observability export.
- Retrieval administration, source coverage, freshness, and deletion dashboards.

### Exit criteria

- Connector contract and ACL/deletion suites pass for every source.
- Revocation suppresses retrieval within the approved SLA and deletes derivatives within policy.
- Retrieval quality meets source-specific labeled evaluations.
- Connector outages and stale indexes are visible and do not imply exhaustive search.
- Security review approves message-platform data handling before general availability.

## Phase 3: Learning system

### Outcome

Verified engineering outcomes improve project and organization knowledge without one-shot rule formation or memory poisoning.

### Scope

- Full observation/candidate/confidence/validation/promotion lifecycle.
- Contradiction, supersession, expiry, revalidation, and feedback signals.
- Project promotion policies with deterministic evidence options.
- Organization validator workflow and human approval.
- Generated skill candidate pipeline with sandbox/evaluation gates.
- Independent replay evaluations and causal/temporal graph experiments.
- Memory quality, reuse, correction, regression, and governance dashboards.

### Exit criteria

- No unvalidated candidate reaches trusted organization/global memory.
- Promoted lessons show measurable reuse benefit and acceptable correction rate on pilots.
- False generalization, sensitive promotion, and poisoning tests meet the approved risk threshold.
- Users can inspect evidence, correct, supersede, and delete learned knowledge.
- Generated skills cannot publish or expand authority without independent review.

## Phase 4: Enterprise features

### Outcome

ForgeMind supports regulated, multi-tenant, high-scale engineering organizations with deployment and governance choices.

### Scope

- Managed multi-tenant and dedicated single-tenant data planes.
- SSO, SCIM, enterprise RBAC/ABAC, policy-as-code, approval workflows, and audit export.
- Customer-managed keys, private networking, regional placement, DLP, retention/legal hold, backup/restore.
- High-availability orchestration, horizontally scalable indexing/retrieval, quotas, budgets, and chargeback.
- Private skill/MCP registries with signing, attestations, malware scanning, transparency, revocation, and governance.
- Advanced connector administration and customer-network workers.
- Compliance readiness and external penetration/security assessments.

### Exit criteria

- Independent multi-tenant security assessment passes.
- Recovery, regional, deletion, key-rotation, and incident-response objectives are demonstrated.
- Policy receipts bind every consequential action to principal, source, grant, and result.
- Capacity and cost benchmarks meet approved service objectives.

## Cross-phase workstreams

| Workstream | Continuous requirement |
| --- | --- |
| Schemas and compatibility | Versioning, migrations, golden fixtures, adapter/connector conformance |
| Security | Threat modeling, least privilege, isolation, deletion, red-team and incident drills |
| Evaluation | Fixed baselines, source identity, retrieval/task/continuation metrics, human rubrics |
| Governance | ADRs, public API review, skill/memory promotion roles, deprecation policy |
| Documentation | Operator, contributor, adapter, connector, skill, policy, and threat-model guidance |
| Community | Contribution model, roadmap transparency, reference plugins, interoperability collaboration |

## Recommended immediate milestones

1. Ratify the five initial ADRs and resolve MVP language/storage/driver choices.
2. Freeze v0 task packet, evidence, checkpoint, memory, and policy schemas as design artifacts.
3. Build evaluation fixtures and security tests before runtime implementation.
4. Prototype one end-to-end vertical slice using fake/deterministic adapters.
5. Add real Agent Drivers one at a time behind conformance tests.

Dates are intentionally omitted until maintainers decide team capacity, release cadence, and quality gates.

