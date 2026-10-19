# Native prevention review failure ledger

Each finding was saved before its repair. Original evidence is immutable in the
private native-prevention run directory; this is the shareable sanitized index.
These are review findings, not failures of the already passing 136-test run.

## E1 — Parent/worker packet handoff

- Found at source `b885af42500dfaff7bafd2c6390db0ff1ceba038b3812b3176037e3734b02423` by independent static review.
- Cause: the fixed worker received a mutable packet path without the parent's expected digest/binding. A valid replacement could broaden permissions.
- Repair: expected file digest and parent binding in fixed child argv; bounded private validation before account access and at execution boundaries.
- Focused evidence: build and 13 tests passed at `0ce89f07c4a20593bcce8339edd88b0e21bd88594c5eeb2f134b5d163db65ab2`, including changed permissions and wrong binding.
- Status: repaired locally; final exact-source independent re-review required.

## E2 — Repeated settlement attempt

- Found at the same reviewed source by static control-flow proof; no duplicate durable terminal was observed.
- Cause: catch could call finish again after a thrown terminal persistence attempt.
- Repair: latch attempt before invoking persistence; ambiguity remains for reconciliation.
- Focused evidence: build and 13 tests passed at `ff53236839f19f915e60b6ad39600143ccf8b0cb5bf6142ff4219dbd78d142bd`, including thrown-before and persisted-then-thrown cases with one underlying invocation.
- Status: repaired locally; final exact-source independent re-review required.

## E3 — Missing Markdown when terminal capture fails

- Found at the same reviewed source by static code-path proof.
- Cause: terminal serialization/publication could fail before writing the separate Markdown resume point.
- Repair: independently attempt one small policy-receipted note with the primary phase/code; never repeat terminal acceptance or overwrite original attempts.
- Focused evidence: build and 8 tests passed at `41318e8663668c13b172630dc9f9aad68b252fec67a74b4f355400f483e7217f`, including oversized/refused envelopes and retained primary phase/code.
- Status: repaired locally; callable write-failure regression and final re-review follow.

## Separate B024 provider failure

B024's original native review stopped with provider kind other, HTTP status null,
six completed reads and zero retries. Its cause remains unknown. The slot was
released after cleanup. Prevention work does not diagnose or close B024, re-run
inference, repair an account or promote the changed runtime.

## E4 — New qualification assertion used whole-report equality

- Actual focused run at d8bc965babcaffebfd244174c01f8e7816a7b0ad936ea80b5ae8adc1b029d633: 64 passed, 1 failed. The original full output is preserved.
- Cause: the new test expected complete report equality after changing private input evidence. Exact input binding and the report digest correctly changed. This was a test expectation error.
- Repair: compare the visible projection while explicitly requiring different input/report digests. No production validation changed.
- Focused recovery: build and all 31 qualification checks passed at bfb7212c4d3165e2616a10edf20834ef21d9e51b20eeeca01a5aca9d2bf25c34.
- The callable capture-write failure check also passed in the original 64/65 run, preserving primary account failure and Markdown. Final integrated checks and independent re-review remain required.

## F1 — Successful producer shape rejected by qualification

- Independent final review REVISE at source `eca14e06002258710fbb524cce69f8bc5f110d6700817ef48499a8fcf280ac37`: native.checkpointUncertain was emitted by the runner but omitted from the importer allowlist. The prior fixture omitted that producer field.
- The in-progress full suite was intentionally stopped before changing source: 1035 tests observed, 1034 pass, 0 fail, 1 cancelled video-repository file. This incomplete attempt is preserved and is not a passing full-suite result.
- Repair: accept and validate the boolean in nested/flat producer envelopes. True makes cleanup unavailable and prevents completed-scoped qualification. Unknown fields and malformed flags remain rejected; legacy omission remains supported.
- Add producer-shaped success fixtures, false/true/omitted/malformed regressions and failure uncertainty checks. Fresh affected/integration checks and exact-source re-review remain required.

## F2 — Functional project fixture deadline under full-suite load

- Full-suite source `82b9b7e75a74f8f3682bbd02dc43ec744153e74b9695121f092890ddd9c50ff0`: 1056 tests, 1055 passed, 1 failed, zero cancellations/skips/todos. The original complete output is preserved.
- Failure: authorized source transition test took 11,585 ms; its test fixture's 10,000 ms owner deadline expired at the final host boundary. This was an actual failed run, separate from the intentionally cancelled earlier suite.
- Repair scope: functional project fixtures receive a bounded 30-second test-only allowance for real Git/SQLite work under parallel load. Production NativeOwner and native task/check limits are unchanged.
- A deterministic real NativeOwner test advances the test clock to one millisecond before and then exactly at its requested deadline, confirming rejection before action admission and no new receipt. This keeps deadline enforcement explicit instead of relying on wall-clock contention.
- Fresh focused, full-suite and independent re-review remain required. No inference or test auto-retry is introduced.

## F4 — Late-frame fixture assumed delivery after RPC closure

- Full-suite source `06ae346feaf23be4cf1304753bc92cb5983a769fa199dd743f7bb3e187c189df`: 1061 tests, 1060 passed, 1 failed, zero cancellations/skips/todos. F2 deadline checks passed.
- Exact failed assertion was lateFrames=0 versus expected1. The earlier one-interrupt and one-stop assertions passed. The complete failed run and the initial counter-reading correction are preserved privately.
- The real child writes interrupt acknowledgement before its late completion. The executor may close RPC after acknowledgement; the contract does not require delivery of future traffic. Static ordering proves the original arrival assertion was unsound; actual acknowledgement timing was not recorded.
- Keep the real-child scenario, permitting zero or one observed late frame. Add a separate deterministic owner-fixture wire injection after fatal stop and before the real interrupt request/acknowledgement; that case requires exactly one observed frame. The injected bytes traverse the actual wire meter, JSONL parser and executor listener.
- Both cases retain all failed-check facts, receipt/source/pending/final-result, one-interrupt, one-stop, actual subprocess reaping and no-continuation assertions. Injection is labelled as fixture injection, not child-emitted evidence. Production code, timers and budgets are unchanged; no sleeps or retries are added.
- Independent scope assessment accepts this coverage split. Fresh focused checks, full integration and final exact-source review remain required.

## CI1 — Portable Windows fixtures crossed a native boundary

- PR23 at Git `d470dd17ae2ee28fcebe4ca2b046547f10064129` passed local macOS checks and independent review, then the Windows portable job failed: 338 tests, 322 passed, 4 failed, 12 skipped. Original job logs and policy receipts were retained before repair.
- Three failures came from a shared test setup invoking POSIX-protected repository source identity on Windows, including two otherwise pure encoder/task validators. A fourth file failed at import because its dynamic ESM specifier was a drive-letter filesystem path instead of a file URL.
- Repair scope is tests only: pure encoder/task validation uses an explicitly synthetic source without Git; repository-source drift coverage keeps its POSIX requirement with a stated Windows skip reason. The runner import uses a file URL, retaining a native filesystem path for subprocess arguments. No production owner checks, suite selectors, native limits or retry policy change.
- Fresh focused/type/portable checks, independent exact-source review and actual Ubuntu/Windows portable CI must validate the repair. Local macOS passing evidence cannot substitute for the Windows result. Native Windows/Linux enforcement remains deferred.
