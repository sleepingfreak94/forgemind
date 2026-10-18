# Weekly summaries and terminal run history

This local library summarizes bounded terminal-run facts. It does not schedule jobs, invoke providers, authenticate model results, or automatically record live runs.

## Owner storage and compatibility

Use RunHistory from src/memory/run-history.ts with an external private state directory and a canonical registered project root. It shares the project's MemoryDatabase with ProjectMemory. Same run IDs in different projects/workspaces remain separate identities.

The run-history integration upgrades fresh/schema-1 stores transactionally to schema 2. Existing records, full-text retrieval, audit history and deleted-source tombstones are retained. Schema-2 stores reopen without rebuilding tables; missing or incompatible run-history definitions are rejected. Unsupported future versions are rejected. This contract concerns logical schema/data integrity; it is not a claim of byte-preserving rejection or crash-journal recovery.

Ordinary ProjectMemory opens also use this migration. Older builds accepting only schema 1 cannot reopen upgraded stores. Test the upgrade using disposable copies before replacing an older installation; downgrading requires restoring a compatible owner-managed backup, not resetting user_version or deleting tables.

Existing local-owner path and permission checks apply. Windows ACL enforcement remains the separate existing platform boundary.

## Summary API

The pure module src/memory/weekly-summary.ts exports createWeeklyAccumulator, appendWeeklyRecords, finishWeeklySummary and validateWeeklySummary, plus their typed scope/options/state/result contracts.

Supply a fixed project/workspace scope, due timestamp, and lower-exclusive/upper-inclusive sequence interval. Read genuine active RunHistory pages up to that owner-selected upper watermark. Append each page with a strictly advancing inspected cursor; do not skip unread pages. Finish only at the upper bound. Each batch is limited to 100 records; the result retains at most eight whole evidence examples within its byte budget.

Authenticated and fixture runs have separate counters. By default only authenticated examples are selected; all inspected runs still contribute to dependency accounting. Retained baseline/candidate checks and present/absent reviews impose per-group lower bounds. Larger totals remain valid when examples are omitted. Existing schema, digest construction, and deterministic pagination are preserved.

The summary protocol currently accepts project IDs matching [A-Za-z0-9][A-Za-z0-9_-]* within 128 bytes. Registered projects with broader labels can continue using existing project memory and RunHistory; summary creation rejects unsupported IDs without rewriting stored identities.

## Historical evidence and revocation

Summary JSON has historical: true and trust: evidence-only. Hashes establish consistency, not account/provider authenticity, current permissions, a billing guarantee or a trusted pagination cursor. Execution labels are structural facts; importing JSON never grants authority.

RunHistory.revoke redacts the active body and retains a permanent content-free tombstone. Reusing that run ID is rejected. Rebuild a summary from fresh active history after revocation to obtain updated dependency/result identities. Previously retained records and summaries remain structurally valid historical evidence and do not regain current authority through validation.

## Validation

Focused tests cover terminal facts, scoped history, schema migration, memory/history coexistence, real pagination/revocation, cross-project isolation, and weekly-summary counter tampering. Portable tests also exercise the existing memory CLI and cited project workflow. No weekly automation is activated by this module.
