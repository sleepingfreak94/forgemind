# Task splitting

A task can ask the planner to split it into ordered subtasks. Each subtask is coded and checked in turn on one worktree. The run ends in one review and one PR. For background, see the [plan](repo-read-and-splitting-plan.md).

## Opt in

Set `"split": true` in the task manifest. Use the Claude (`anthropic`) or the `cursor` provider.

```json
{ "provider": "anthropic", "model": "claude-sonnet-5-5", "split": true, "codingMode": "tools", "maxToolCalls": 16, "maxModelRequests": 4 }
```

On Cursor, use `"provider": "cursor"`. Tools mode works there too.

## The split plan

After planning, the planner returns 1 to 8 ordered subtasks. Each one has:

- a title;
- an objective;
- `writePaths` that are a subset of the task's `writePaths`;
- check ids taken from the task's checks.

The host validates the split. The owner approves the split once. This holds even when the project only shows plans.

## How each subtask runs

Each subtask is one coding pass on the same worktree.

- Claude runs it in tools mode or single-call mode.
- Cursor runs it in tools mode or single-call mode.
- The pass sees the task's `readPaths`, the subtask's `writePaths` and the files changed by its earlier subtasks as sources. It also gets the titles and summaries of earlier subtasks.
- A `subtask` receipt phase is recorded.
- Then the subtask's own checks run. Their results are saved as `subtask-<i>-checks.json`.

The first failing subtask stops the run. Later subtasks do not start. The worktree is kept.

## At the end

1. All task checks run.
2. One fresh review looks at the whole diff.
3. One candidate or draft PR is made.

## Budgets

`maxModelRequests` covers the plan, one request per subtask and the review. So 2 subtasks need 4. A tools session counts as one request. Runtime bounds the whole run.

## Limits

- There is no resume from a failed subtask yet.

## Live evidence (2026-10-23)

Scenario: a throwaway coupon repo. The task asks for `src/discount.js` with `discount(subtotal, code)`, following `docs/COUPONS.md`. `SAVE10` is 10 percent off. `FLAT5` is 5 off, never below 0. Any other code gives no discount. Then `total(subtotal, code)` in `src/pricing.js` applies the discount before 12.5 percent tax. The checks are `discount` and `total`.

| Route | Subtasks (paths, checks) | Subtask checks | Final checks | Review | Outcome | Requests |
|---|---|---|---|---|---|---|
| Claude (tools mode) | "Create discount module" (src/discount.js, discount); "Apply discount in total" (src/pricing.js, discount + total) | passed | passed | pass | completed-local | 4 |
| Cursor (Auto test mode, personal Free plan, test only) | "Add discount module" (src/discount.js, discount); "Wire discount into total" (src/pricing.js, discount + total) | passed | passed | pass | completed-local | 4 |
| Cursor (tools mode, Auto test mode, personal Free plan, test only) | "Implement discount module" (src/discount.js, discount); "Wire discount into total" (src/pricing.js, discount + total) | passed | passed | pass | completed-local | 4 |

Both routes produced the same `discount.js`.

The receipts, plans and patches are kept locally under `docs/artifacts/task-splitting/`. That folder is git-ignored, so they are not in the repository.
