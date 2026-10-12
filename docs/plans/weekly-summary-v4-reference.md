# Unaccepted Native reference: weekly-summary-reference-v4

Candidate `521c46e4e4ea412cbf40bcbc442b4fd781e675c4c6a0b1bf9560e65321b773d2` from baseline `18877783ccef4b8370fdf80b0122d090167cb64c8bddda0a2d49410e234ae63c`.

Actual Native full3 requests/378639 input bytes, baseline6→candidate17 PASS and fresh Native candidate review PASS. Independent early review REVISE: unchanged ES2023 strict project baseline compilationPASS/candidateFAIL with16 diagnostics. No integration/acceptance. Preserve all runtime cases and prior four fixes (null, batch partition beyond1MiB, syntax, native roots), fix strict source/test types without altering shared config or assertions. No String.isWellFormed ES2024 API; unknown bounds need flow narrowing; string/array indexed accesses require proven values; exactOptionalPropertyTypes spreads must preserve required fields. Windows evidence remains static/conditional; no claimed Windows execution. Fresh full Native plan/code/configured runtime+strict noEmit checks/review required, then owner broader checks/external exact review.

These exact raw text references are NONEXECUTING evidence, not authorization or accepted feature code; never replay the closed grant.

Raw files: [{"path": "src/memory/weekly-summary.ts", "sha256": "49721ffde951affc8eda37540dce1c7f416c1b6040f34430f1c6c04bd6eb86dd", "bytes": 17421}, {"path": "tests/memory/weekly-summary.test.ts", "sha256": "253c1b97a3943649db94b64c1cf56b1a68eeed58e23e082ecff54c54f2ede949", "bytes": 21131}]
