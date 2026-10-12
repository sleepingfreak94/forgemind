# Preserved ForgeMind v4 proposal and genuine hot-journal data

The two text files exactly preserve the Native coding invocation from schema3-core-transport-v4; they are untrusted, nonexecuted reference inputs, not accepted implementation. Candidate checks passed 41 of 42 tests. The sole failure was spawnSync node EPERM in the genuine hot-rollback fixture test because the trusted check sandbox denies child processes. No fresh Native review ran. Existing v2 references and all failed private artifacts/worktrees remain preserved.

Worker source: `25b102f47f977590496abc833351cfd934e66639254cdece77c9c84abd2e8872`. Starting source: `43b5f1aed10da5e8579fee4bb9358ab5a6fda72748a1126c400648707ed1d953`. Terminal receipt SHA256: `a586ba0827d25007456d8fc3d15e2f2dd3168b44d011d91e828e174b383e7905`.

- docs/plans/schema3-v4-reference-database.txt: `e6b3b09b209c889e436440ebd5b064bf6c85eb22f28627680bf20bb586ac355c`
- docs/plans/schema3-v4-reference-tests.txt: `85aea7aa53f22e03b7fdc8171f7eca343fca12abb32e51099eb1fea30587baa0`
- docs/plans/schema3-hot-journal-fixtures.json: `1eb1ffe05e7ec2157f2d035a2fa9387115133b76c9814592ab198275528eaae0` (1882 bytes).

Golden data contains genuine SQLite-created synthetic DELETE-mode databases and hot journals at user_version 3 and 4, captured before recovery. It is gzip/base64 transport of original bytes; bounded decompression and raw-byte hashes must be checked. The synthetic sample table is an engine-recovery fixture, not a valid memory schema or project-identity proof. Private owner provenance separately proves read-only SQLITE_READONLY_ROLLBACK and writable rollback to the original synthetic value; it does not authorize Native child execution.

A fresh full ForgeMind task must generate actual database/test source edits, preserve every other reference assertion, replace only the fork-based hot fixture generation with exact golden-byte materialization under temp directories, require the specific supported recovery denial, compare complete directory/database/journal bytes before and after, and pass baseline/candidate checks plus fresh review. Future-version cases must deny before SQLite. No sandbox, request, model, generated-output or execution permission is expanded. Exhaustive real RunHistory revocation proof is a separate mandatory scope before the weekly store.
