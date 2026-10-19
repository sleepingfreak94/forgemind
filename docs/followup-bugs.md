# Follow-up bug and recovery log

Updated: 2026-10-19. This is the active log for the follow-up after PR #22.
Earlier merged work is indexed in [backlog status](./backlog-status.md), [weekly summaries](./weekly-summary.md), [memory capabilities](./memory-capabilities.md), [continuation](./continuation.md) and [native final results](./native-executor-results.md). This log does not invent a complete historical bug inventory.

Current user workflow: parallel independent bug reviews/preparation are authorized by the later instruction “cant we work with ruflo for all bugs side by side.” Earlier one-active-bug execution history remains preserved below. Every writing worker needs its own worktree; one integration owner controls the shared journal and reconciliation. Native account inference stays sequential. Each bug still requires source-bound checks, independent review and applicable qualification before closure. Previously implemented patches remain preserved.

Every discovered failure gets an ID, source state, cause, attempted fix, verification and resume point. A passing test does not close a blocking review finding. Preserve failed attempts; fixes use fresh scoped harness tasks. Never clear unknown effects or replay inference to repair evidence.

Private evidence paths below are relative to the owner's follow-up run directory. They are local references, not reviewer-accessible uploads. No credentials, account data or raw transcripts belong in this file.

## Current state

- Merged baseline: commit cd3d7cbc57f63e17ed4d999042d6e073ca45769e; source c9f439f9571f044c79b0f0e22a1ff3dacb0d66dce6ae1895938f2fe6924b4049.
- Frozen fixture-corrected source: 31a27cde15539ed5d833c075dde016d881d277727c6fb0b6bcda75e74d78bc30.
- Prior source 90cd165… passed 24/24 tests and strict; repair-2 preserved its 28/29 failure. After the guarded B011 fixture correction, source 31a27cde… passed 29/29 with no skips and strict noemit. Independent final native review and source-bound parent evidence recovery now PASS at 31a27cde…. Full integration checks remain pending.
- The current repair batch is CLOSED in its isolated candidates: storage B005/B006/B007/B008/B009/B011 at 31a27cde…; B010 and related B014/B015/B018/B019 controls at 512f1244…. B016/B017 evidence controls are resolved. B010 passed 32 pure, 9 HOST, 38 executor regressions, strict, build, independent review 5 and both actual negative probes with independent final PASS. Integration, final merged-source review, draft PR and queued features remain unfinished.
- Default branch, releases, sending email and host scheduling have not been activated by this work.

## B001 — Plan acceptance expected the wrong source shape

- Status: resolved in control validation; no new inference.
- Cause: the outer validator expected a source string; the generated plan correctly returned an object containing source.identity.
- Fix: a separate read-only recovery verified the original plan bytes, source identity, 13 pins, completed leases and strict check. The original plan was preserved.
- Evidence: planning/stopped-checkpoint.json; planning/failure-diagnosis.json; planning/acceptance-recovery-1/decision.json.
- Resume: approved staged plan, SHA256 a5f7a351736c081a85d578851e51abc24104f10a56244ae5bef31b903b9233a7.

## B002 — New-file read permission omitted from the worker packet

- Status: scoped permission omission corrected in a fresh task; original attempt preserved.
- Source: c9f439… → 0f24ab2343d62f3b43e68949a0e0565d1d71ff62ed91834a59a407a17f40e6d4.
- Cause: the packet authorized creating three files but did not authorize reading them for follow-up inspection. The harness correctly stopped the read.
- Fix: exact read grants were added to a fresh verification/repair packet. No sandbox rule was weakened.
- Verification: the fresh task reached the new tests, exposing B003. No checks ran in the original failed attempt.
- Evidence: evidence/S0a/checkpoint.json; evidence/S0a/failure-diagnostic.json.

## B003 — Ancestor directory opens exceed the sandbox read grant

- Status: focused repair passed; whole candidate still requires repairs for B005–B009.
- Source: 0f24ab… → 90cd165….
- Cause: canonical path validation opened every ancestor directory. The sandbox allows metadata inspection of /Users, but its read-only directory open returned EPERM.
- Fix: metadata-only ancestor checks plus target-directory descriptor pinning and ancestry identity checks. Existing sandbox permissions and limits stayed unchanged.
- Verification: one read-only syscall probe confirmed the denial; repaired source passed 24/24 tests and strict noemit, including replacement-race coverage.
- Evidence: evidence/S0a/readonly-diagnosis/diagnosis.json; evidence/S0a-repair-1/checkpoint.json; evidence/S0a-repair-1/targeted-repair.diff.
- Limitation: trusted local owner boundary; this is not an atomic descriptor-relative guarantee against malicious code running as the same OS user.

## B004 — External freezing helper used an unsupported Python argument

- Status: original control failure preserved; independent read-only recovery passed.
- Cause: pathlib.Path.open was called with unsupported opener=.
- Effect: the helper failed after the native task passed. Native source, complete result and original logs were preserved; inference and checks were not replayed.
- Verification: the independent reviewer verified the complete result, source/file hashes, checks, settlement and raw capture before reviewing code.
- Evidence: evidence/S0a-repair-1/control-failure-diagnostic.json; evidence/S0a-review-1/evidence-recovery.json.
- Full native result SHA256: 86a8ef7ff4dde57ddf548ec22afff3c2c0132766e39feacb5e59b0d66fda453f.

## B005 — Proxies are not rejected, and a proxy can make JSON validation loop indefinitely.

- Status: CLOSED in isolated candidate 31a27cde…; exact-source checks, independent native/parent PASS and lead acceptance complete. Integration remains pending.
- Source: 90cd1651488363eed29101354da74c4f326f3cae8110d516027270d4943f3d38.
- Location: src/live-workflow/owner-artifact-contracts.ts:146.
- Cause/evidence: Reflection accepts transparent proxies. A proxy can return Object.prototype for the initial getPrototypeOf check, then return itself during the prototype walk at lines 149–151. That loop has no bound and does not advance the node/depth counters. The existing proxy test only covers an ownKeys trap that throws.
- Required fix: Reject proxies before reflection using a trap-free proxy check. Add tests for a transparent proxy and a stateful prototype trap, verifying rejection without invoking traps.
- Repair-2 verification: the ID-labelled regression passed at 0f110ae…; the full group still failed because of B011. This finding remains OPEN pending independent exact-source re-review.
- Evidence: evidence/S0a-review-1/native-review.json; evidence/S0a-review-1/independent-verdict.json.
- Resume: queued behind active B010; assess and close bugs sequentially after its closure. No E1 launch before the storage findings are resolved.

- Preserved repair attempt: evidence/S0a-repair-2/native-receipts.json; actual-check-facts.json; bug-verification-final-handoff.md. No source changes or inference replay followed the failure.

- Latest focused evidence: checks-B011-created-pure/result.json, source 31a27cde…: 29/29 plus strict passed, provider requests zero. Independent re-review remains pending.

## B006 — Publication uncertainty can disappear if both compensating filesystem operations fail.

- Status: CLOSED in isolated candidate 31a27cde…; exact-source checks, independent native/parent PASS and lead acceptance complete. Integration remains pending.
- Source: 90cd1651488363eed29101354da74c4f326f3cae8110d516027270d4943f3d38.
- Location: src/live-workflow/owner-artifact-io.ts:315.
- Cause/evidence: After removing the temporary link, a final directory-sync failure triggers best-effort restoration of that link. Restoration errors are discarded, and failure() also discards errors writing failure.json. If storage errors prevent both operations, accepted.json remains a regular single-link file with no veto marker. Subsequent verify() can report accepted despite the failed publication durability step.
- Required fix: Revise the publication protocol so uncertainty remains recoverably distinguishable without depending on successful writes after the durability failure. Add coverage for final directory-sync failure combined with failed temporary-link restoration and failed failure-marker creation.
- Repair-2 verification: the ID-labelled regression passed at 0f110ae…; the full group still failed because of B011. This finding remains OPEN pending independent exact-source re-review.
- Evidence: evidence/S0a-review-1/native-review.json; evidence/S0a-review-1/independent-verdict.json.
- Resume: queued behind active B010; assess and close bugs sequentially after its closure. No E1 launch before the storage findings are resolved.

- Preserved repair attempt: evidence/S0a-repair-2/native-receipts.json; actual-check-facts.json; bug-verification-final-handoff.md. No source changes or inference replay followed the failure.

- Latest focused evidence: checks-B011-created-pure/result.json, source 31a27cde…: 29/29 plus strict passed, provider requests zero. Independent re-review remains pending.

## B007 — Error normalization can expose mutable, non-fixed caught errors.

- Status: CLOSED in isolated candidate 31a27cde…; exact-source checks, independent native/parent PASS and lead acceptance complete. Integration remains pending.
- Source: 90cd1651488363eed29101354da74c4f326f3cae8110d516027270d4943f3d38.
- Location: src/live-workflow/owner-artifact-contracts.ts:16.
- Cause/evidence: safeArtifactError returns the original object whenever it belongs to safeErrors. Exported OwnerArtifactError instances remain mutable: an instance can have its message changed to private text or replaced with an accessor, then be thrown through a fault hook or proxy trap. WeakSet membership preserves that object rather than ensuring a fixed safe error.
- Required fix: Keep validated error codes in private immutable state and emit a fresh fixed error during normalization, or make recognized errors immutable and validate constructor codes at runtime. Test mutated messages, accessors, and invalid runtime codes without evaluating caught properties.
- Repair-2 verification: mutation/private-code checks passed before the invalid-code fixture assertion failed (B011). Full group failed; this finding remains OPEN.
- Evidence: evidence/S0a-review-1/native-review.json; evidence/S0a-review-1/independent-verdict.json.
- Resume: queued behind active B010; assess and close bugs sequentially after its closure. No E1 launch before the storage findings are resolved.

- Preserved repair attempt: evidence/S0a-repair-2/native-receipts.json; actual-check-facts.json; bug-verification-final-handoff.md. No source changes or inference replay followed the failure.

- Latest focused evidence: checks-B011-created-pure/result.json, source 31a27cde…: 29/29 plus strict passed, provider requests zero. Independent re-review remains pending.

## B008 — Progress writes double-count their incoming bytes against reserved progress capacity.

- Status: CLOSED in isolated candidate 31a27cde…; exact-source checks, independent native/parent PASS and lead acceptance complete. Integration remains pending.
- Source: 90cd1651488363eed29101354da74c4f326f3cae8110d516027270d4943f3d38.
- Location: src/live-workflow/owner-artifact-io.ts:265.
- Cause/evidence: put() adds bytes.length while subtracting only previously written progressBytes from the reservation. progress() increments progressBytes after put() returns. Consequently, an artifact that fills the permitted non-progress budget can make the next progress event fail, including an incomplete event whose capacity was supposedly reserved. Existing terminal tests leave ample bundle space.
- Required fix: Calculate the reservation using progress consumption after the proposed write. Add a test that fills the allowed artifact budget and then successfully writes the reserved running and terminal progress events.
- Repair-2 verification: the ID-labelled regression passed at 0f110ae…; the full group still failed because of B011. This finding remains OPEN pending independent exact-source re-review.
- Evidence: evidence/S0a-review-1/native-review.json; evidence/S0a-review-1/independent-verdict.json.
- Resume: queued behind active B010; assess and close bugs sequentially after its closure. No E1 launch before the storage findings are resolved.

- Preserved repair attempt: evidence/S0a-repair-2/native-receipts.json; actual-check-facts.json; bug-verification-final-handoff.md. No source changes or inference replay followed the failure.

- Latest focused evidence: checks-B011-created-pure/result.json, source 31a27cde…: 29/29 plus strict passed, provider requests zero. Independent re-review remains pending.

## B009 — A failed admission can release its lock despite the documented retention guarantee.

- Status: CLOSED in isolated candidate 31a27cde…; exact-source checks, independent native/parent PASS and lead acceptance complete. Integration remains pending.
- Source: 90cd1651488363eed29101354da74c4f326f3cae8110d516027270d4943f3d38.
- Location: src/live-workflow/owner-artifact-io.ts:353.
- Cause/evidence: createOwnerArtifactAttempt unlinks .admission before calling context.sync(root). If that sync or its boundary checks throw, creation reports failure and the catch only normalizes the error. The lock is absent, allowing another admission. The tests cover an existing lock and capacity failures, but not failure after lock deletion.
- Required fix: Represent unsuccessful unlock durability as admission uncertainty that blocks subsequent automatic admissions until owner reconciliation. Add a fault test at the root sync after unlink and verify that another attempt cannot be admitted.
- Repair-2 verification: the ID-labelled regression passed at 0f110ae…; the full group still failed because of B011. This finding remains OPEN pending independent exact-source re-review.
- Evidence: evidence/S0a-review-1/native-review.json; evidence/S0a-review-1/independent-verdict.json.
- Resume: queued behind active B010; assess and close bugs sequentially after its closure. No E1 launch before the storage findings are resolved.

- Preserved repair attempt: evidence/S0a-repair-2/native-receipts.json; actual-check-facts.json; bug-verification-final-handoff.md. No source changes or inference replay followed the failure.

- Latest focused evidence: checks-B011-created-pure/result.json, source 31a27cde…: 29/29 plus strict passed, provider requests zero. Independent re-review remains pending.

## B010 — Failed host checks do not stop the runner immediately

- Status: CLOSED in isolated candidate 512f1244… after exact-source checks, independent review and actual A/B qualification. Original failed attempts remain preserved; integration is pending.
- Source: observed at repair-2 source 0f110ae… using the previously qualified native runner.
- Cause: host_check returns a failed result to the worker. After the worker stops, runNativeTask still starts its required verification. runNativeChecks also continues to later commands after a failure.
- Observed evidence: host_check call call_wPV6g1qS4enJAyMDsRwXrbZq failed; compiled-check-iCk7Eo and compiled-check-hdjco1 each recorded 29 tests, 28 passing and the same one failing. This is repeated checking, not a claimed inference replay; inference retries remained zero.
- Required fix: end the turn on a known failed check, preserve its actual result/receipt and clear only known completed-check pending state; do not run final verification or remaining sibling checks after failure. Preserve indeterminate semantics for genuinely unknown effects and avoid duplicate receipt settlement.
- Repair attempt recovery-2: source 64898aebbcbf9a4b02132c78ae90a7acf1ab3b18ff94347279798fe42746e46b stopped during native-turn/host_check. The compiled check failed with TS2339 at native-check-stop.test.ts lines 57, 105 and 131: RpcReply.result was accessed without narrowing the error/result union. No test assertions ran.
- Preserved evidence: native-check-stop/recovery-2/native-terminal-v2.log and native-state/checks/compiled-check-RYhH7P/result.json. Saved checkpoint has pending null, 36 tool calls and zero retries. This is a failed repair attempt, not B010 closure.
- Resume: preserve the full attempt and exact source; use a fresh test-only guarded scope to narrow RpcReply properly, retaining assertions. Then run new pure tests plus the existing 13, strict compilation and focused HOST checks. Independent review and actual failure-stop qualification remain required. Other bugs stay queued.
- Evidence: evidence/S0a-repair-2/actual-check-facts.json; native-receipts.json; original per-check result files.
- Test-only correction: after Meitner released writer ownership, a fresh lead NativeOwner/NativeProject edit narrowed all three RpcReply accesses without removing assertions. Source became c05c231f1dfcc471b8fbc37b943f7ae73646aba9c3f70d0d611ae0ae52ef1938; the other five candidate files stayed unchanged.
- Repair-control failure: the first private helper had incorrectly escaped newlines and failed JavaScript parsing before any operation. The original helper is preserved; a separately syntax-checked v2 performed the guarded edit. Evidence: B010-union-control-syntax-stop.json; B010-union-repair-1-v2.mjs; native-check-stop/B010-union-repair-1/result.json. No inference or checkpoint replay occurred.
- Current verification: fresh source-bound native checks passed 29/29 pure tests with zero skips plus strict noemit; owner-wrapped build passed; four focused macOS HOST tests passed with zero skips. Evidence: native-check-stop/recovery-2/deterministic-checks/result.json and candidate-c05/freeze.json, which binds the six-file diff, action evidence and 209 built runtime files.
- Current resume: candidate c05c231f… is frozen and its writer released for independent B010-only native review. Actual negative production qualification has not run; B010 remains OPEN. All other bugs remain queued.
- Additional regression evidence: owner-wrapped existing native-executor-run and native-executor suites passed 38/38, zero skips, at unchanged c05c231f…. Evidence: actions/B010-existing-executor-regressions-*/result.json.
- Review launch control failure: independent-review-1 exited before native startup because /usr/bin/script received socket stdin instead of a PTY (tcgetattr/ioctl: Operation not supported on socket). The native terminal log is empty and native-state does not exist: no inference, checks or source edits occurred. Original launch/checkpoint/captures remain preserved.
- Review recovery: use a fresh attempt with an owner receipt and inherited outer PTY, following the already working recovery-2 owner-pty-launch pattern. Revalidate c05/runtime/evidence pins and precreate fresh full captures; do not replay or overwrite attempt 1. B010 remains the only active bug.
- Independent native review attempt 2 returned REVISE at exact c05c231f…. One HIGH finding: final verification stores only a WeakSet classification marker and then NativeRunError.receipts.checks reads the callback-only facts map, yielding null. The actual executed prefix, including any successful checks before the failure, is lost. Stop behavior, ordered-prefix execution, callback evidence, single settlement, uncertainty handling and hostile-error handling passed review.
- Review evidence: native-check-stop/independent-review-2/native-review.json and native-review-bindings.json; parent adjudication is required before accepting the review as final. No source edits or negative probes occurred.
- Next B010 repair scope: retain the actual final-verification prefix as immutable, source-bound bounded summaries with actual receipt-bound digests; preserve failure classification and applicable accounting; keep full dependency manifests outside summaries. Add a regression covering pass/fail/sentinel and actual failure receipts. Re-run affected checks and obtain exact-source independent re-review before the two unlaunched actual probes.

## B011 — Error-code regression fixture calls a valid code invalid

- Status: CLOSED in isolated candidate 31a27cde…; exact-source checks, independent native/parent PASS and lead acceptance complete. Integration remains pending.
- Source: 0f110ae249ff39e1252cf47a1fca09c29f937029264502e0783ee298eda38e24.
- Location: tests/live-workflow/owner-artifact-io.test.ts, B007 invalid-code loop.
- Cause: PRIVATE is an allowed OwnerArtifactCode. The new test expects normalization to IO for that valid value, so it receives OWNER_ARTIFACT_PRIVATE instead of its expected OWNER_ARTIFACT_IO.
- Required fix: use a truly invalid string and separately assert that legitimate PRIVATE remains preserved. Keep hostile-object and mutated-error/getter checks.
- Correction: a fresh lead-owned NativeOwner/NativeProject transition changed the invalid example to NOT_A_CODE and added explicit assertions preserving valid PRIVATE. Production fixes and hostile-object/getter coverage were unchanged. Original failing attempts remain preserved.
- Verification: source 31a27cde15539ed5d833c075dde016d881d277727c6fb0b6bcda75e74d78bc30 passed 29/29 tests, zero skips, and strict noemit. A deterministic source-bound native-check task executed one check at a time, stopping on failure; no inference or runNativeTask replay occurred.
- Evidence: evidence/B011-guarded-1/decision.json and result.json; checks-B011-created-pure/result.json.
- Resume: queued for independent review after active B010 closes; keep the corrected fixture and all failed attempts preserved.

## B012 — Preparation confused twelve file pairs with total evidence pins

- Status: resolved control-count assumption; original failed preparation preserved. No source edits or inference occurred.
- Baseline: clean harness-stop worktree at commit cd3d7cbc57f63e17ed4d999042d6e073ca45769e, source c9f439…; locked offline install passed.
- Cause: preparation hardcoded pins.length === 12. The R2 evidence manifest actually contains 31 pins: twelve paired source/test components plus supporting artifacts and fixture evidence. Every expected hash matches.
- Fix plan: preserve the failed control; use a fresh read-only recovery to validate every declared pin, identify required source pairs by canonical path and digest, and reuse the existing clean worktree/install. Do not rerun worktree creation or installation.
- Verification: fresh recovery accepted the complete manifest size but stopped correctly at the separately recorded B013 stale historical/current pin. Independent B013 adjudication now validates all 31 historical rows and the explicit current binding; no hardcoded twelve-entry assumption remains required. Original checkout, G preparation and qualified runtime are unchanged.
- Evidence: native-check-stop/FAILURE-TO-LEAD.md; failure-handoff.json; checkpoint.json; original prepare.mjs.
- Resume: separately authorized recovery and source-bound six-path B010 packet; native inference has not started.

## B013 — Recovery used a historical checkout pin after an authorized fixture edit

- Status: resolved evidence binding by independent read-only adjudication, PASS-evidence-only. Original stopped recovery is preserved; no B010 source edits or inference occurred.
- Cause: B010 recovery still expected the live evidence checkout and test pin from stopped source 0f110ae…. A parallel lead-authorized B011 fixture correction advanced that checkout to 31a27cde… and changed exactly the declared test pin. The harness candidate c9f439… and qualified runtime 7ef75a… stayed unchanged.
- Historical test: SHA256 f37f4128351e8a4914a19c6da4c379469bae765317186b86022787a1bdd7a30f, retained as evidence/B011-guarded-1/before.test.ts. Current/after test: SHA256 2a293db8a1c3a12bd7a43199fd2d08205aa645e61190c71c0e451430508e0eaa.
- Required recovery: preserve the original diagnosis and all historical evidence; explicitly bind the historical preimage, authorized one-file transition and current postimage in a new addendum. Validate relevant current core/runtime pins separately. Never relabel the old failed execution as source 31a27cde… or silently overwrite old expected hashes.
- Evidence: native-check-stop/recovery-1/failure-handoff.json and stopped-checkpoint.json; evidence/B011-guarded-1/result.json; original B010 diagnosis SHA256 483f8dc16755b3864b0160baa1e3daa806a1b6d6d993abe2f746532fc19de1ed.
- Verification: independent full-input reconstruction reproduced both historical 0f110ae… and current 31a27cde… with only the authorized test substitution. All 31 original rows remain historical; 30 match original paths and one resolves to the immutable preimage. The exact guarded one-path transition and the later 29/29/strict evidence were verified separately.
- Adjudication: evidence/S0a-review-1/B010-stop-gap/B013-binding-addendum/decision.json. Current-binding manifest SHA256: 7b9a5ab0d3b8ed4596cc73a4240b8fdca7dd170174a35a0348155977bb7926a8. This is evidence validation, not candidate or runtime approval.
- Resume: fresh lead-scoped recovery-2 may reuse the clean c9f439… B010 worktree with the verified addendum. Earlier execution stays labelled 0f110ae…; current evidence stays labelled 31a27cde….

## Remaining implementation and resume order

1. The current seven-bug batch and its evidence-control repairs are verified in isolated candidates. Next combine the ten source/test files with this log, run required integration checks, obtain final exact-source independent review, then commit/push the task branch and create its draft PR. The feature backlog below remains queued.
2. E1: durable full result capture, lossless bounded chunks, safe early failures and separate terminal-delivery outcomes.
3. E2: producer-sealed native transition/receipt binding and qualification.
4. F: automatic run history, weekly scheduling, email adapter/outbox. Actual delivery needs recipient/service configuration.
5. G: pinned local embedding backend and measured retrieval evaluation; cached MiniLM is the tested baseline, not an activated production default.
6. H: owner-managed local membership registry, permissions and governed sharing; local principal IDs are not authenticated people.
7. Integration: source-bound checks, test routing, independent review, task branch and draft PR. No merge or release authorization.

Cursor integration and native Windows/Linux enforcement remain deferred.

## User timebox stop — 2026-10-19

- User required stopping unless B010 could be fixed and verified within five minutes, starting 07:23:06 UTC (deadline 07:28:06 UTC). Lead stopped before the limit because a verified repair requires the remaining code change, independent re-review and actual negative qualification. No further inference, repair or qualification is authorized in this stopped run.
- Current B010 candidate remains frozen at c05c231f1dfcc471b8fbc37b943f7ae73646aba9c3f70d0d611ae0ae52ef1938. It passed 29 pure tests, strict noemit, build, four focused HOST tests and 38 existing executor regressions. These overlapping test groups are not a full-suite or production qualification claim.
- Independent parent adjudication is REVISE, with one HIGH blocking finding B010-R2-1: failed final verification discards actual executed-prefix results. Evidence: native-check-stop/independent-review-2/independent-verdict.json. No post-review production-code correction was made.
- Resume only on a new user instruction: assign one writer to the preserved B010 worktree; make a narrow fix preserving immutable source-bound actual check-prefix summaries and receipt digests; test pass/fail/sentinel preservation; rerun relevant checks; obtain exact-source independent re-review; then separately authorize and run the two actual native negative probes. Do not replay old checkpoints or silently rebind the unlaunched c05 qualification packets.
- Queued findings B005 proxy handling, B006 publication recovery, B007 error privacy, B008 progress capacity and B009 admission locking have patches and 29/29 storage checks, but independent re-review is pending. B011 fixture is corrected and passes those checks, also pending independent re-review. None is promoted to closed here.
- Queued feature work: durable full-result capture and stronger receipt binding; automatic run recording and weekly scheduling/email; pinned embedding backend and retrieval evaluation; local organization registry, permissions and sharing; final integration, independent review, draft PR and CI. Actual email activation still needs the service, recipient and credential reference. Cursor and native Windows/Linux enforcement remain explicitly deferred.
- Agent shutdown evidence: R2 confirms its review process exited and account execution lease/runtime completed, checkpoint stopped and pending null. Meitner confirms no active processes/inference and both qualification probes remain unlaunched. All source, full captures, receipts, failed attempts, prepared packets and resume details remain preserved.

## Ruflo resume — B010 only

- User explicitly resumed implementation with “so do it with rulfo then.” The earlier stopped run and its evidence remain preserved. Ruflo B010 session term-1792395126404-vb67y7 is the execution channel; other sessions remain queued.
- Lead is the sole writer of the existing isolated native-check-stop worktree, starting at c05c231f1dfcc471b8fbc37b943f7ae73646aba9c3f70d0d611ae0ae52ef1938. Scope: src/live-workflow/native-executor-run.ts and tests/live-workflow/native-checks.test.ts only. All other candidate paths remain pinned.
- Repair B010-R2-1 by sharing the actual final-verification execution path with a focused HOST regression. Preserve frozen owner-side source-bound summaries and both summary/full-receipt digests for the executed prefix. Final verification evidence is owner-side, like existing successful verification results; do not reclassify it as model tool output or change callback result-byte accounting. Keep full manifests outside summaries. Preserve primary boundary failures, cancellation/uncertainty precedence and no later check execution.
- Acceptance: actual pass/fail/sentinel regression for direct and compiled checks, frozen facts and digest correlation; existing pure/strict/build/HOST and executor regressions; independent exact-source native re-review; then separately scoped actual negative probes. No runtime promotion, next bug, merge or release before the relevant gates.

- Ruflo repair candidate: lead guarded two-file transition c05c231f… → 933a09fe… plus a pre-test error-type narrowing → c73d2ddfe2dac9f02d7122c52c750ed2795c1a96f881384d936fdda8bb174096. Other four B010 files stayed pinned. Actual shared final-verification runner now retains immutable source-bound owner evidence with summary and full-receipt digests in additive NativeRunError.receipts.verificationChecks; callback receipts remain unchanged.
- Actual candidate checks: 29/29 pure tests plus strict noemit, build, 7/7 focused HOST tests and 38/38 existing executor regressions passed, all zero skips. The groups overlap and are not a full-suite claim. The new HOST coverage checks direct/compiled pass-fail-sentinel prefix preservation, actual terminal digests, immutable facts, primary boundary-error preservation and successful verification.
- Evidence: native-check-stop/prefix-repair-1/result.json; prefix-test-narrowing-1/result.json; prefix-repair-1/deterministic-checks/result.json; candidate-c73/freeze.json binds six files, full diff, action evidence and 209 built files. Candidate writer is released; independent native re-review 3 is authorized at exact c73. Actual qualification remains unlaunched. B010 is OPEN; other bugs remain queued.

## Parallel Ruflo review work

- Latest user instruction authorizes side-by-side bug work. B010 stays frozen at c73d2dd… for native independent review; shared storage candidate remains read-only at 31a27cde… for parallel preliminary reviews. No storage writer was started.
- Independent workers: Anscombe B005, Schrodinger B006, Hooke B007/B011, Singer B008/B009. Tasks are recorded in Ruflo and use their assigned managed sessions. B008/B009 and B007/B011 share read-only review context; they require separate acceptance decisions.
- Coordination limit: a fifth review-worker spawn reached the agent thread limit before creating B009. No source or native-execution effects occurred. B009 was assigned to the existing B008 read-only worker. An idle historical-agent lookup returned not found; no process or source was changed by that lookup.
- Workers report preliminary PASS for B005, B006, B008 and B009, reusing existing exact-source 29/29 plus strict evidence. Parent artifact checks and final native review remain required. Artifacts are under parallel-bug-reviews/B005, B006, B008 and B009. B007/B011 review is still running. No passing preliminary review alone closes a bug.

## B014 — Prepared negative-probe validator conflated task failure with runtime cleanup outcome

- Status: CLOSED in isolated candidate 512f1244… after exact-source checks, independent review and actual A/B qualification. Original failed attempts remain preserved; integration is pending.
- Location: native-check-stop/qualification-c73/validate.mjs, runtime lifecycle assertion.
- Cause: the prepared validator required a failed runtime row/terminal for both expected logical check failures. NativeProcess.stop sets stopped before closing RPC and settles completed when cleanup and authority/pin checks succeed. A logically failed task/lease can therefore have a correctly completed runtime. The older repair failure had an expired-grant terminal and is not evidence for the clean-negative runtime outcome.
- Required control correction: preserve original qualification-c73 and prepare a fresh qualification-c73-v2 with clean completed runtime plus executor-terminal joins, failed task/lease, exact binding and no expiration or uncertainty. Do not weaken outcome validation into accepting either arbitrary terminal. Retain actual stdout/stderr and prefix result receipt joins.
- Source evidence: src/live-workflow/native-executor-process.ts stop/finish and nativeRpc.close; native-executor.ts stop; original expired-grant evidence native-check-stop/recovery-2/native-result.json. Meitner owns private v2 controls only. No source edits, inference replay or account changes are authorized for this correction.
- Acceptance: static causal review of the fresh control diff followed by independently reviewed c73 actual negative A/B probes. B014 remains open until the corrected validator accepts truthful, source-bound actual results.

## B010 native re-review 3 — additional failure-path findings

- Exact c73d2dd… native review returned REVISE with two findings. Source and full review evidence remain preserved under native-check-stop/independent-review-3. No actual qualification probe has run.
- HIGH: final-verification facts remain attached only to errors thrown inside its post-check helper. Successful verification followed by cleanup, cancellation, return-boundary or execution-settlement failure loses the known results. A later check throwing also loses the earlier settled prefix because runNativeChecks rejects before returning the array.
- MEDIUM: result accounting sets accountAttempted before NativeState.charge returns and sets known facts only after success. A within-cap counter increment followed by checkpoint persistence failure leaves the in-memory charge advanced but drops the actual failed-check facts. Genuine byte-cap rejection must continue to expose no uncharged facts.
- Fresh repair scope: src/live-workflow/native-checks.ts, native-executor-run.ts, native-executor-tools.ts; tests/live-workflow/native-checks.test.ts and native-check-stop.test.ts. Lead is the sole writer. Add an incremental observer after actual settled check results; retain a private per-owner-run frozen capture across helper success and later failures; preserve primary errors and uncertainty precedence. Record accounting uncertainty only when a within-cap charge actually advanced before persistence failed.
- Required regressions: actual settled prefix followed by later check exception; successful verification then late cleanup/cancellation/return-boundary error retains known facts; real SQLite CAS failure during result accounting retains bounded actual facts and pending uncertainty; existing true-cap test still exposes no facts. Re-run affected checks and independent exact-source review before preparing fresh actual probes.
- Parallel preliminary reviews now report PASS for B005, B006, B007, B008, B009 and B011 at unchanged 31a27cde…. Their artifacts and final native review remain to be reconciled; no bug closure is claimed yet.

- Prefix repair 2 applied through guarded Ruflo execution at source afca8916ffbf7597edd4e4d2a2b67b7ec4a547dba5a9eeee7c6a9ab115b27982. Actual deterministic checks passed 30/30 plus strict, including a real SQLite CAS fault during result accounting; no native qualification has run.
- Full-executor fault preflight: NativeExecutor.stop previously updated checkpoint before rejecting the turn promise. If persistence throws, shutdown can replace the primary error or leave that promise unsettled. The within-cap callback facts would then fail to reach the outer runner reliably. Extend the fresh B010 scope to src/live-workflow/native-executor.ts plus run.ts and native-check-stop.test.ts: always settle the turn with the original error after best-effort uncertain checkpoint marking; expose checkpoint uncertainty and carry it through successful cleanup into the owner catch. Never clear pending effects or replay tools. Upgrade the SQLite regression from direct tool invocation to the full fixture executor path. This is part of B010-R2-3 acceptance, not a new unrelated feature.

## B010 checkpoint repair 2 — frozen for review 4

- Lead guarded source afca8916… → 5f9aaa49a8448997c99664bbe6eae67bd040e246eae73184e7c6529e77dd59d0 includes the explicitly scoped NativeExecutor checkpoint-stop repair. Full-executor SQLite CAS regression now settles with the original error, retains bounded actual facts, leaves pending effects, and marks uncertainty; genuine cap rejection still exposes no uncharged facts.
- Exact-source checks passed: 30/30 pure tests and strict noemit, build, 9/9 HOST tests, 38/38 existing executor regressions; zero skips. Overlapping groups are not a full-suite claim. Freeze binds all seven candidate files and 209 built files: native-check-stop/candidate-5f9/freeze.json.
- Writer released; R2 independent native review 4 has exclusive account inference permission. Review must cover original B010 acceptance and both review-3 findings. c73 and its unlaunched qualification packets remain historical; new 5f9 packets may be prepared but probes require exact-source review PASS and separate lead GO.

## Storage final-review preparation stop 1

- Status: stopped before native launch; unchanged storage source 31a27cde15539ed5d833c075dde016d881d277727c6fb0b6bcda75e74d78bc30. All six preliminary reviews report PASS; final native review remains incomplete.
- Cause observed: seal-controls.mjs was absent after a save call. A subsequent source-bound owner command exited 1, MODULE_NOT_FOUND. The agent discarded the raw save envelope by printing only parsed output (undefined), so its underlying error or approval status cannot be established. Do not infer an approval rejection.
- Evidence preserved: parallel-bug-reviews/native-storage-review-1/{stopped-checkpoint.json,handoff.md,launch-review.mjs,owner-pty-launch.mjs}; actions/storage-review-prepare-controls-03fa25ed-ab50-405e-a6a6-75fed8e2bad8/result.json (launch controls created); actions/storage-review-seal-5197485c-9ce1-4ae4-8549-6d7fd8623631/result.json (exit 1). No source edit, strict check, execution lease or inference occurred.
- Resume in fresh native-storage-review-2 only. Prepare private controls through an owner-bound helper, inspect every raw tool response, verify file existence and syntax before sealing. Preserve original partial controls. Preparation can run alongside B010 review; native launch waits for exclusive account assignment and lead GO.

## B010 native review 4 stop and fresh receipt-diagnostic repair

- Exact source 5f9aaa49… review stopped during native-turn: native-provider-error, diagnostic kind other, HTTP status null, willRetry false. No native verdict or final strict result exists. Captures and typed failure are preserved under native-check-stop/independent-review-4; parent independent-verdict.json SHA256 1088c7e9c9dfd42ad110f271a03cf92ae2478a6eae40fbcb7dca10dddd8c686b. No auth, quota, network or harness cause is inferred from the limited provider diagnostic.
- Account execution lease failed; runtime cleanly completed; checkpoint stopped, pending null, retries zero. R2 confirms process exited and account slot released. Do not retry or replay this attempt; 5f9 qualification controls remain preserved and unlaunched.
- Independent parent finding B010-R2-4 HIGH: new unconditional checkpointUncertain reads evaluate the full executor receipt. Its nativeProviderDiagnostic helper uses instanceof and reads diagnostic on a raw fatal error. A hostile/revoked Proxy can trap and replace the primary error before owner cleanup/lease settlement. Source-confirmed finding; a new reproduction was not run by the reviewer.
- Fresh narrow repair: lead sole writer of src/live-workflow/native-executor.ts and tests/live-workflow/native-check-stop.test.ts. Capture the current helper's proxy-trap behavior before editing. Store validated immutable provider diagnostics in a private constructor-owned identity map; receipt lookup must not inspect caught objects or prototype chains. Cover hostile/revoked proxy and proxy in an Error prototype through the full fixture executor, primary identity, zero traps, receipt/checkpoint/pending state and cleanup. Preserve existing typed provider diagnostics.
- Re-run focused pure/strict and affected executor regressions, plus required HOST/build checks after the patch; freeze and obtain exact-source independent re-review before fresh negative probes. No source is promoted or bug closed.
- Parallel storage review 2 may now receive the exclusive native slot under a separate source-bound lead GO. It is an independent task, not a retry of failed B010 review 4.

## B015 — Hostile-error regression observer inspected the caught Proxy

- Status: CLOSED in isolated candidate 512f1244… after exact-source checks, independent review and actual A/B qualification. Original failed attempts remain preserved; integration is pending.
- Cause: the new hostile raw-error case reused rejected(), which delegates to Node assert.rejects. Node waitForActual inspected the rejected object and triggered the test Proxy get trap before the intended receipt assertions. Stack evidence points to node:assert:617 and the fixture helper, not the repaired diagnostic identity lookup. An async helper returning a raw Proxy can also assimilate then; avoid returning the caught value from an async observer.
- Evidence: native-check-stop/receipt-proxy-repair-1/deterministic-checks/result.json preserves full actual TAP and source-bound failed terminal. Production identity-map patch remains unchanged and unaccepted.
- Fresh one-file scope: tests/live-workflow/native-check-stop.test.ts only. Catch the original rejection inline in the test, compare identity without diagnostic inspection, then assert zero traps and full receipt/cleanup/pending facts. Re-run a fresh deterministic check, stop before strict if it fails. Preserve the 31/32 attempt.

- B015 correction: guarded inline observer source 512f1244ac76bc7cf02a3daef1ad8669c1fd62fcab17bb6494c5c304d1c61210 passed 32/32 pure tests plus strict, build and 38/38 executor regressions. Full hostile/revoked/inherited proxy fixture cases observe the original rejection and zero traps; checkpoint/pending and cleanup are asserted. Actual provider account-lease injection was not reproduced by those offline fixtures. HOST and independent re-review remain pending. Evidence: native-check-stop/receipt-proxy-observer-1/deterministic-checks/result.json and source-bound B010-receipt-proxy action results.

## B016 — Storage parent adjudicator reversed strict-verification/cleanup ordering

- Status: resolved by fresh evidence-only recovery; original failed control and all inputs preserved. No source/test/model replay.
- Parent adjudication stopped before creating a verdict: parent-adjudicator.mjs line 149 required strict decision timestamp at or after runtime terminal. The qualified runner executes final verification before cleanup and runtime settlement. Actual strict completed at 1792398792699, then runtime terminal at 1792398793595, matching that control flow.
- Evidence preserved: parallel-bug-reviews/native-storage-review-2/execution-stop-handoff.json, adjudication-stopped-checkpoint.json and original adjudicator SHA256 d4007e97508bab92ba35883efa486a77c4c48ad60427648034840c30d4136478; full capture hashes and all actual policy joins remain in the handoff. Do not relabel this as a native/source failure or erase the blocked adjudication.
- Fresh recovery scope: private read-only evidence validation only, separate sibling output directory. Verify qualified source control flow, then require runtime decision before strict reservation, all native reads settled before strict, strict completed before runtime terminal, and every exact source/request/digest/lease join. Preserve the original inputs and failed script. Obtain a postexecution independent semantic assessment of the real native verdict. No inference, tests, source edits, account changes, promotion or bug closure in this recovery.

- B010 current candidate frozen at 512f1244ac76bc7cf02a3daef1ad8669c1fd62fcab17bb6494c5c304d1c61210: 32/32 pure plus strict, build, 9/9 HOST and 38/38 executor regressions all passed. Freeze binds seven files and 209 built files at native-check-stop/candidate-512f/freeze.json. R2 independent review 5 has fresh exact-source GO and exclusive native slot after storage review 2 settled. B015 fixture correction is verified locally; independent acceptance remains pending. Old qualification packets remain unlaunched historical evidence.

## B017 — Lead acceptance assumed a newer test-evidence JSON field

- Status: resolved by fresh evidence-only recovery; original failed control and all inputs preserved. No source/test/model replay.
- Cause: TypeError in lead-storage-acceptance-1.mjs line 8; not a storage/source/native failure. Owner action result and script are preserved. All source/hash/receipt checks before that schema access passed; no test/model was replayed.
- Fresh scope: private lead-storage-acceptance-2 reads the exact saved B011-created-pure-compiled stdout and parses actual spec/TAP counters, requiring tests29/pass29/fail0/cancelled0/skipped0 plus the separately passed strict result. Preserve the old helper; no source edits or check reruns in this evidence-only recovery.
- Supplemental B016 export: an output-only Python helper passed a TextIOWrapper to os.chmod and left an empty verified-receipt-joins.json. Its note and failed receipt remain preserved; a separately named complete supplemental export succeeded. The main recovery verdict and verified-execution.json predate that export and remain unchanged. The failed partial export is excluded from acceptance evidence; no inference/check replay occurred.

## Storage candidate closure — independent from B010

- Accepted B005/B006/B007/B008/B009/B011 at exact 31a27cde15539ed5d833c075dde016d881d277727c6fb0b6bcda75e74d78bc30. Actual 29/29 tests, zero skips and strict passed; the fresh native review also completed one final strict check and returned PASS for all nine decisions with no findings. Independent parent semantic review and the corrected immutable-evidence adjudication passed.
- Lead acceptance: lead-storage-acceptance-2/decision.json, independent verdict SHA256 80aac9065bf779819b5081df98a9d71753a16100596283b1eb907446e8f3bdfa. It rechecked 648 observed input pins, actual complete source reads, captures, source/request/result digests and timestamp/lease/runtime joins. B016's corrected ordering and B017's actual TAP-count parser are accepted; no inference, test or source replay occurred during evidence recovery.
- Evidence: parallel-bug-reviews/native-storage-review-2-adjudication-recovery-1/{independent-verdict.json,verified-execution.json,actual-timeline.json,adjudicator-recovery.diff}; original native-storage-review-2 captures and failed adjudication remain preserved. The empty failed supplemental export is excluded.
- Limits: trusted local owner model; no physical power-loss or durable unlink guarantee, no authenticated organization identity and no execution authority from evidence files. These fixes are verified only in the isolated candidate; integration, final merged-source review, draft PR and CI are pending. No merge, release or runtime promotion is granted.

## B018 — Negative-probe validator conflated parent and checkpoint binding domains

- Status: CLOSED in isolated candidate 512f1244… after exact-source checks, independent review and actual A/B qualification. Original failed attempts remain preserved; integration is pending.
- Actual probe A ran once and exited 2 with expected stopped/native-turn/verification-failed. Saved and durable checkpoint agree: stopped, pending null, turns1/toolCalls1/retries0, counters identical. Account execution lease failed as expected; runtime cleanup completed. No B launch or inference retry occurred.
- Validator stopped at its joined binding assertion. startup.parentBinding and nativePacketBinding(packet) both equal c5402bd8cb0c2bc5ded52777ff07f5a0409e839ecf8edc40e67371a6d0b2e667. Captured and durable checkpoint binding both equal 4fce2cfe18b38a88515d22d5173e51d05e0836cefa39e0280449b3369a66080a. NativeState.bindingFor hashes the task with source omitted plus authorityBinding=parent binding; it is a separate domain and must not equal the parent hash.
- Evidence: native-check-stop/qualification-512f/A/{validation.json,native-result.json,startup-boundary.json,launcher-exit.json,native-terminal.log,terminal-output.log}; owner B010-512f-probe-A-validate action; src/live-workflow/native-executor-state.ts bindingFor and constructor. Original validator and failed validation remain preserved; no source failure is inferred.
- Fresh scope: private sibling qualification-512f-control-recovery-1, evidence-only A validation. Correct domain recomputation from exact packet inputs, retain captured/durable/source/budget/request/result/lease joins, write outputs to fresh A recovery directory. No original file overwrite, no native-state construction, no test/model replay. After A recovery PASS, prepare a fresh B-only launch wrapper explicitly bound to the unchanged original fresh B packet/captures and recovered A validation; preserve the old unlaunched B wrapper. B still needs separate lead GO and exclusive slot.

## B019 — Callback-command equality incorrectly depended on JSON key order

- Status: CLOSED in isolated candidate 512f1244… after exact-source checks, independent review and actual A/B qualification. Original failed attempts remain preserved; integration is pending.
- Cause observed: authority envelope serialization sorts command object keys to args/executable/id/timeoutMs; the exact input packet has id/executable/args/timeoutMs. JSON.stringify comparison rejected the ordering difference. Node isDeepStrictEqual independently confirms the actual command and packet command have identical values, including exact ordered argv, executable, ID and timeout. No broadened command is accepted.
- Evidence: native-check-stop/qualification-512f-control-recovery-1/A/{validation.json,owner-policy-evidence.json,native-result.json}, original producer qualification-512f/A/packet.json, and the source-bound first recovery result. Preserve recovery 1 and original failed validation; no source failure is inferred.
- Fresh scope: private sibling qualification-512f-control-recovery-2. Retain the verified checkpoint-domain correction and compare command dictionaries by deep structural equality, with ordered arrays and exact key/value sets. Inspect all remaining assertions against qualified source and immutable actual output before running once. Preserve every receipt/source/digest/lease/counter check; all outputs fresh. R2 independent read-only assessment is required. No native/test replay or account/source change; B-only wrapper preparation may begin after full A recovery PASS, but actual B still needs separate lead GO.

## B010 closure — actual fail-stop qualification complete

- Accepted exact source 512f1244ac76bc7cf02a3daef1ad8669c1fd62fcab17bb6494c5c304d1c61210. Actual 32/32 pure, strict noemit, build, 9/9 HOST and 38/38 executor regressions passed; groups overlap. Independent native review 5 and parent source assessment PASS resolve all four review findings, with no new findings.
- Actual A ran once: failed callback check only, no later command/final verification, actual full stdout/stderr and receipt digest retained, one tool/turn, retries0. Actual B ran once: pass-first/fail-second prefix retained with source-bound actual summaries/full receipt digests, no later sentinel reservation, zero tools, one turn/retries0. Both expected CLI2 failures had stopped/pending-null checkpoints, failed task leases and completed clean runtimes. No producer failure was relabelled successful.
- A's original failed binding validator and recovery 1's key-order failure remain preserved. Fresh recovery 2 corrected only the checkpoint hash domain, structural command equality and fresh output routing. Original A was not rerun; B used a separately assessed B-only wrapper with the original explicitly unchanged packet/captures. B014/B015/B018/B019 applicable gates are complete.
- Independent final A/B verdict: native-check-stop/qualification-512f-independent-final-1/independent-verdict.json, SHA256 86da6e2e85d64f04bd26240661cd03f0e35b07abd5a614c8206625ff43c8a5e8. Lead acceptance: lead-B010-acceptance-1/decision.json, rechecked 341 final pins and the seven-file/209-build freeze. Account slot released for both probes. No active native inference remains.
- Scope: verified isolated repair candidate; no default-runtime promotion, merge or release. Required integration and final merged-source review remain. Earlier stopped model/control attempts are immutable evidence, not erased history.

## B020 — Public source report destination was Git-ignored

- Status: resolved by fresh tracked report import; all verified component source bytes remain unchanged. The ten-file guarded integration import succeeded at source 23610d3fd69ed235959c0a7802a503d3b7e07cbb4de5009fc4830836f83e7eb9.
- Source-bound public-report import 1 wrote the two sanitized docs/artifacts/followup-bugfixes files, then NativeProject correctly refused the source transition with Unrelated source drift during native edit. The repository's existing .gitignore excludes docs/artifacts/. The predicted edited tree included those files while sourceIdentity intentionally omitted ignored untracked files. Source remained 23610d3… before and after; no source-transition receipt or owner phase was completed.
- Evidence: integration-public-evidence-import-1/{inputs.json,result.json} and owner action result preserve exact intended bytes, completed file-operation evidence and failed source advance. Both partial report files remain ignored and preserved; no cleanup, retry or source-ledger rebinding occurred. Current Git status has only the ten imported source/test files and bug journal; no unrelated tracked change was found.
- Fresh scope: publish the same sanitized component evidence under tracked docs/verification/followup-bugfixes/ using a new guarded two-path task after explicit check-ignore preflight. Do not change global ignore rules, force-add the failed path or delete its evidence. Correct report wording already reviewed by lead stays in the new content. Update eventual PR links and final review scope to the tracked destination. No code/source fix to the guard is needed; it rejected an unsupported source-inventory transition as designed.

- B020 recovery: integration-public-evidence-import-2/result.json records the separately scoped two-path import under docs/verification/followup-bugfixes/. Explicit check-ignore preflight confirmed both targets participate in source inventory. NativeProject accepted the exact source transition to 68d91f29b7ad2c7c90008ab9ebfcf6a8384228d0f8f8a5619e0ed0f79e8252fa. Original ignored partial outputs and failed source-advance evidence remain preserved; global ignore rules were not changed.
- Integration candidate now combines the ten independently accepted source/test files, this recovery log and the two tracked sanitized component reports. Every component file matches its reviewed source hash. Combined-source checks and final review are the next gates; their exact source/evidence will be recorded in the PR handoff, separately from the frozen component reports.

## B021 — Full-suite prerequisites were omitted and the long tool result was not safely handled

- Status: setup/control recovery verified in fresh focused runs; combined all-suite acceptance remains pending; component source files remain exact and unchanged. At source 5ada0e861b235e1b51d6aa262f8bde3d97ab658b96fc5aeab92fefade777308c, doctor/typecheck passed, then standard npm test built and entered the all suite. The command was not retried.
- The managed tool returned non-JSON text beginning tool call e…; the lead parser threw before preserving the raw envelope. Its full error text and isError status cannot be established; no approval or transport cause is inferred. While that control failed, the owned test command still had native-executor-process and video-repository workers alive. Lead sent SIGTERM only to those exact current-user descendants, leaving the owner wrapper to settle and retain all output. Separate terminal monitoring completed after the command ended. No claim of a global process cleanup follows from PID observations.
- Actual owner result: actions/integration-all-tests-fb7a3810-8ad7-4a4d-8f2a-87d8c526fe76/result.json, status1, unchanged source, 97,653 stdout bytes. Reported 982 tests: 974 pass/8 fail/zero skips. Seven failures explicitly require FORGEMIND_TEST_CODEX_0161 or FORGEMIND_TEST_CODEX_0162. The eighth is the interrupted video-repository file and is incomplete evidence, not an observed assertion defect in that file. Stop evidence: integration-all-tests-stop-1/{before-signal.json,signals.json}; the complete command capture is preserved.
- Cause confirmed: docs/contributing.md documents both reviewed fixture selectors before npm test. The lead omitted them. Both installed versioned binaries independently return exact codex-cli 0.161.0 and codex-cli 0.162.1. No installation, account, model, source assertion or skip change is required. The missing prerequisites can leave test setup resources open; the interrupted long run cannot establish complete integration success.
- Fresh scope: bind the exact reviewed executable paths only in each new command environment; run focused native fixture checks and a bounded video-file diagnosis first. Preserve the failed all run. Long checks use the existing source-bound owner wrapper via the yielding executor, with Ruflo recording coordination; this avoids blocking the managed terminal service. Preserve raw tool responses before parsing future structured results. If focused checks pass, create a separately labelled full all-suite run with these documented prerequisites and exact source evidence. No test weakening, provider fallback or automatic replay.

- B021 focused recovery: source 2fd9bfb855b0ca3f83161d784551b04be5e4ee0e5a5de464fef4caca64f7829b passed 17/17 native/orchestrator fixtures, the first video scenario 1/1 and the complete video file 21/21; zero failures, cancellations, skips or todos. Exact installed 0.161.0/0.162.1 selectors were explicit in all three command environments. B021-focused-acceptance-1/decision.json binds full owner results, command environments, executable hashes and counts. The original failed all-suite capture is unchanged. These are synthetic/offline fixtures, not provider calls or a new user video recording.
- Video read-only diagnosis confirms 384 seconds was the interrupted whole-file lifetime, not an observed single-command hang. Fixture preparation and test assertions have separate lifetimes from the 120-second delivery budget. The first isolated scenario passed in 21.1 seconds; the complete bounded file also passed. No video assertion, runtime timeout policy or production source was changed. Private diagnosis: parallel-bug-reviews/B021/readonly-in8lob_e/diagnosis.md.
- Resume: separately labelled standard npm test with both documented fixture selectors, plus doctor/typecheck on the new journal-inclusive source, then fresh exact-source freeze and independent integration review. Final combined outcomes belong in the PR handoff; the tracked component reports remain frozen historical evidence.
