# Backlog failure and repair index

Archived PR24 record: the later [remaining-work implementation](remaining-work-status.md) adds follow-up fixes and optional delivery destinations. Statements below refer to the original PR24 candidate.

Each original failure, source identity, policy receipt and resume point is retained privately before the next scoped attempt. This sanitized index does not replace those receipts. Two repairs are a maximum per bug, not permission to guess an upstream cause or repeat unknown side effects.

| Finding | Observation and correction | Disposition |
| --- | --- | --- |
| B024 | Fresh qualified read-only canary failed during the request/stream path before tools; typed public diagnostic remained `other`, HTTP null. Twenty-five offline failure/stop checks passed | Parked; no confirmed local source repair and no automatic retry |
| AUTO-F1 | TypeScript did not track a status mutation inside a callback. Update the disposition after the callback returns | Repaired in one attempt |
| AUTO-R1 | History cleanup could mask the original task/preparation error or reject successful execution. Attempt cleanup stages independently and retain separate fixed-stage evidence | Repaired and independently re-reviewed within two attempts; one attempt stopped on a new test annotation error |
| AUTO-R2 | Reopened recovery could substitute recovery time for a missing original execution end time. Missing original timestamp now leaves history incomplete | Repaired and independently re-reviewed within the same two bounded scopes |
| Weekly disable/claim race | Disabling after schedule observation could still permit callback invocation. Compare exact live schedule state before the committed claim | Repaired in one attempt; exact interleaving regression |
| W1 | A valid outbox page above 1 MiB exceeded a whole-array snapshot limit. Return an immutable page of individually validated bounded entries | Repaired in one attempt; actual forty-week API/CLI scenario rechecked |
| Local embedding permission inheritance | Parent Node options could broaden the child. Strip inherited options and check denied child capabilities | Locally repaired in the parked embedding candidate |
| M1 | Valid quote-heavy record text exceeded its serialized transport framing budget | Locally repaired in the parked embedding candidate |
| M2 / M2-R1 | Executable URL paths were repaired, but re-review still found a Windows layout mismatch before the expected pin check | Parked at two attempts; entire new embedding slice excluded |
| Organization stale copy | A stale-source observation did not permanently tombstone the copied record | Repaired in one attempt; restore-after-invalidation regressions |
| ORG-P1 | UID-only storage fixtures were automatically selected on systems without that identity boundary | Tests retain pure portable checks and explicitly guard only unsupported storage cases; production UID validation is unchanged |
| E2 producer evidence | Transition UUID phases alone did not bind the actual policy action; edited historical exports stayed partial | Additive persisted producer envelope/receipt association; legacy missing evidence stays partial |
| E2-NOOP-RESTART | A legitimate resumed write repeated the same content; strict source-change evidence rejected this idempotent application | Verified no-op applications return an unchanged source and null transition ID; no fabricated phase, original file receipt retained |
| E2-CYCLE | Returning to an earlier source matched an already phased transition and incorrectly required reconciliation | Only unphased producer transitions block; real completed source cycles can continue, while a completed-but-unphased producer still denies another transition |
| LOG-A1 | All checks completed, but one retained digest matches 524,288 output bytes rather than 600,000; raw failed-attempt result was not saved | Open pre-existing residual; supervisor flushing is an unproven cause. Two combined fixture repairs exhausted; later success is not a fix. Supplied-input capture losslessness does not certify upstream output completeness |
| E1 aggregate capture | Complete selected evidence above 2 MiB could not fit a single artifact although it fit the bundle | Lossless chunked format and decoder; actual encoded storage overhead still governs admission |

Fixture arithmetic, escaping/type annotations, private launcher errors and the agent concurrency-limit rejection are separately retained in the private execution log. They are not hidden, treated as product successes, or used to expand grants or retry budgets. Independent review findings must be resolved before a slice enters the shared candidate; unresolved slices remain isolated.
