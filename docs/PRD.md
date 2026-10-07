# ForgeMind Product Requirements Document

Status: Draft for architecture review  
Version: 0.1  
Last updated: 2026-08-23

## Vision

ForgeMind is an open-source AI Engineering Intelligence Platform that gives any compatible coding agent the durable, permission-aware context needed to work effectively across repositories, tools, and sessions.

ForgeMind is not a new editor or model. It is the shared intelligence and orchestration layer between engineers, coding agents, source repositories, organizational knowledge, reusable skills, and validated engineering memory. A team should be able to change from Codex to Claude Code, Cursor, or another MCP-compatible agent without losing its accumulated operating knowledge.

## Problem statement

AI coding agents are effective within a well-scoped interaction but weak across the full lifecycle of engineering work:

- Agents forget previous work when a session ends or a context window is replaced.
- Long histories and large repositories consume tokens, increase latency, and dilute relevant evidence.
- Architecture decisions, incident notes, tickets, discussions, and runbooks are trapped in disconnected systems.
- Teams repeatedly rediscover the same debugging paths and failed approaches.
- General-purpose models do not know a company's conventions, ownership boundaries, deployment process, or historical trade-offs.
- Knowledge accumulated by one agent is rarely portable to another agent.
- Agent-generated “memory” can be unsafe when unverified observations become permanent rules.

The missing product is a repository-independent intelligence layer that retrieves only task-relevant evidence, packages it for different agents, preserves structured continuity, and learns conservatively from verified outcomes.

## Why current AI coding assistants are insufficient

Current assistants commonly provide repository search, chat history, rules, or agent-specific memory. Those capabilities are valuable but incomplete:

| Limitation | Product impact |
| --- | --- |
| Product-specific state | Knowledge and workflows are lost when teams change agent vendors. |
| Conversation-shaped memory | Raw dialogue contains noise, secrets, contradictory guesses, and obsolete information. |
| Repository-first context | Relevant evidence in Jira, Confluence, Slack, Google Docs, or prior incidents is omitted. |
| Broad context loading | Cost and distraction grow with history and repository size. |
| Weak provenance | Users cannot tell whether guidance came from code, policy, a person, or an agent inference. |
| Flat retrieval | Similarity alone cannot enforce tenant, project, document, or user permissions. |
| Uncontrolled learning | A single failure or hallucination can become a durable instruction. |
| Coupled orchestration | Agent roles, handoffs, and state are bound to one SDK or runtime. |

ForgeMind complements existing coding agents rather than replacing their native editing, terminal, review, and sandbox capabilities.

## Target users

### Primary users

- Individual developers who use multiple coding agents and need session continuity.
- Engineering teams that want shared debugging knowledge, standards, and reusable workflows.
- Platform engineering teams that manage tools, repositories, policies, and internal developer platforms.
- Staff and principal engineers who need architectural decisions and cross-repository context to remain discoverable.

### Secondary users

- Security and compliance teams that need explicit access boundaries and auditability.
- Engineering managers who need outcome and adoption signals without collecting private reasoning or full conversations.
- Open-source maintainers who want portable skills and project knowledge for contributors.
- Agent and tool vendors that want a standard intelligence integration point.

## Primary use cases

1. **Resume a long task:** continue in a new chat from a structured checkpoint containing objectives, evidence, decisions, failures, hypotheses, and next steps.
2. **Debug with institutional memory:** retrieve prior incidents, fixes, rejected approaches, and relevant code paths before repeating an investigation.
3. **Apply company knowledge:** add permission-filtered standards, ownership, runbooks, and architectural decisions to an agent's task packet.
4. **Understand unfamiliar code:** query a code graph for symbols, dependencies, tests, ownership, and change impact without loading an entire repository.
5. **Reuse a capability:** resolve a versioned skill such as `webrtc-debugging`, load only its relevant instructions and resources, and verify its compatibility.
6. **Coordinate specialists:** assign bounded research, coding, debugging, QA, performance, and review tasks while preserving a common objective and evidence model.
7. **Switch agents:** start with one coding agent and continue with another through the same task packet and checkpoint contracts.
8. **Learn from verified work:** extract candidate lessons from completed tasks, validate them, and promote only durable, scoped knowledge.
9. **Search organizational knowledge:** retrieve authorized evidence from GitHub, Jira, Confluence, Google Docs, Slack, and Microsoft Teams.

## Goals

- Provide agent-independent orchestration and context contracts.
- Provide repository-independent registration, indexing, and retrieval for many workspaces.
- Reduce token consumption by retrieving and compressing evidence under explicit budgets.
- Preserve continuity with structured task state, not permanent full transcripts.
- Make organizational knowledge available with source permissions and provenance intact.
- Model code as symbols and relationships for targeted context and impact analysis.
- Package reusable skills with versions, compatibility, trust, tests, and least privilege.
- Separate global, organization, project, and session memory.
- Learn conservatively through observation, validation, confidence, and promotion gates.
- Expose and consume capabilities through MCP while retaining a protocol-neutral core.
- Support local-only, self-hosted, and cloud deployment modes.
- Make every retrieved item and consequential decision attributable and auditable.

## Non-goals

- Building a foundation model, code completion model, or general-purpose chat UI.
- Replacing editors, coding agents, Git hosting, issue trackers, or documentation systems.
- Loading or permanently storing all conversations.
- Automatically granting an agent access that the user or source system does not have.
- Allowing learned content to change security policy or execute tools without validation.
- Guaranteeing fully autonomous software delivery without human or policy gates.
- Creating a universal compiler-grade semantic model for every language in the MVP.
- Mirroring every connected knowledge system as an unrestricted data lake.
- Using MCP as the internal persistence schema or workflow engine.
- Evaluating employee performance from private agent activity.

## Product principles

1. **Evidence over volume:** the smallest sufficient, attributable context wins.
2. **Portable contracts:** ForgeMind concepts must survive changes in model, agent, repository host, and deployment mode.
3. **Permissions travel with data:** ingestion never removes source ACLs; retrieval re-evaluates them.
4. **Memory is curated knowledge:** store structured lessons, decisions, mistakes, patterns, and fixes—not permanent raw chat.
5. **Learning is not authority:** observations become candidates, not policy.
6. **Local first, cloud ready:** the same logical boundaries apply to an embedded process and a distributed deployment.
7. **Human-visible state:** users can inspect, correct, export, and delete memory and checkpoints.

## Success criteria

The MVP will be considered successful when a representative pilot demonstrates:

| Measure | MVP target | Measurement |
| --- | --- | --- |
| Agent interoperability | At least 3 agents consume the same task/checkpoint contracts through MCP or an adapter | Compatibility suite |
| Continuation quality | At least 80% of benchmark tasks resume without the user restating material context | Blind continuation evaluation |
| Context efficiency | At least 50% fewer context tokens than a full-history/full-file baseline at equal or better task quality | Source-bound benchmark |
| Retrieval usefulness | At least 80% precision@10 for curated engineering questions; no unauthorized item returned in security tests | Labeled retrieval set and ACL tests |
| Debugging reuse | At least 30% reduction in repeated investigation steps on seeded recurring incidents | Task replay study |
| Provenance coverage | 100% of task-packet evidence includes source, scope, timestamp/version, and retrieval reason | Contract validation |
| Memory safety | 0 unvalidated candidates automatically promoted to organization/global memory | Promotion audit |
| Recoverability | A task can resume after process restart from its last durable checkpoint | Failure-injection test |
| User control | Users can inspect and delete project/session memory and see why an item was retrieved | Product acceptance test |

These are product hypotheses until benchmark datasets and pilot baselines are approved.

## MVP definition

### Included

- A local-first ForgeMind service with a stable, protocol-neutral domain API and MCP facade.
- Workspace registration for multiple local Git repositories without embedding repository paths in memory identities.
- Per-project PRD/SRS/ADR registration and choices for plan review, draft PRs and text/video evidence, with task-local overrides. Prepare a concrete plan before implementation; display or approve it according to owner preferences, and capture requested baseline video before edits. Preferences do not grant execution or publication authority.
- Agent adapters proven with Codex, Claude Code, and Cursor or equivalent MCP clients.
- Intent classification and deterministic routing to a small specialist set.
- Code intelligence for files, symbols, references, imports, tests, ownership metadata, and Git history for an initial language set.
- Hybrid retrieval across code, scoped memory, and installed skills.
- Evidence-budgeted task packets with provenance and permission labels.
- Structured session checkpoints and resume flows.
- Four memory scopes with explicit promotion and deletion behavior.
- A filesystem/Git-backed skill registry with validation, semantic versioning, trust metadata, and an example `webrtc-debugging` skill definition.
- A read-only GitHub connector as the first external integration; connector contracts for later systems.
- Candidate lesson extraction with manual/project-owner validation; no automatic organization/global promotion.
- Audit events for retrieval, routing, agent invocation, tool grants, checkpoints, and memory changes.

### Deferred from MVP

- Full Slack, Teams, Google Docs, Jira, and Confluence indexing.
- Cross-organization learning or a public hosted skill marketplace.
- Autonomous organization/global memory promotion.
- Complex distributed scheduling and multi-region operation.
- Write actions through knowledge connectors.
- Enterprise SSO/SCIM, legal hold, customer-managed keys, and advanced DLP.
- Compiler-complete analysis for every language.

## MVP acceptance journey

An engineer registers two repositories, connects a read-only GitHub installation, and starts a debugging task from any supported agent. ForgeMind classifies the request, retrieves relevant code-graph nodes, project memories, and an installed debugging skill, then returns a bounded task packet. After work spans the context limit, ForgeMind creates a checkpoint. A different supported agent resumes the task from that checkpoint, completes it, and submits evidence. ForgeMind records a candidate lesson, but it enters project memory only after validation. All evidence remains attributable, ACL-filtered, inspectable, and deletable.

## Dependencies and assumptions

- Agents can call MCP tools or use a thin ForgeMind adapter.
- Repository analysis can run locally or in an isolated indexer with read access.
- Connected systems expose stable identifiers, content versions, and sufficient authorization metadata.
- Teams will create evaluation questions and validate early lessons.
- The project will publish open schemas and compatibility tests before stabilizing APIs.

## Open product questions

- Which two programming languages should the first code graph support after TypeScript?
- Is GitHub required for MVP completion or should the first release be fully offline?
- Which capabilities are always user-confirmed, even when an agent already has native permission?
- What retention defaults are appropriate for session checkpoints and audit metadata?
- Should individual memory sync across organizations, or remain installation-local by default?
- What governance model approves public skills and schema changes?
