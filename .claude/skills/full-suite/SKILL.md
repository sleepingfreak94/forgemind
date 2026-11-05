---
name: full-suite
description: Run ForgeMind's full Mac test suite on an exact commit and triage any failures into regressions or load flakes with evidence. Use before filing or updating a PR, or when the owner asks to run the full tests or test:local.
---

# Full Mac suite with failure triage

## Rules (owner memory: bounded test runs)
- Run **one** full suite at a time on this Mac. Never run it in parallel with another suite or with a Windows VM run: the VM shares this Mac's CPU. On 2026-11-05 a concurrent VM run pushed the suite past its 30-minute limit and wasted the run.
- Run it in the background and wait for the completion notification. Never poll it, never sleep in a loop, never idle-wait.
- Bind the result to the exact commit, and check that the tree is clean first.

## Run
```sh
cd <worktree>
git rev-parse HEAD; git status --short        # must be clean; note the commit
pgrep -fl "run-tests.mjs"                     # must be empty
caffeinate -i npm run test:local > <scratchpad>/test-local-<slug>.log 2>&1; echo EXIT=$?
grep -E "^ℹ (tests|pass|fail|skipped|duration_ms)" <log>; tail -1 <log>
awk '/^✖ failing tests:/{f=1} f' <log> | grep -E "^(✖|  [A-Za-z]*Error)"
```
Before rebuilding the same worktree, stop the suite: the suite runs from `dist`. If no counts were printed, read `tail -15 <log>`. The suite may have hit its 30-minute limit, which means "no result", not a pass.

## Triage every failure
1. Read the error. Look for these load signatures: `Repository deadline exhausted`, `timed out`, `Stale native runtime fence`, or run times near the test's budget.
2. Find the file for each failing test: `grep -rlE "<test name fragment>" tests`.
3. Re-run only those tests **alone**, on the candidate:
   `node --test --test-name-pattern="<a|b>" dist/tests/.../<file>.test.js`
4. Re-run the same tests on the base commit, in a worktree built at the base.
5. Classify each failure:
   - **Regression:** it fails alone on the candidate. Fix it, or report it.
   - **Load flake:** it passes alone on both commits and matches a load signature. Name earlier full runs where the same test flaked.
   - **Caused by the change but only under load:** the change's own new tests time out under the parallel suite. Give them realistic budgets; they are not flakes to ignore.
6. In the PR's Validation section, report the full-suite counts honestly ("2 fail"), each failure, how it was triaged, and whether a clean full re-run was done.

## Known load-sensitive tests (as of 2026-11-05)
- `[B010] compiled checks return only the settled ordered prefix` (native-checks)
- `runtime-only receipt survives … new lifecycle epoch fences previous process` (native-executor-lifecycle)
- `draft publication forwards trusted author and pinned helper without network access` (orchestrator)
- `Native adapter prepares fresh lifetime …` (chatgpt-refresh)
