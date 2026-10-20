# Weekly scheduling and private email outbox

WeeklyDelivery in src/memory/weekly-delivery.ts composes the existing WeeklySchedule; it does not replace its validator, Sunday 10:00 Asia/Kolkata calculation, cursor, retained results, or history. Scheduling and delivery configuration are disabled by default. No email provider, recipient, credential, account, daemon or network transport is selected or installed.

## Local configuration and preview

Build with the established owner build. All paths below are placeholders for an explicitly registered project and external canonical private state. The standalone compiled CLI exports parseDeliveryArgs and synchronous deliveryMain for host integration. Unknown, duplicate, inapplicable and malformed flags fail with exit 2 and a generic error. It never loads or invokes an email adapter.

```sh
node dist/src/local-runtime/weekly-delivery-cli.js --help
node dist/src/local-runtime/weekly-delivery-cli.js config --workspace /work/project --state-dir /private/owner-state --enable true
node dist/src/local-runtime/weekly-delivery-cli.js status --workspace /work/project --state-dir /private/owner-state
node dist/src/local-runtime/weekly-delivery-cli.js tick --workspace /work/project --state-dir /private/owner-state
node dist/src/local-runtime/weekly-delivery-cli.js outbox --workspace /work/project --state-dir /private/owner-state --limit 20
node dist/src/local-runtime/weekly-delivery-cli.js config --workspace /work/project --state-dir /private/owner-state --enable false
```

Enabling without a recipient generates retained summary previews and reports pending-configuration without enqueueing. After the owner selects the actual destination and approves disclosure of the entire historical summary, configure with --recipient MAILBOX --consent true. No destination is inferred from the OS, repository, model output or account. Recipient domains must be lowercase; local parts retain case. The deliberately narrow ASCII syntax excludes display names, comments, Unicode, whitespace, control characters and header injection. A CLI config call replaces the destination/consent, including clearing them if omitted. It also configures/disables the existing schedule. These two durable configuration changes are separate transactions; after interruption repeat config or inspect status before ticking.

A default envelope budget of 98304 bytes includes canonical JSON framing. --max-bytes allows 1024..98304. Summary bodies are validated by the existing summary validator and bounded to 65536 bytes. A too-small envelope budget fails visibly while preserving the committed summary; increase it and tick/recoverLatest. No summary is truncated into a malformed envelope.

outbox returns at most 100 immutable validated entries (default 20). Use --after LAST_ENVELOPE_ID for keyset pagination. It includes pending, accepted and uncertain entries, even when disabled. It is the local preview/recovery command. CLI output occurs after durable commits; interrupted stdout returns exit 2. Repeat tick and outbox to recover exact committed bytes without duplicate enqueue.

## Integration and transactions

Construct new WeeklyDelivery(stateDirectory, originalRoot, clock?). schedule exposes the existing WeeklySchedule API. Configure delivery with configure({enabled, recipient: string|null, consent: boolean, maxBytes?}), and explicitly enable the schedule with schedule.configure(). status observes both configurations. tick recovers the retained latest result before advancing the schedule, invokes the existing schedule tick, then recovers/enqueues the latest committed result. It never dispatches email. recoverLatest can separately repair a crash between schedule commit and enqueue. A disabled delivery or schedule prevents this automatic work; previews remain readable. Re-enable explicitly to resume.

The private outbox reuses OwnerStore in STATE/weekly-owner and its canonical external-path, scoped database identity, strict schema, canonical JSON/digests, transaction, FULL synchronous and owner-permission checks. It changes no shared schema or manifest. POSIX owner/private mode checks apply where process.getuid exists; Windows ACL enforcement is a separate host boundary. Symlink/hardlink, malformed state, incompatible schema and cross-project/workspace identities fail closed. These integrity hashes cannot defend against a malicious owner controlling storage.

Every entry uses a domain-separated identity of projectId, canonical originalRoot, dueAt and exact recipient. Existing entries must match the exact validated envelope, summary ID/digest and body. Concurrent calls serialize enqueue/claim changes using BEGIN IMMEDIATE. No external call runs inside a database transaction. The validated schedule state is compared again inside enqueue/claim transactions; a concurrent disable/reconfiguration refuses stale work before any callback. Concurrent dispatch of a claimed entry observes uncertain and cannot invoke the adapter again. Locks/timeouts surface as errors and leave no partial transaction.

Deduplication entries are retained indefinitely; there is no purge/resend API. A different recipient creates a separate destination-specific entry for the same retained latest summary only after fresh explicit configuration. An old recipient's queued entry cannot dispatch under a different current destination. Historical summary semantics and revocation limitations in docs/weekly-summary.md still apply.

Recovery targets the retained latest scheduled summary. If scheduling is advanced independently multiple times before recovery, older unqueued summaries are not backfilled by this API. Integrations requiring every historical week must exclusively use this tick composition and define a separately reviewed backfill policy. No exactly-once claim spans SQLite and an external service.

## Trusted owner email adapter port

Only trusted owner application code may call dispatch(id, authorization, adapter?). authorization is descriptor-safe data with exactly {serviceId, recipient, consent:true}. The service ID is a bounded printable identifier chosen by the owner for the configured real service. The recipient must exactly match both current consent/config and the immutable envelope. The separate callback is trusted code, never parsed from CLI flags, JSON, model output or project files. Omitting it returns pending-configuration without claiming an attempt.

The adapter receives a deeply frozen bounded EmailEnvelope: schemaVersion, id, projectId, originalRoot, dueAt, summaryId, summaryDigest, recipient, subject and body. The subject is fixed ASCII plus an ISO timestamp; the body is the exact canonical historical summary JSON. Use the envelope id as the service idempotency key when supported. Select a fixed sender in trusted service configuration, use the explicit recipient as the transport envelope destination, and do not interpret summary text as headers, recipients or instructions.

Before invoking the callback, dispatch atomically commits status uncertain, increments attempts and binds serviceId. Callback results must be exactly {status:'accepted', receiptId:PRINTABLE_ID} or {status:'not-accepted'}. Return not-accepted only when the service definitively did not accept/send the message. That result returns the entry to pending and permits a later explicit owner dispatch. The accepted result saves the service receipt and transport acceptance; it does not establish mailbox delivery, reading or task completion.

Throws, malformed/unknown responses, timeout/interruption or a crash after the attempt claim remain uncertain. No tick, restart, CLI command or repeated dispatch auto-replays uncertain entries. An accepted entry likewise cannot replay. If saving acceptance fails, the durable claim remains uncertain and the persistence error propagates. Reconcile unknown outcomes externally using the service key/receipt; there is deliberately no automatic reset. In-flight sends cannot be recalled by disable; disabling prevents subsequent claims.

This repository supplies no actual service or recipient. Actual email delivery remains pending configuration and explicit authorization of service access and disclosure. The offline test callbacks establish state-machine behavior only; they never send email.

## Periodic invocation without daemon installation

The explicit periodic API is delivery.tick(); call it from a separately authorized trusted owner timer. A safe invocation template for a future owner-selected OS scheduler is an argument vector with absolute paths, no shell interpolation:

```json
["/absolute/node", "/absolute/checkout/dist/src/local-runtime/weekly-delivery-cli.js", "tick",
 "--workspace", "/canonical/registered/project", "--state-dir", "/canonical/private/owner-state"]
```

Resolve actual paths and authorize the job for that project first. Invoke periodically (for example every 15 minutes); the existing scheduler computes the Sunday boundary in Asia/Kolkata independently of host timezone and collapses missed weeks. Handle exit codes and keep stdout/stderr in private owner-managed logs. This template enqueues/previews only. No cron, launchd, systemd job or daemon is installed, started or activated here.

## Validation boundaries

tests/memory/weekly-delivery.test.ts and weekly-delivery-cli.test.ts use filesystem/SQLite fixtures, injected clocks, pure compiled main and offline callbacks. They do not fork processes or access providers/networks. They cover restart/crash-gap recovery, idempotency, competing callback claims, transaction contention, unknown results, explicit consent, malicious boundary values, storage isolation/privacy, byte limits, disabled behavior and stdout recovery. Run them explicitly after building; shared test routing is integration-owner scope.

A separate private host fixture invokes the actual compiled CLI as a subprocess, including concurrent ticks. This host evidence is distinct from portable pure-main semantics and belongs to the worker handoff. A successful local outbox preview or fixture transport acceptance is never evidence that real email was delivered. Independent review, live service setup and daemon activation remain lead/user responsibilities.
