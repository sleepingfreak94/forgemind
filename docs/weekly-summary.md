# Weekly summaries and terminal run history

The local owner flow reserves stable run IDs, imports supervised workflow artifacts, summarizes actual terminal history, and supports an explicitly enabled one-shot weekly tick. It makes no provider requests, accesses no accounts, installs no OS job or daemon, and performs no external delivery. Importing or generating a summary never automatically enables scheduling.

## Owner storage and compatibility

Use RunHistory from src/memory/run-history.ts with an external private state directory and a canonical registered original project root. It shares the project's MemoryDatabase with ProjectMemory. Same run IDs in different projects/workspaces remain separate identities. Supply the original registered workspace, not a task worktree or a symlink alias.

The run-history integration upgrades fresh/schema-1 stores transactionally to schema 2. Existing records, full-text retrieval, audit history and deleted-source tombstones are retained. Schema-2 stores reopen without rebuilding tables; missing or incompatible run-history definitions are rejected. Unsupported future versions are rejected. This contract concerns logical schema/data integrity; it is not a claim of byte-preserving rejection or crash-journal recovery.

Ordinary ProjectMemory opens also use this migration. Older builds accepting only schema 1 cannot reopen upgraded stores. Test the upgrade using disposable copies before replacing an older installation; downgrading requires restoring a compatible owner-managed backup, not resetting user_version or deleting tables.

Reservations, import pins, schedule configuration, cursors and retained summaries use a separate scoped SQLite database under STATE/weekly-owner. This database reuses MemoryDatabase's safe path, identity, transaction and schema-2 primitives, with one strictly checked owner_values table. It adds no tables or version changes to the existing project memory database. Existing owner databases with a missing/incompatible owner table or unexpected triggers are rejected. Logical values have canonical JSON and integrity hashes; those hashes do not defend against a malicious owner who controls the database.

State directories must be canonical and external to the original project. Databases and artifacts must be regular files with one link; symlinks, hardlinks and noncanonical paths are rejected. Where process.getuid is available, owner identity and private POSIX permission bits are enforced together for storage and artifact reads. Where it is unavailable, those POSIX checks are inapplicable; canonical paths, file types, link counts, bounds, digests and strict UTF-8 checks still apply. Windows ACL enforcement remains a separate platform boundary. These reader/storage rules do not extend the supervised executor's platform support.

## Standalone owner commands

Build using the existing project build first. No package manifest or dependencies are added. The entry point is import guarded, and exports parseSummaryArgs and summaryMain for host callers. All timestamps are decimal integer milliseconds since Unix epoch; sequences are nonnegative decimal safe integers. Unknown, duplicate and command-inapplicable flags are errors. Errors exit with code 2 and do not output an unvalidated result.

CLI failures write exactly `Weekly command failed: invalid owner input. Use --help.` followed by a newline to stderr. Private parser and I/O failure details are never echoed; the public error does not inspect thrown objects or their getters. Inspect private owner artifacts for authorized debugging. Interrupted stdout still permits recovery of committed summaries with result.

Every command requires explicit --workspace and --state-dir. Example paths below are placeholders for canonical private owner paths:

```sh
node dist/src/local-runtime/summary-cli.js --help
node dist/src/local-runtime/summary-cli.js prepare --workspace /work/project --state-dir /private/owner-state --reservation ticket-42 --task ticket-42 --provenance fixture
node dist/src/local-runtime/summary-cli.js record --workspace /work/project --state-dir /private/owner-state --reservation ticket-42 --manifest /private/artifacts/manifest.json --manifest-sha256 OWNER_SELECTED_SHA256
node dist/src/local-runtime/summary-cli.js generate --workspace /work/project --state-dir /private/owner-state --due 1792297800000 --lower 0 --page-size 100
node dist/src/local-runtime/summary-cli.js status --workspace /work/project --state-dir /private/owner-state
node dist/src/local-runtime/summary-cli.js config --workspace /work/project --state-dir /private/owner-state --enable true
node dist/src/local-runtime/summary-cli.js tick --workspace /work/project --state-dir /private/owner-state
node dist/src/local-runtime/summary-cli.js result --workspace /work/project --state-dir /private/owner-state
node dist/src/local-runtime/summary-cli.js disable --workspace /work/project --state-dir /private/owner-state
```

prepare requires --provenance fixture or authenticated. generate optionally accepts --upper SEQUENCE, --selection authenticated|all, --max-bytes BYTES and --page-size 1..100. config optionally accepts --selection and --max-bytes. The default selection is authenticated and the default summary budget is 8192 bytes, with an upper limit of 65536 and a minimum determined by the summary metadata reservation. result optionally accepts --due MS to read an earlier committed result. Manual generate writes validated JSON to stdout; there is no privileged arbitrary output-file flag. Scheduled results are retained privately in the database and exported to stdout after commit.

## Owner preparation and verified artifact recording

src/memory/run-recording.ts exports OwnerRunRecorder, OwnerReservation, OwnerArtifactManifest, ArtifactBinding and readOwnerJSON. Construct OwnerRunRecorder(stateDirectory, originalRoot, clock?), call prepare({reservationId, taskId, execution}) BEFORE execution, and retain its returned runId. The owner chooses the reservation ID and provenance explicitly; the recorder generates the run ID and captures the actual preparation timestamp. Repeating identical preparation after a restart returns the original reservation. Changing its task or provenance is rejected. Run and reservation identity are bound to projectId and canonical originalRoot.

Run the separately authorized supervised workflow. This recorder does not invoke it or modify the orchestrator. After it ends, the trusted owner selects its actual artifact directory and creates a digest-pinned manifest alongside receipt.json, before-checks.json, after-checks.json and review.json. Select and verify the manifest digest outside model output, then call record(reservationId, manifestPath, manifestSha256). A manifest has this shape (hash placeholders must be replaced with SHA-256 of the exact file bytes):

```json
{
  "schemaVersion": 1,
  "projectId": "project-a",
  "originalRoot": "/work/project",
  "runId": "HASH_FROM_PREPARE",
  "taskId": "ticket-42",
  "endedAt": 1792297800000,
  "artifacts": {
    "receipt.json": { "sha256": "EXACT_RECEIPT_BYTES_HASH" },
    "before-checks.json": { "sha256": "EXACT_BEFORE_BYTES_HASH", "source": "WORKTREE_PHASE_SOURCE", "phaseSeq": 1 },
    "after-checks.json": { "sha256": "EXACT_AFTER_BYTES_HASH", "source": "CANDIDATE_PHASE_SOURCE", "phaseSeq": 3 },
    "review.json": { "sha256": "EXACT_REVIEW_BYTES_HASH", "source": "CANDIDATE_PHASE_SOURCE", "phaseSeq": 4, "independent": true }
  }
}
```

The phase numbers above are illustrative; use actual receipt phase sequences. endedAt is actual owner terminal metadata, not a time synthesized from file modification times or model assertions. It must follow the reserved start and not be in the future at import. Receipt timestamps must be natural integer milliseconds, ordered consistently, and lie within the reserved start and manifest end. This API requires preparation before execution; a separate owner import of historical evidence must use the first and last actual receipt timestamps without claiming a preallocated reservation. All four artifact keys are required. For optional evidence that truly does not exist, set its entry to null; an existing malformed file cannot be hidden as absent. Files are bounded to 1 MiB, decoded as strict UTF-8, and verified against exact byte hashes. Parent directories must be canonical and satisfy applicable owner/privacy checks, and artifact filenames are fixed; no archive extraction or arbitrary relative paths are accepted.

The actual orchestrator RunAuthority.export() envelope has taskId, run with id/status/requests/input_bytes, phases containing seq/name/source/data (data is a JSON string), and receipts. The recorder rejects native-executor completion envelopes and other JSON shapes. When present, the first worktree phase supplies the baseline source; the candidate phase supplies candidate source and actual changed paths. Repeated or ambiguous source phases are rejected. Check arrays contain only id/passed/exitCode/stdout/stderr. The manifest binds before checks to the worktree phase and after checks to the candidate phase. Both check artifacts are validated before terminal assignment; duplicate check IDs within either artifact are rejected, while baseline and candidate may share an ID. Check facts are grouped by the exact SHA-256 of JSON.stringify(actualCheckResult), phase/manifest source, and reserved task. For each group, the number of matching validated external.finished command.run terminals must exactly equal the number of claimed check facts. Distinct terminals are consumed one-to-one in receipt order across both artifacts. Identical before/after source and result bytes are allowed only with two distinct matching terminals for the two claims. Extra or unclaimed matches within a claimed group, missing matches, and any contradictory matching outcome are rejected; no terminal can be skipped to select a successful outcome. The producer terminal outcome must be completed for a passed check and failed for a null or nonzero exit code. A null exit code remains indeterminate in check history; it cannot bind to a completed terminal or enter completed run history. Receipt IDs and terminal requests are unique; no check may reuse a terminal receipt across either artifact. Missing, malformed, contradictory or excess bindings and per-phase duplicate check IDs are rejected even when all outer artifact/manifest hashes have been recomputed. Unrelated policy events are retained, including worktree/provider finishes without check output digests. Artifact bytes are read without rewriting them. These hashes establish consistency, not authenticity.

Review must bind to the reviewed phase at the same candidate source, match the saved verdict and source, and carry the owner's explicit independent:true declaration. Completed history always requires an actual worktree and candidate, actual run.status=completed, a nonempty set of all-passing candidate checks, and an independent PASS review at that candidate source. terminalRun applies the completion gate again. Independent review remains a separate requirement from native execution: native execution completed never means the task completed.

Failed, blocked and running receipts may honestly precede worktree creation. A single valid session.started event supplies their baseline source, with outcome allow and reason trusted-local-launch; this event has no taskId. Missing, ambiguous or malformed session baselines are rejected. Such early receipts have no candidate/review phases or optional check/review artifacts. No phases maps to setup; an actual failed phase maps to terminal and must use the session source. No worktree phase is invented. A session baseline may differ from a later worktree source because worktree creation changes the branch/source identity. Failed and blocked receipts preserve partial facts. A retained running receipt is recorded as indeterminate, without inventing terminal success. Known last phases are mapped to the history phase vocabulary; unsupported last phases fail closed.

The recorder stores actual reservation/terminal metadata and exact artifact digests, with only paths present in the candidate phase. An exact import is idempotent. Changed imports, conflicting RunHistory facts and revoked IDs are rejected. History commits before the import marker; if persistence is interrupted between them, retry the same reserved ID, manifest and artifacts after restart. RunHistory's stable identity and fact comparison recover this case without rerunning execution. Never create a second execution to repair history persistence.

This is structural evidence, not provider authentication. The owner selects provenance fixture or authenticated; JSON, hashes, independent:true and the authenticated label cannot prove provider identity or that a reviewer was independent. The trusted owner must establish those facts through its supervised execution and review process. No JSON input creates new execution authority. Fixtures use fixture provenance unless a test explicitly exercises the structural meaning of an owner-provided label.

## Summary API

The pure module src/memory/weekly-summary.ts exports createWeeklyAccumulator, appendWeeklyRecords, finishWeeklySummary and validateWeeklySummary, plus their typed scope/options/state/result contracts.

Supply a fixed project/workspace scope, due timestamp, and lower-exclusive/upper-inclusive sequence interval. Read genuine active RunHistory pages up to that owner-selected upper watermark. Append each page with a strictly advancing inspected cursor; do not skip unread pages. Finish only at the upper bound. Each batch is limited to 100 records; the result retains at most eight whole evidence examples within its byte budget.

src/memory/weekly-service.ts exports WeeklyService and GenerateWeeklyOptions. Construct it with (stateDirectory, originalRoot), then call generate({dueAt, lowerExclusive, upperInclusive?, pageSize?, executionSelection?, maxBytes?}). If omitted, the upper watermark is selected once by a genuine descending limit-1 history read, bounded below by the existing cursor. Every page reads actual ascending rows, advances only through the last returned sequence, and issues an empty bounded read before advancing across any remaining revoked gap. Newer rows beyond the fixed upper bound are excluded. No synthetic factual records are constructed. Generation rechecks registered scope and validates the final summary before returning it. Close service handles when finished.

Authenticated and fixture runs have separate counters. By default only authenticated examples are selected; all inspected runs still contribute to dependency accounting. Retained baseline/candidate checks and present/absent reviews impose per-group lower bounds. Larger totals remain valid when examples are omitted. Existing schema, digest construction, and deterministic pagination are preserved.

The summary protocol currently accepts project IDs matching [A-Za-z0-9][A-Za-z0-9_-]* within 128 bytes. Registered projects with broader labels can continue using existing project memory and RunHistory; summary creation rejects unsupported IDs without rewriting stored identities.

## Durable explicit weekly ticks

src/memory/weekly-schedule.ts exports WeeklySchedule. Construct it with (stateDirectory, originalRoot, clock?), then use configure(options?), status(), disable(), tick() and result(dueAt?). Each instance is scoped; there is no mutable global activation.

A new schedule is inactive. configure explicitly enables it and stores the activation time. Reconfiguration/re-enabling retains the original activation, cursor and past results. disable prevents subsequent ticks from generating results and retains reservations, history and summary receipts. status is observational and does not enable anything. No background process is installed or started.

The existing weeklyDue calculation supplies Sunday 10:00 Asia/Kolkata (04:30 UTC), with supported input dates in [2000, 2100). Before the first boundary on or after activation, a tick reports not-due. Missed weeks collapse to the latest eligible due boundary. Each committed interval starts after the previous cursor and uses a fixed upper watermark selected for that tick.

BEGIN IMMEDIATE serializes concurrent tick/configuration/disable calls. Due selection, generation, final validation, saved summary, latest completed due and cursor commit atomically in the owner database. Generation errors or interruption before commit roll everything back: no partially advanced cursor or pending output file exists. A retry may safely choose a new upper watermark after rollback. Completed due boundaries are never regenerated by tick, including after restart.

Output happens only after commit. If stdout is interrupted, use result (or result --due MS) to read the exact committed historical summary rather than regenerating an old week. There is no separate summary-file delivery and no need for a file outbox. result remains available when disabled. The API returns validated stored content; the CLI serializes it consistently as JSON. This repair does not imply delivery acknowledgment or current validity of revoked history.

## Historical evidence and revocation

Summary JSON has historical: true and trust: evidence-only. Hashes establish consistency, not account/provider authenticity, current permissions, a billing guarantee or a trusted pagination cursor. Execution labels are structural facts; importing JSON never grants authority.

RunHistory.revoke redacts the active body and retains a permanent content-free tombstone. Reusing that run ID is rejected. Rebuild a manual summary from fresh active history after revocation to obtain updated dependency/result identities. New scheduled summaries use fresh active rows within their new interval. Previously retained records and summaries remain structurally valid historical evidence and do not regain current authority through validation. Historical scheduled results are not silently rewritten.

## Validation

Existing focused tests cover terminal facts, scoped history, schema migration, memory/history coexistence, real pagination/revocation, cross-project isolation, and weekly-summary counter tampering. Added pure filesystem/SQLite suites cover owner artifact recording, service paging and explicit scheduling, with injected deterministic clocks and sandbox TMPDIR fixtures. These three suites do not fork processes or access providers, credentials or networks. summary-cli.test.ts is HOST ONLY: it includes compiled-entry subprocess tests and must run after a host build, outside native no-fork checks. Parsing/main are also independently callable for pure validation.

The initial recovery packet compiles the new suites and executes only the predefined existing weekly tests and strict-types checks. Execution of the newly added suites belongs to a subsequent read-only validation packet; their presence does not claim they have run. No independent review or draft PR is supplied by this module.
