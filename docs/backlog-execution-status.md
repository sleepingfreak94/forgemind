# Backlog execution and partial delivery

Baseline is the user-merged PR23 commit `01ba5eaf0def07696ec6aec6b0d76a782e944736`. The implementation follows the owner's rule: use the harness, record each failure before repair, attempt at most two focused repairs for a bug, then park that dependency and continue independent work. Prior evidence is retained; passing fixture checks do not erase a failed provider run.

## Included slices

| Slice | Resulting behavior | Scope |
| --- | --- | --- |
| [Automatic run history](automatic-run-history.md) | A configured trusted host reserves before supervised execution and imports actual receipt/check/review artifacts afterward; persistence recovery does not rerun coding | Supervised `runTask` API; exact-source owner review attestation remains required |
| [Weekly outbox](weekly-delivery.md) | Explicit weekly tick produces a validated summary and durable destination-specific pending email entry; restart and concurrent ticks deduplicate | Private outbox and trusted adapter port; CLI never sends email |
| [Local organization sharing](local-organization-sharing.md) | Explicit local-owner membership, roles, project grants, source approval, copying, revocation and stale-source invalidation | Owner-asserted local labels; no remote identity service or automatic promotion |
| [Native transition evidence](native-transition-evidence.md) | Edited exports retain actual transition envelopes and matching policy decision/terminal bindings | Historical consistency only; legacy exports without bindings remain partial |
| [Selected native capture](native-full-capture.md) | Aggregate selected results/check logs above the per-artifact limit use lossless verified chunks | Existing artifact/bundle limits stay fixed; overflow remains incomplete |

Existing project memory persistence and keyword recall remain available. No new embedding backend is included in this candidate. Every source slice received separate independent component review before integration; the PR handoff records the combined-source checks and final aggregate verdict, which these component observations cannot replace.

## Parked and unconfigured work

B024 remains unresolved. A fresh bounded read-only canary through the unchanged qualified runtime stopped before any tool call with `other`, HTTP null and zero retries. Its retained native log reports a disconnected stream while sending the request. This narrows that fresh attempt to a request/stream failure; it does not prove the historical cause or a local defect. The preserved provider failure is not relabelled as a successful run.

The pinned local embedding candidate passed Mac checks and real cached CPU smoke tests, but independent re-review found a remaining Windows layout mismatch after the related repair budget reached two attempts. The whole new embedding component is parked in its isolated checkout, with its exact source, attempts and review retained. No third repair, test-routing bypass or default activation is included.

LOG-A1 remains open: an earlier public fixture check completed with a retained result digest matching 524,288 generated stdout bytes instead of 600,000. The raw failed-attempt result was not persisted; the length finding relies on the known result layout and SHA-256 integrity assumptions. A pre-existing supervisor flushing race is plausible but unproven. The final diagnostic fixture passed without a production repair; this does not establish general child-log completeness. Chunked capture preserves the selected input it receives, within its fixed limits. Both bounded combined fixture repairs and the original anomaly are retained; no further replay is performed.

Actual email needs an explicitly configured service, sender, recipient and disclosure authority. Local queueing or adapter acceptance never means mailbox delivery. No OS daemon or real project schedule is installed or activated by this change. The included owner CLI and periodic tick API provide an explicit configuration path.

Cursor integration, native Windows/Linux enforcement, runtime promotion, merges and releases remain outside this delivery. Windows organization storage without POSIX UID identity is refused; pure contracts and CLI argument checks remain portable, with storage-dependent fixtures explicitly labelled. No Windows ACL certification is asserted.

## Verification and recovery

Use the existing `npm run verify:portable`, reviewed-fixture `npm test`, and macOS `npm run test:host` commands described in [contributing](contributing.md). The portable router automatically discovers the new memory tests; no routing change is needed. Actual check counts, exact source/build inventories, before/after evidence, independent review and CI links belong to the task's final PR handoff.

A separate public-text fixture project exercises supervised execution, automatic history, weekly queue/restart recovery, project memory and local organization controls. Selected large-check-log capture and source-transition verification use actual sandboxed commands and guarded edits. Model answers, mailbox addresses and generated log contents in this scenario are labelled fixtures; they establish no live provider availability or external delivery.

The [failure index](backlog-execution-bugs.md) links the implemented contracts to bounded repairs and parked outcomes. Private owner receipts and per-attempt Markdown preserve exact originals, including operational failures; they are not uploaded as raw transcripts or credentials.
