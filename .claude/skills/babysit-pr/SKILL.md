---
name: babysit-pr
description: Watch a ForgeMind PR, or main after merges, through its GitHub checks; fix real failures and record results; never merge. Use when the owner says babysit, watch the PR, is CI green, or right after a PR is filed or a stack is merged.
---

# Babysit a PR through CI (never merges)

Adapted from tstack's `babysit-pr`. This repo's checks are the "Portable verification" workflow (`.github/workflows/portable.yml`). It runs two jobs, `Portable / ubuntu-latest` and `Portable / windows-latest`. There are no review bots.

## Never
- Merge, mark ready for review, enable auto-merge, or force-push.
- Write your own polling or sleep loop, or run two watchers on one PR.
- Post "still waiting" messages.

## Watch
- **A PR:** run `gh pr checks <n> --watch --interval 60` as a single background command and wait for its notification. Exit 0 means every check passed; non-zero means one failed or was cancelled.
- **The default branch after merges:** run `gh run list --branch main --limit 3 --json name,status,conclusion,headSha`, then `gh run watch <run-id> --exit-status` on the run for the final commit. A run that was **cancelled** because a newer push replaced it is normal: check the newest commit's run.
- If GraphQL is rate-limited (`gh api rate_limit --jq .resources.graphql`), use REST: `gh api repos/<owner>/<repo>/commits/<sha>/check-runs`. Don't retry in a tight loop.

## On failure
1. Read the log: `gh run view <run-id> --log-failed`.
2. Tell a real failure from an infrastructure flake: a runner error, a network outage, or a cancellation. For a flake, re-run it once with `gh run rerun <run-id> --failed` and say so.
3. Reproduce a real failure locally on the PR's head commit, for example with `npm run test:portable`. Then fix it on the PR's task branch with a test, push normally, and watch again.
4. A fix that changes `src` invalidates earlier review and runtime evidence: get a new independent verdict for the new head (see `ship-ticket`).

## Finish
- Check that the PR is still open, a draft, at the reviewed head, and has auto-merge off:
  `gh pr view <n> --json state,isDraft,headRefOid,autoMergeRequest,statusCheckRollup`
- If needed, add the CI result to the PR's Validation section: `gh pr view <n> --json body` → edit → `gh pr edit <n> --body-file`.
- Report: the check names, their result, the commit they ran on, any re-run, and the line "Nothing merged."
