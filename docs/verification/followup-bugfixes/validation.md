# Follow-up bugfix validation

This frozen report records component acceptance before integration. Its prepared snapshot leaves combined checks, final review, commit and draft PR pending; those results must be recorded separately against the final integrated source.

## Exact sources and decisions

| Evidence | Source / digest |
|---|---|
| Baseline commit | `cd3d7cbc57f63e17ed4d999042d6e073ca45769e` |
| Baseline source | `c9f439f9571f044c79b0f0e22a1ff3dacb0d66dce6ae1895938f2fe6924b4049` |
| B010 accepted source | `512f1244ac76bc7cf02a3daef1ad8669c1fd62fcab17bb6494c5c304d1c61210` |
| Storage accepted source | `31a27cde15539ed5d833c075dde016d881d277727c6fb0b6bcda75e74d78bc30` |
| B010 review5 PASS SHA-256 | `1fcf1a478ade42922e1cae4750c9b2689fcb38265f4bb2c238b301ff12c57e4d` |
| B010 independent final A/B PASS SHA-256 | `86da6e2e85d64f04bd26240661cd03f0e35b07abd5a614c8206625ff43c8a5e8` |
| Storage independent PASS SHA-256 | `80aac9065bf779819b5081df98a9d71753a16100596283b1eb907446e8f3bdfa` |

The B010 lead acceptance binds seven source files, 209 runtime files and 341 evidence pins. Storage lead acceptance binds six fixes and 648 observed evidence pins. Pin counts are integrity inventory counts, not test counts. [Structured evidence](evidence.json) includes exact file and decision digests.

## Before

B010 was observed during the historical S0a repair attempt at source `0f110ae249ff39e1252cf47a1fca09c29f937029264502e0783ee298eda38e24`, executed by qualified runtime source `7ef75aa5ad2aed7778913555aa5e1cbfa2080dbb606276de591d68051a001b4c`. A failed approved host_check returned passed:false, then the runner executed the same 29-test group again during final verification. Both saved results reported 28 pass/1 fail. Distinct failed terminal receipts match each actual result digest; both original capture hashes match the saved checkpoint. The model retry counter was zero. **This was not a clean cd3d baseline execution.** No historical overall strict PASS is claimed because the old failed-task export omitted that full strict result.

The owner-artifact foundation is absent from cd3d: a read-only git tree query for the three exact foundation files returned no entries. This is an absence baseline for a new foundation, not an executed before/after storage scenario.

A separate diagnostic helper observation at source `5f9aaa49a8448997c99664bbe6eae67bd040e246eae73184e7c6529e77dd59d0` recorded one hostile proxy trap and a throw for a revoked proxy. Its record explicitly excludes a full owner/lease reproduction. At accepted source512f, the full NativeExecutor receipt fixture preserves the original thrown value with zero traps; the constructor-owned diagnostic fixture reads no tampered diagnostic getter. These fixture claims do not imply a live hostile-provider test.

## After

B010 stops an ordered check prefix at the first failure, settles a known failed host_check once, and preserves actual source/receipt-bound callback or final-verification facts. It retains primary errors, uncertainty and byte-budget enforcement. Constructor-owned diagnostic identity lookup avoids mutable caught-error properties and proxy traps.

The storage foundation validates bounded private artifacts and hostile JSON, keeps publication and admission guards until their last fallible operation, retains terminal/progress capacity, and normalizes private error codes without caught-value accessors or coercion. Six findings B005–B009/B011 are independently accepted. The B011 test correction preserves PRIVATE as a legitimate error code.

## Saved checks

| Group | Actual result | Source |
|---|---|---|
| B010 pure + existing final-result tests | 32/32, zero fail/skip; strict no-emit PASS | 512f |
| Focused HOST | 9/9, zero fail/skip | 512f |
| Executor regressions | 38/38, zero fail/skip | 512f |
| Build | exit0 | 512f |
| Storage + existing final-result tests | 29/29, zero fail/skip; strict no-emit PASS | 31a |

These groups overlap; do not sum them or claim a full suite. Saved storage regression results precede its final native review; that actual review ran the final strict check. No tests, builds or inference were run for this report.

Actual Node spec output from the source512f pure group:

```text
✔ [B010] raw fatal proxies never trigger traps when the owner reads the full executor receipt (16.099875ms)
✔ [B010] provider receipts use constructor-owned diagnostic identity without reading mutable properties (0.131208ms)
ℹ tests 32
ℹ pass 32
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## Actual negative qualification

| Probe | Actual observation |
|---|---|
| A | CLI2, native-turn verification-failed; one failed inner check, one outer callback; tools1/turns1/retries0; no final verification or later reservation |
| B | CLI2, verification-failed; zero tools, one turn/retries0; exactly pass-first then fail23; no callback or later sentinel reservation |
| Both | stopped/pending:null/checkpointUncertain:false; failed execution lease with clean completed runtime and correlated executor-terminal evidence |

Both probes are independently PASS-EXPECTED-NEGATIVE. Parent packet and checkpoint binding domains were verified separately. Original stopped controls and control-recovery failures remain preserved; neither probe was replayed. Recovered control assertions retain exact values/array order while comparing plain command objects structurally.

Actual A summary marker output:

```text
stdout: "B010_512f_A_fail23_stdout\n"
stderr: "B010_512f_A_fail23_stderr\n"
```

Actual B ordered marker output:

```text
stdout: "B010_512f_B_pass1_stdout\n"
stderr: "B010_512f_B_pass1_stderr\n"
stdout: "B010_512f_B_fail23_stdout\n"
stderr: "B010_512f_B_fail23_stderr\n"
```

Evidence.json retains actual summary and full-receipt digests. For these direct checks both objects contain the same five fields, so equal summary/receipt digests are expected; no compiler manifest was stripped or replaced with a reconstructed result.

## Review and limitations

B010 code review5 and independent final A/B assessment PASS at exact512f. Storage native review plus independent parent assessment PASS at exact31a; lead accepts all six fixes. The B016 parent control recovery checked the actual read/strict/runtime timeline instead of imposing a false requirement that strict verification follow runtime cleanup. It reran neither inference nor tests. Earlier findings and stopped evidence remain preserved.

All detailed policy databases, raw captures, account/runtime bindings and request/lease identifiers remain private. This report publishes only sanitized source/review hashes, test counts and deliberate marker output. Publishing this summary does not publish those private records or grant authority.

This is local macOS component evidence. It does not establish a global/full suite, other platforms, physical crash/power-loss durability, F_FULLFSYNC, hostile same-UID/openat safety, unsupported filesystems, performance/billing hard caps, deployment or production readiness. Integration must still bind the imported bytes to its exact source, run its required checks, obtain final independent review and create the authorized draft PR.
