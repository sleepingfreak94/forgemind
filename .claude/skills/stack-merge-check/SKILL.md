---
name: stack-merge-check
description: Check a stack of ForgeMind PRs before or after the owner merges it: merge order, bases, whether main equals the reviewed commit, and CI on the final commit. Use when the owner asks "did I merge it right", "can I merge the stack", or about stacked or merged PRs.
---

# Check a PR stack before or after merging (read-only)

This skill only reads. It never merges, retargets, closes PRs or deletes branches.

## Before merging
1. List each PR with `gh pr view <n> --json number,state,isDraft,baseRefName,headRefName,headRefOid,statusCheckRollup`, and order the stack by base: the first PR targets `main`, and each next PR targets the previous PR's head branch.
2. For each PR, check:
   - its head equals the commit its independent review passed (in the PR body's Review section);
   - its checks are green;
   - it is still a draft (the owner marks it ready).
3. Tell the owner the merge order: merge the bottom PR into `main` first. GitHub then retargets the next PR to `main` by itself; if it doesn't, use **Edit** next to the PR title. Each PR then needs a green `portable` run before it merges. The owner merges; this skill does not.

## After merging
1. Confirm every PR shows `MERGED` with `baseRefName` = `main`, and the merge order: `gh pr view <n> --json state,baseRefName,mergedAt,mergeCommit`.
2. Run `git fetch origin` and compare the tree of `main` with the top PR's reviewed commit:
   `git diff --quiet <reviewed-top-commit> origin/main && echo identical`
   - If they're identical, nothing went missing or slipped in. Changed commit hashes are normal after GitHub retargets.
   - If they differ, show `git diff --stat <reviewed-top-commit> origin/main` and explain where the difference came from.
3. Check CI on `main`'s final commit with the `babysit-pr` skill. An older run cancelled by a newer push is normal.
4. Report:
   - the order, and whether each PR merged correctly;
   - "main equals the reviewed source" or the difference;
   - the CI result;
   - the merged head branches the owner can delete. List them only; deleting needs the owner, through the `cleanup` skill.
