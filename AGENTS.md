# forgemind

ForgeMind is a local-first harness for supervised AI coding (TypeScript, Node.js, macOS).

## Quick Start

### Installation
```bash
npm ci
```

### Build
```bash
npm run build
```

### Test
```bash
npm run test:portable          # portable fixtures, 5-minute limit
caffeinate -i npm run test:local  # full set on a Mac, 30-minute limit
```

## How work runs

1. `npm run project:run` takes a task manifest.
2. The planner writes a plan that the owner approves.
3. The work can optionally be split into 1 to 8 ordered subtasks.
4. Coding (single-call or host tools) happens only in `writePaths`.
5. Baseline and candidate checks run.
6. A fresh, independent review follows.
7. A draft PR is optional.
8. Every run is recorded in the central brain, the run prompts include the brain context, and lessons are proposed for owner approval.

## Memory

- The central brain lives in `~/.forgemind/brain`. There is one per computer, and it is never in git.
- The `forgemind-brain` MCP tools are `brain_context`, `brain_search`, `brain_propose` and `brain_record`.
- Review proposed entries with `npm run brain -- list|approve|reject`.

See [docs/brain.md](docs/brain.md).

## Model Routing Profiles

Use [docs/model-routing.md](docs/model-routing.md) for role-specific model choices. Office Cursor uses the named `office-*` configurations in `.cursor/agents/` and `.cursor/rules/office-model-routing.mdc`: Grok 4.6 high effort at standard speed for research/routine coding and Grok 4.7 high effort at standard speed for the lead, architecture, debugging, QA, performance, and independent review.

Keep the office Cursor profile separate from personal Codex access. Reserve the Other Models allowance; selecting third-party office models or enabling paid overages requires explicit task-level authorization. Do not treat project rules as a hard billing cap: verify actual model/effort/speed and report fallback or account restrictions. An agent model choice cannot add execution permissions.

## Concurrency and authority invariants

- Never allow two writers in one worktree.
- Read-only research agents may share a checkout; writing agents may not.
- A child may drop capabilities but can never add tools, servers, namespaces, network access, spend, concurrency, or delegation depth.
- Cancel dependent and not-yet-started sibling work when policy denies an action or a required dependency fails.
- Only the integration agent changes shared manifests or lockfiles.
- Task-scoped commits, branch pushes, and draft PR creation are authorized by the implementation-ticket completion workflow below. Other commits/pushes, merging, releases, and worktree deletion require separate user authorization.
- Every consequential action must produce a policy decision receipt; production, destructive, spend, and promotion actions may require human approval.

### Repository harness adapter

When tracked repository instructions define a local collaboration harness:

1. Assign the isolated worktree before starting a writing session.
2. Start or register the session, inspect current claims, and acquire only the
   exact paths, resources, and development ports needed for the task.
3. Renew leases during long work, check acknowledged inbox messages at integration
   boundaries, and release claims when handing off or ending.
4. Record focused and integration evidence against the exact source state,
   then let the designated integration owner decide release.

A repository lease coordinates ownership; it does not grant authorization.
In-memory reference adapters demonstrate semantics but are not distributed,
restart-durable release authorities.
The worker still needs the current ADR-324/325 action capability and fencing
epoch for every protected side effect. Heartbeat and lease expiry establish
liveness; a PID is diagnostic only. HEAD alone is not an exact source-state
identity when tracked or untracked changes exist, so a release receipt must
bind a clean commit or an immutable snapshot including those changes.

## Implementation-Ticket Completion Workflow

The user has requested draft PRs as the default completion deliverable for implementation tickets. This provides standing authorization for the task-scoped commits, pushes to a task branch, and draft PR creation needed in the established repository. Preserve unrelated changes; never push directly to the default branch or force-push under this authorization. The lead/integration agent owns final reconciliation and PR creation.

### Before and after evidence

1. Before editing, identify the baseline commit or immutable source snapshot and capture the relevant existing behavior using reproducible steps. For a new feature, document the starting behavior or absence of the feature.
2. Implement the change and run the appropriate focused and required integration checks.
3. Repeat the same scenario against the candidate source state and capture the resulting behavior. Bind checks and evidence to the exact source inputs; do not invent baseline observations or claim unrun tests.
4. Reconcile worker outputs into the final candidate and assign a separate reviewer agent to assess it under the independent review requirements below. Resolve blocking findings and re-review affected changes before proceeding.
5. Commit only ticket-owned, reviewed changes, push the task branch, and create a draft PR in the established repository. Record the policy decision and resulting base/head identities and PR URL. Draft PR authorization does not authorize merging or releasing.
6. Report the draft PR link, before/after behavior, checks and results, reviewer verdict, and unresolved limitations in the final handoff.

The PR description must include:

- **Before:** the concrete problem or starting behavior, reproduction steps, and baseline evidence.
- **After:** the resulting behavior and candidate evidence, using the same scenario where applicable.
- **Validation:** checks actually run, their results, and source identities.
- **Review:** independent reviewer verdict, reviewed source identity, findings resolved, and any non-blocking residual findings.
- **Limitations:** remaining issues or unavailable evidence, when present.
- **Videos:** links to requested recordings, when available to reviewers through an authorized destination.

If repository destination, authentication, or required publishing permissions are unavailable, complete all independent local work and prepare the exact PR title/body first. Report the specific blocker and request only the missing information or authorization. Do not report a PR as created without its URL.

### Independent review before completion

- The lead/integration agent assigns a reviewer who did not implement the candidate. Give the reviewer the original task and acceptance criteria, baseline/candidate source identities, final diff, test results, before/after evidence, and requested videos.
- Grant read-only access to the candidate and approved non-mutating verification; review artifacts may be written in an assigned location. The reviewer cannot silently repair the candidate, broaden grants, waive policy, or merge/release the work.
- The reviewer assesses correctness, regressions, security, maintainability, policy compliance, and evidence quality. Record findings with severity and evidence references, an acceptance-criteria decision, and a pass/revise/blocked verdict, following the Reviewer Agent role in `docs/agents.md`.
- Return requested changes to the implementation owner. Re-run relevant checks and obtain re-review when the candidate changes. Review evidence must identify the exact source state ultimately committed and pushed; a verdict for an earlier candidate does not cover later edits.
- Unresolved blocking findings or an unavailable independent reviewer leave the ticket incomplete. Report the blocker; never represent the implementer's self-review as independent review. A reviewer pass is evidence for completion, not authority to merge or release.

### Requested before and after videos

When the user asks for a before/after video, treat recording and delivery as required ticket acceptance criteria.

- Plan capture before making changes. Record the baseline and candidate behavior using the same scenario, with comparable framing and clear Before/After labels; separate recordings or one comparison video are acceptable unless the user specifies a format.
- If changes already exist, reproduce the baseline in an isolated checkout or environment without overwriting current work. If the baseline cannot be reproduced, disclose the gap and leave that deliverable incomplete.
- Record actual behavior and inspect the exported files for playback, readable content, and coverage of both states. Animations or mockups cannot substitute for recordings of the requested behavior.
- Save artifacts under `docs/artifacts/<task-id>/` or the task's established artifact directory. Deliver clickable artifact links in the final handoff and add reviewer-accessible links to the draft PR when an authorized sharing destination exists. Local paths alone are not reviewer-accessible PR evidence.
- Follow the existing action grants for uploads or external sharing. Report unavailable recording tools or blocked delivery explicitly; do not silently omit a requested video or claim it was recorded.

## Code Standards

### File Organization
- **NEVER** save to root folder
- `/src` - Source code files
- `/tests` - Test files
- `/docs` - Documentation
- `/config` - Configuration files

### Quality Rules
- Files under 500 lines
- No hardcoded secrets
- Input validation at boundaries
- Typed interfaces for public APIs
- TDD London School (mock-first) preferred

### Commit Messages
```
<type>(<scope>): <description>

[optional body]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

Do not add a `Co-Authored-By` trailer unless the repository explicitly
configures and authorizes that attribution.

## Security

### Critical Rules
- NEVER commit secrets, credentials, or .env files
- NEVER hardcode API keys
- Always validate user input
- Use parameterized queries for SQL
- Sanitize output to prevent XSS

### Path Security
- Validate all file paths
- Prevent directory traversal (../)
- Use absolute paths internally
