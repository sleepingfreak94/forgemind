# ADR-0013: Durable project memory and decision retrieval

- Status: Accepted for the local-owner deterministic slice
- Date: 2026-10-07
- Basis: user authorization to implement all five steps in the project-memory plan

## Decision

Implement the project portion of ADR-0002/0006 with one SQLite database per canonical workspace and project ID, stored outside the repository. Keep it separate from the existing policy database and Ruflo's development ledger. Use typed APIs, an explicit local-owner CLI and exact source citations.

Import registered PRD/SRS/Markdown ADRs as candidates. Source status and owner validation are separate dimensions. Validate exact candidate digests explicitly. Use live registered-source hashes to suppress changed, deleted, deregistered, superseded and expired evidence. Index validated records with FTS5 and apply current scope/lifecycle checks before matching. Keep deterministic ranking and a bounded cited packet.

Supersession is transactional. Deleted document versions block reimport and redact dependent content and FTS entries; content-free tombstones/audit metadata remain. Records without expiry use project-lifecycle retention. Source removal cleanup requires ingestion; retrieval suppresses unavailable sources immediately. Expiry cleanup is lazy on record access. External backups and packets are outside this store's deletion reach.

Bind recalled evidence into the supplied-plan digest and recheck during CLI review. Existing default-location stores load automatically for the same project/workspace. The service and owner CLI are trusted-host capabilities; child agents receive only evidence packets. No document, learned record or preference changes the runtime policy envelope.

## Consequences and limits

- No extra database service, provider credentials or model calls are required.
- Relocating a workspace yields a new identity/store; migration and cross-project sharing need a later explicit protocol.
- Semantic retrieval, graph retrieval and automated extraction/promotion remain subsequent milestones.
- Full documents persist locally; DLP, encryption, multiuser identity/ACLs, organization/session memory, external cache/backup deletion and Windows ACL enforcement remain unimplemented.
- Automated plan generation and live task completion remain separate; this implements memory in preparation, not permission to execute a plan.

## Validation

Restart persistence, exact-hash review, independent project identities, copied database rejection, source mutation/removal, transactional rollback/contention, candidate filtering, supersession, expiry, redaction including historical derivatives, FTS rebuild, bounded directory traversal, special-file rejection and plan-review invalidation have dedicated deterministic tests. Final evidence and independent review are in `docs/artifacts/project-memory/`.
