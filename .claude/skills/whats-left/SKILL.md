---
name: whats-left
description: Give the owner one plain-language status of ForgeMind work - what is running, waiting on review, waiting on the owner, and next - from live repository state. Use when the owner asks what is left, what's next, what is running, or where things stand.
---

# What's left (read-only status)

Build the answer from live state, never from memory alone. Memory and brain notes are context, so verify each one before stating it.

## Gather (read-only, in parallel)
- **Open PRs:**
  `gh pr list --state open --json number,title,headRefName,baseRefName,isDraft,statusCheckRollup`
  Stacked PRs target another PR's branch.
- **Recent merges:** `gh pr list --state merged --limit 6 --json number,title,mergedAt`.
- **Local branches and worktrees:**
  - Branches with commits that aren't on the remote: `git branch -vv`, then for each one `git log --oneline origin/<branch>..<branch>` (or ahead of `origin/main`).
  - `git worktree list | wc -l`.
- **Running here:**
  - Background tasks in this session.
  - `pgrep -fl "run-tests.mjs"` for a running suite.
  - VM work (`ssh forgevm "tasklist /fi \"imagename eq node.exe\""` and any `ForgeMindE2EPR` scheduled task), only if the VM was in use.
- **Plans and decisions:**
  - The "Next" and "Owner questions" sections of the newest ADRs (`ls -t docs/adr | head`).
  - Each ADR's status line. Flag any that are out of date.
- **Brain:** pending lesson proposals (`npm run brain -- list`, read only), and recent `brain_search` results for the area.

## Answer format
Short sections, in this order, each item one line in plain words:
1. **Running now:** what it is and when it should finish.
2. **Waiting on review or checks:** the PR, its verdict so far, and its CI.
3. **Waiting on you:** merges to approve (in order), decisions, sign-ins, cleanup. Say exactly what to click or run.
4. **Next (I can do without you):** in recommended order, with one recommendation.
5. **Later:** the remaining backlog in one line each.

End with one line saying what was not checked, for example that the VM was off or the brain was unavailable.
