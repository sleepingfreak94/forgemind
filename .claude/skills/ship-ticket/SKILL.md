---
name: ship-ticket
description: Take a ForgeMind implementation ticket from the current state to a reviewed draft PR, following AGENTS.md, and stop before merge. Use when the owner says "ship it", "ship the ticket", "file the PR", or asks for an implementation ticket to be finished.
---

# Ship a ticket to a draft PR (stops before merge)

Adapted from tstack's `full-stop`. AGENTS.md wins wherever the two disagree.

## Never
- Merge, mark ready for review, enable auto-merge, or enter a merge queue.
- Push to the default branch, force-push (no `--force`, `--force-with-lease`, or `+refspec`), or bypass branch protection.
- Use third-party or paid models, or enable overages, without explicit task-level authorization (docs/model-routing.md).
- Delete branches, worktrees or PRs, or approve brain lessons.
- Present your own review as the independent review.

## Steps
1. **Branch.** Work in an isolated worktree on `task/<slug>` from the right base: `origin/main`, or the open PR branch this work depends on (stack it and say so). One writer per worktree.
2. **Baseline.** Record the baseline commit. Reproduce the starting behavior, or the absence of the feature, with real commands, and keep the output. For Windows behavior, use the `windows-e2e` skill. Never invent a baseline.
3. **Change.** Make the smallest change that fully solves the ticket. Keep files under 500 lines. Add a focused test that fails without the change, and prove that it fails, for example by stashing `src` only, rebuilding and running it.
4. **Focused checks.** Build, then run the touched test files alone.
5. **Candidate evidence.** Repeat the baseline scenario on the exact candidate commit.
   - If the owner asked for before/after videos, they are required deliverables (AGENTS.md):
     - plan the capture before changing anything;
     - record the same scenario for both states, labeled Before and After;
     - inspect the files;
     - save them under `docs/artifacts/<task-id>/`;
     - link them in the PR only through an authorized sharing destination.
   - Record the policy decision receipts that consequential actions produce. A ForgeMind run writes them to its receipt.
6. **Independent review.** Start a reviewer agent that did not implement the change. Give it:
   - the original task and acceptance criteria;
   - the base and candidate commits and the diff command;
   - the evidence, with paths;
   - read-only rules: no edits, no rebuilds, no full suites while one runs.
   
   Ask for findings with severity and `file:line`, a decision per acceptance criterion, and a pass, revise or blocked verdict for the exact commit.
7. **Fix and re-review.** Fix blocking findings and cheap ones. Any change to `src` invalidates earlier runtime evidence, so re-run the affected scenarios on the new commit. Every edit needs a new verdict for that exact commit.
8. **Full suite.** Use the `full-suite` skill on the final commit. Never run it while a VM run or another suite runs on this Mac.
9. **Publish.** Commit with `<type>(<scope>): <description>`. For attribution trailers, follow AGENTS.md. It forbids `Co-Authored-By` unless the repository authorizes it, yet history has carried the trailer since 2026-10-23. Until the owner rules on it, ask them, or follow their latest instruction. Push the task branch, then open a **draft** PR (`gh pr create --draft`, base = default branch or the stacked parent). The body must contain:
   - **Before:** the problem, the reproduction, and the baseline evidence.
   - **After:** the same scenario on the candidate.
   - **Validation:** the checks actually run, with counts and commits. Disclose every failed or retried run.
   - **Review:** each verdict, the commit it covers, findings fixed, and residuals.
   - **Limitations:** what is not verified, with an honest reason.
10. **Gate before the handoff.** Run `gh pr view <n> --json state,isDraft,headRefOid,baseRefName,autoMergeRequest`. It must be open, a draft, at the reviewed head, with auto-merge off. Then run the `babysit-pr` skill until both Portable verification jobs (`Portable / ubuntu-latest` and `Portable / windows-latest`) finish.
11. **Record and report.**
    - Call `brain_record`: title, summary, files, outcome.
    - Report in plain language: the PR link, before and after, the checks with results, the reviewer verdict, and the limitations.
    - Close with: "Nothing merged."

## When blocked
If proof is impossible, auth is missing, a permission prompt is denied, or the scope grows, stop. Prepare the exact PR title and body, then ask for only the missing piece. Never work around a denial.
