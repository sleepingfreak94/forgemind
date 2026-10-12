# Unaccepted Native weekly summary v3 reference

These non-executable text files preserve the actual failed ForgeMind candidate from weekly-summary-full-v3; they are reference evidence only. No Native independent review ran, and no memory feature was accepted or integrated.

Candidate source: e5d629f486ef1969b7f77c6b2c52fa2627f0888ca92f5f1d40d39e92bae91da1. Starting source:25d4fbb0b2836e5ff3d23af65a7db6c8f2c6e300bff228d534553d72d898178f. Two actual Native requests consumed121359 input bytes. Code generation completed; configured candidate check failed loading test line94 with ERR_INVALID_TYPESCRIPT_SYNTAX. The six existing history tests passed; this is not proof of any summary test passing.

Required correction while retaining the entire original weekly summary contract:
- Correct the actual test syntax; run all new tests and existing history tests.
- Reject supplied null executionSelection/maxBytes instead of silently defaulting them; defaults apply only to absence.
- Preserve identical results across valid page partitions. The failed implementation snapshots the entire batch using the shared1MiB dataSnapshot ceiling:60 individually valid records with100 bounded paths total1496802 bytes, fail as one batch but succeed as60 single-record pages. Validate a bounded dense outer array without getters and each record independently; do not widen shared context validation or weaken the100-record maximum.
- Support platform-native canonical roots accepted by existing RunHistory without filesystem IO. Hardcoded POSIX root validation would reject Windows roots; this is a static compatibility finding, not a tested Windows run.
- Keep strict framing, identities/digests, dependency commitment over all inspected records including excluded fixtures, bounded counters/examples/full-body budget, restart/partition determinism, historical evidence-only trust and no source/runtime IO. Genuine fixtures, integrity/descriptor/getter/overflow/whole UTF8 example omission and revocation rebuild tests remain required. Each source/test file stays below500lines; the existing history contracts and shared validators are unchanged.

Fresh full Native plan/code/candidate checks/independent review are mandatory. The text references are neither implementations nor approvals. Keep the failed worktree and receipts; do not replay its exhausted/closed grant.

Raw source SHA256:e58df6c1f220b1e84d4bc42b9f17ebcb66b6b4f80609ed26493a47e43b554a11; raw test SHA256:27b54eec48a0108aa6ae29d578ecc2edfd857bb790bbc23c8268649daa213d21.
