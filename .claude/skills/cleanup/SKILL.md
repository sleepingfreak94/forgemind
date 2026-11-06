---
name: cleanup
description: List ForgeMind leftovers - merged remote branches, old local worktrees, VM test worktrees, disposable test PRs, stale brain lessons - and delete only what the owner explicitly confirms. Use when the owner asks to clean up, delete merged branches, remove old worktrees, or tidy the repo.
---

# Clean up leftovers (list first, delete only on confirmation)

Deleting is hard to reverse. List everything first, then delete only the exact items the owner confirms in this conversation. Earlier approvals and a standing ticket authorization do not cover deletion (AGENTS.md).

## 1. List (read-only)
- **Merged remote branches:** take `gh pr list --state merged --limit 100 --json headRefName,headRefOid,mergedAt` and keep the branches that still exist (`git ls-remote --heads origin <branch>`). List a branch as deletable **only if its remote commit equals the PR's `headRefOid`**: a branch with commits pushed after the merge would lose them. Never list `main` or a branch with an open PR.
- **Local worktrees:** `git worktree list --porcelain`. For each worktree, report:
  - its branch, and whether that branch is merged (`git branch --merged origin/main`) or has an open PR;
  - whether it is dirty (`git -C <path> status --short`) or has commits on no remote (`git log --oneline @{u}..` or `origin/main..`).

  Group them into: safe to remove (merged, clean, nothing unpushed); has unpushed or uncommitted work (keep, and show what); and in use by a running task (keep).
- **VM test worktrees** in `C:\ForgeMind\worktrees`, with their `task/windows-e2e-*` branches, in the throwaway test project.
- **Disposable test PRs:** `gh pr list -R sleepingfreak94/forgemind-e2e-test --state open`.
- **Brain lesson proposals** from test runs (`npm run brain -- list`). The owner approves or rejects them; this skill only shows them.

Show one table per group, with counts and the exact commands you would run.

## 2. Delete (only what the owner confirmed)
- **Remote branch:** `git push origin --delete <branch>`, one by one. Never use a pattern.
- **Local worktree:** `git worktree remove <path>`, without `--force`. If it refuses (dirty or untracked work), report why and don't force it. It does silently delete *ignored* files in that worktree, such as logs, builds and artifacts, so say so when you list it. Then delete the branch with `git branch -d <branch>` (never `-D`, unless the owner names that branch for force deletion). `-d` may refuse when the local default branch is behind `origin`; that's safe, so report it.
- **Test PR:** `gh pr close <n> -R sleepingfreak94/forgemind-e2e-test --delete-branch`, only in that throwaway repo.
- **VM:** run the matching `C:\Users\forgemind\e2e-*-reset.cmd`, or `git worktree remove` in the test project.

## 3. Report
What was deleted, what was kept and why, and anything that refused to delete.
