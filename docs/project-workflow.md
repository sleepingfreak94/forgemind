# Project documents and planning preferences

PRD/ADRs and the accepted project/session memory architecture already exist. Local-owner durable project memory, document ingestion and FTS5 retrieval are now implemented; see [project memory setup](./project-memory.md). Automatic model-generated planning and the wider organization/session memory architecture remain pending. This slice adds per-project onboarding/preferences and a deterministic preimplementation gate. Live coding and full ticket orchestration stay disabled.

## Project sources and choices

`config/forgemind-project.json` registers a stable project ID, PRD/SRS/ADR references and non-secret workflow preferences. PRD records product goals; SRS records testable requirements and constraints; ADRs record decisions, alternatives and consequences. New-project scaffolding creates only missing **Draft** requirements and a **Proposed** ADR template. It preserves existing documents and leaves unresolved requirements explicit.

Project memory stores validated facts/decisions linked to versioned sources with expiry and supersession. SQLite now serves separate policy and project-memory stores; wider tasks/approvals persistence under ADR-0006 remains pending. Ruflo is the separate development ledger. Documents and preferences never grant permissions. Cloned config retains project identity, while each workspace still needs fresh trusted runtime registration and grants.

Onboarding asks:

| Question | Choices | Offered default |
| --- | --- | --- |
| When to ask | Once per project / every task | Once per project |
| Draft PR deliverable | Yes / no | Yes |
| Before/after evidence | Text / video / both | Text |
| Plan behavior | Approve / show / auto (quiet preflight) | Wait for approval |

An explicit blank answer selects the displayed preference default. Unanswered/closed input does not select or approve anything. Unset choices stay blocked. Subsequent setup reuses saved choices; task overrides leave project defaults intact. Every-task mode requires all three delivery choices afresh. ForgeMind's standing PR authorization does not transfer to another repository.

## Onboard a project

```bash
npm run project:init -- --workspace /absolute/path/to/project --project-id project-a
```

Add `--new` to scaffold missing draft PRD/SRS/ADR templates. Existing profiles are not overwritten; edit settings explicitly to change project defaults. For scripted setup, add `--preferences /absolute/path/to/preferences.json`; see the [preference example](../config/project-workflow.example.json). Use `npm.cmd` in native Windows PowerShell.

For one preparation command across projects, use `npm run project:prepare` with the same planning flags plus `--project-id project-a`. An unfamiliar project is onboarded before planning; registered projects reuse their profile. Add `--new` only for the first setup when missing draft documents should be scaffolded. Invalid plan/source/override inputs are rejected before onboarding writes. Actual filesystem I/O failure can leave partial draft files; existing documents are never overwritten.

The command writes non-secret config/draft documents in the selected repository, with no provider calls or policy grants. Linked directory paths and invalid relative paths are rejected. This is trusted local setup; it does not implement Windows ACL enforcement or isolation from hostile same-UID host processes.

## Show the implementation plan

The plan shows objective, affected paths, steps, acceptance criteria, checks, risks, rollback, deliverables, source and settings digests. The trusted orchestrator must supply current immutable source and principal/task/workspace context. This CLI accepts a supplied JSON plan and owner-provided source digest; it does not generate implementation analysis or verify a complete repository snapshot. See the [plan example](../config/implementation-plan.example.json).

```bash
npm run project:plan -- --workspace /absolute/path/to/project --task-id ticket-42 --source-snapshot <sha256> --plan /absolute/path/to/plan.json --preview
```

Replace placeholders with actual inputs. `--preview` shows the plan and unmet prerequisites without asking for approval. Without it, required task choices are asked, the plan is displayed, and review mode waits for the literal answer `approve`. Empty input, denial and EOF do not approve.

Overrides: `--draft-pr yes|no`, `--evidence text|video|both`, `--plan-review approve|show|auto`. They affect only this task and are preserved when remaining choices are prompted. Approve displays the plan and waits; show displays it and proceeds to policy; auto keeps the prepared plan quiet and proceeds to policy. `--preview` always displays it, including auto mode. Auto does not generate a plan or enable coding. The interactive review receipt is held in that process; it is local planning evidence, not authenticated durable identity or a runtime grant. A plan/config file cannot supply that receipt. Production integration must use trusted owner/evidence verification and revalidate current source/settings before acting.

## Workflow gates

`prepareWorkflow` validates and snapshots the profile, plan, scope and overrides. `evaluateWorkflow` rebuilds that preparation and returns:

- `needs-preferences`: project choices are incomplete;
- `needs-task-preferences`: fresh task choices are required;
- `needs-plan-approval`: a verified owner receipt is missing or mismatched;
- `needs-before-video`: verified pre-edit recording evidence is missing;
- `ready-for-policy`: workflow prerequisites passed; runtime policy still decides actions.

Every result has `liveCodingEnabled: false`. Receipts bind project, task, principal, workspace, source, plan/settings digests and expiry. Changes invalidate prior approval. A separate source/plan-bound before-video receipt is required when video is selected. Plan approval, a user boolean, text or animation cannot substitute for an actual baseline recording.

The recorder must capture and verify baseline behavior before edits, then capture the after state after validation and deliver both artifacts. No recorder is supplied here, so the CLI leaves video tasks at `needs-before-video`. After-video/completion enforcement belongs to the pending full task runner. Task plans never execute the displayed check commands themselves.

The preparation command automatically onboards unfamiliar projects using a supplied plan. The legacy live launcher stays disabled. Local project memory/retrieval is integrated into supplied-plan preparation, automatically when its default store exists, or with --memory-state-dir for an explicit location. Cited context enters the plan digest and is checked again during review. Integration with live execution, generated plans, persistent authenticated approvals, recording delivery and actual PR integration remains pending. See [ADR-0012](./adr/ADR-0012-project-onboarding-and-plan-preflight.md). Tests run in the portable and full suites.
