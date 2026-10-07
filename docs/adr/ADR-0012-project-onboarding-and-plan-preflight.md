# ADR-0012: Project onboarding and plan preflight

Status: Accepted for offline workflow preparation
Date: 2026-10-07

## Decision

Register project identity, PRD/SRS/ADR references and non-secret workflow preferences in repository config. Ask about prompt frequency, draft PRs, text/video/both evidence and plan behavior (approve/show/quiet auto). Reuse project choices with task-local overrides; every-task mode requires fresh choices. A combined preparation command onboards unfamiliar projects. Explicitly new projects may scaffold missing draft requirements and a proposed ADR template.

Require a concrete source-bound plan before workflow advancement. Bind owner approval to project/task/principal/workspace, source, plan and preference digests and expiry. Require separately verified pre-edit recording evidence for video mode. Workflow readiness never grants runtime or publishing authority.

## Consequences

Repository config expresses preferences and source registration; authoritative task, memory, policy and persistent approval state remains runtime-owned under ADR-0006. Cloned config does not carry grants. Requirements/decisions are content and provenance, never authority. Templates remain unresolved until reviewed.

The portable CLI implements onboarding, supplied-plan display and local in-memory review. The core gate supports a trusted opaque receipt verifier. Full memory ingestion, automatic generated plans, authenticated durable approvals, baseline/after recording and live ticket execution remain pending. CLI source digests are owner-supplied assertions requiring verification at future runtime integration.

## Evidence

See [workflow instructions](../project-workflow.md) and source-bound tests/review under `docs/artifacts/project-workflow/`.
