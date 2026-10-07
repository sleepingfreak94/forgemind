# Durable project memory implementation plan

Scope: implement all five agreed steps: SQLite persistence, registered document ingestion, exact/FTS5 retrieval, lifecycle management, and cited context in supplied-plan preparation. Semantic retrieval, model-generated plans, live coding, recording and publishing are separate milestones.

The lead is the sole writer in this checkout. The independent reviewer has read-only access. The repository has no HEAD or remote; immutable baseline/candidate snapshots and a local draft PR will identify this change without committing unrelated untracked files.

## Design and acceptance

1. Store each project's records in a private local state directory outside its workspace. Bind the database to both the canonical workspace and project ID. Reject aliasing, linked database paths and incompatible schemas. Use short SQLite transactions and a bounded busy timeout.
2. Scan only registered PRD/SRS and Markdown ADRs. Preserve exact byte hashes, document status and citations. Import as candidates. No document content grants permissions or automatically validates itself.
3. Require explicit local-owner validation of an exact record digest. Check source membership and hashes on validation and every retrieval. Filter lifecycle and expiry before matching. Provide deterministic exact and FTS5 keyword retrieval and bounded packets.
4. Make supersession transactional, retain contradictions, redact deleted content and derived search entries, and keep content-free audit/tombstone metadata. Deleted versions cannot silently reappear on reingest. Expired content is purged from active storage when the store is used.
5. Connect opt-in memory to project:plan/project:prepare. Bind cited context to the plan digest and recheck it before accepting the local review. Keep the existing runtime authorization boundary.

Validation: restart recovery; two projects and cloned IDs; stale, removed and changed documents without reingest; exact-hash validation; rollback/write contention; FTS parity after rebuild; supersession/deletion/expiry; bounded context; CLI end-to-end and preparation receipt invalidation. Run focused, portable and full existing checks and an independent review. Benchmark retrieval against labeled deterministic fixtures; report coverage and measured latency without inventing an improvement over the absent baseline.

Trust boundary: local-owner library/CLI, invoked by a trusted host. Storage file access is not an agent authorization API. POSIX private modes are enforced where available; Windows filesystem ACL enforcement and native Windows validation are separate existing gaps. No model/provider call or paid service is needed for this slice.
