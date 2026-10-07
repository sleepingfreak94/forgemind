# Agent Model Routing

Last updated: 2026-10-07

## Account profiles

When office Cursor and separate Codex profiles are configured, keep the profiles distinct. Office task data follows office-approved accounts/providers; personal Codex access is not an automatic office fallback.

Other Models budgets are owner-configured. A reported budget is not a verified account balance or entitlement. Selecting that pool or enabling paid overages requires explicit task-level authorization.

## Office Cursor configuration

| Role | Target model | Effort | Speed | Configuration |
| --- | --- | --- | --- | --- |
| Parent / lead | Grok 4.7 | High | Standard | Select in parent session |
| Researcher | Grok 4.6 | High | Standard | [office-researcher](../.cursor/agents/office-researcher.md) |
| Architect | Grok 4.7 | High | Standard | [office-architect](../.cursor/agents/office-architect.md) |
| Coder | Grok 4.6 | High | Standard | [office-coder](../.cursor/agents/office-coder.md) |
| Debugger | Grok 4.7 | High | Standard | [office-debugger](../.cursor/agents/office-debugger.md) |
| QA | Grok 4.7 | High | Standard | [office-qa](../.cursor/agents/office-qa.md) |
| Performance | Grok 4.7 | High | Standard | [office-performance](../.cursor/agents/office-performance.md) |
| Independent reviewer | Grok 4.7 | High | Standard | [office-reviewer](../.cursor/agents/office-reviewer.md) |

These role assignments are project choices, not claims of measured model superiority. Benchmark on representative tickets before adjusting them. Difficult implementation may be reassigned to the high-effort debugger under explicit write ownership; the independent reviewer must not have implemented that candidate.

Cursor documents custom agents in `.cursor/agents/`, explicit model IDs, and bracketed model parameters. The files pin `grok-4.6[effort=high,fast=false]` for research/routine coding and `grok-4.7[effort=high,fast=false]` for the other delegated roles. See [Cursor subagents](https://cursor.com/docs/subagents).

Grok 4.6 and Grok 4.7 support high effort and draw from the Cursor Models pool; named third-party subagents can consume Other Models even when the parent is Grok or Composer. This profile therefore avoids third-party selection by default. See [Grok 4.6](https://cursor.com/docs/models/grok-4-6), [Grok 4.7](https://cursor.com/docs/models/grok-4-7), and [Cursor usage pools](https://cursor.com/docs/models-and-pricing).

The [office routing rule](../.cursor/rules/office-model-routing.mdc) directs the parent to use these profiles. The parent model still must be selected explicitly; a custom-agent definition configures a delegated agent, not the model picker. In Cursor CLI, the intended parent setting is:

```sh
cursor-agent --model 'grok-4.7[effort=high,fast=false]'
```

This command expresses the intended Cursor parent selection; it was not executed during setup. Live `npm run harness -- "task"` execution is disabled by the host gate. The [Cursor ACP adapter](./cursor-driver.md) validates explicit advertised configuration IDs/values in deterministic fixtures; it does not launch these native agents or certify office model/effort/speed availability or billing.

## Personal Codex reference

The following is a proposed Codex profile with high-effort architect and QA settings. No native Codex model configuration has been installed by this task.

| Role | Model | Reasoning |
| --- | --- | --- |
| Parent / lead | GPT-6.1 Sol | High |
| Researcher | GPT-6 Luna | High |
| Architect | GPT-6 Astra | High |
| Coder | GPT-6.1 Sol | High |
| Debugger / performance | GPT-6.1 Sol | High |
| QA | GPT-6.1 Sol | High |
| Independent reviewer | GPT-6 Astra | Medium |

Codex model availability and usage depend on the personal ChatGPT/Codex plan or API credentials; Cursor allowances are separate. A cached Codex catalog advertises these IDs but does not prove live entitlement. See [Codex pricing/access](https://learn.chatgpt.com/docs/pricing) and [Codex custom model settings](https://learn.chatgpt.com/docs/agent-configuration/subagents).

## Validation and limitations

- Configuration structure, role references, and local documentation links were checked. No provider inference was run.
- The installed Cursor CLI is `2026.07.09-a3815c0`; the earlier `cursor-agent --list-models` attempt failed with a local keychain error. Live model availability, selected effort/speed, and actual pool billing remain unverified.
- The exact office plan and admin restrictions are unknown. Cursor Start fixes Grok at medium effort; high-effort targets require a compatible plan. If a model or setting is unavailable, report the mismatch and obtain a revised allowed choice instead of claiming the requested profile ran.
- Rules are prompt guidance and custom model settings can be affected by native fallback/admin restrictions. These files do not impose a hard billing cap or change account-level model visibility, built-in helpers, or on-demand settings. Verify actual models in task cards and usage rows; account/admin controls are needed for a hard spending boundary.
- Existing permissions, isolated worktrees, independent review, draft PRs, and requested videos remain governed by [AGENTS.md](../AGENTS.md). Higher reasoning never substitutes for executed checks.
