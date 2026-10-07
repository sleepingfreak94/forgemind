# ADR-0007: Local Identity and Policy

- Status: Accepted for the deterministic local policy slice
- Date: 2026-10-07
- Deciders: ForgeMind maintainer (requested implementation in project conversation)

## Decision

Use a single trusted local host running under the owner's POSIX user identity. Persist a random principal ID in a private SQLite state directory outside agent workspaces. No login server is required for this mode. An ID is an identifier, not an authentication credential: ownership comes from the trusted launch process and OS access controls. Another process running as that same OS user is inside this trust boundary.

Every launch creates a new session epoch and fences previous sessions. Persisted grants and approvals remain evidence but cannot authorize a new session. The host must reissue grants on resume. Register each database to one logical repository and canonical local workspace root; additional workspaces require separate registrations/stores in this first slice.

The trusted host creates invocation-bound task grants. Agent JSON cannot supply its principal, grant selection, approval flag, or executable shell arguments. Agents receive only the checked action endpoint, with invocation context bound by the host. The owner API and SQLite store must remain inaccessible to workers.

Use a deterministic TypeScript evaluator with deny-by-default, exact action/resource capabilities. File resources are canonical absolute paths constrained to the registered workspace; reject traversal and symlinks below its root. Read-only roles receive file reads only. Coding/QA grants name exact writable files and allowed command identifiers. Network destinations are exact HTTPS URLs. No spend action is supported.

Child grants cannot expand capabilities, task scope, lifetime, delegation depth, action budgets, or child limits. Recheck all ancestors at every action. Charge every successful reservation against every ancestor so siblings share their parent's budget. `maxChildren` is a per-parent lifetime issuance limit, including revoked children; it is not a concurrency limit. The fake runtime dispatches serially. Real worker scheduling and concurrency reservations remain adapter/orchestration work.

The lead can receive explicit task-scoped commit, branch-push, and draft-PR capabilities under the existing standing authorization. These capabilities must name the approved task branch/resource; the host must not translate that authorization into default-branch or force-push access. This slice only simulates those actions. Merge and release require an otherwise valid capability plus owner approval for the exact invocation, request, source snapshot, session and policy version. Approval expires within five minutes and is consumed once. Approval cannot override a denial. Policy versions cannot be reused to revive grants.

Persist grants, approvals, reservations and content-minimized receipts with parameterized SQLite statements. Reserve a request ID, consume its approval and charge budgets in one transaction before dispatch. Revalidate current authority and paths immediately before synchronous fake execution. Failure to persist the authorization receipt prevents execution. If completion recording fails after dispatch, retain the durable reservation and do not replay automatically; the outcome requires reconciliation.

## Implementation boundary

- `src/policy/` owns contracts, validation, policy evaluation, persistence and checked dispatch.
- `src/agent-drivers/fake.ts` is a deterministic action/effect executor with in-memory writes. It performs no real file writes, shell commands, network, Git or model calls and does not implement the full Agent Driver session protocol.
- The host supplies a source snapshot identity. A real adapter must compute and verify an immutable snapshot including dirty and untracked inputs; accepting an agent's claimed hash is insufficient.
- The current implementation runs on POSIX with Node 26.7 or newer. The SQLite adapter uses [Node's SQLite API](https://nodejs.org/api/sqlite.html), currently documented as release candidate, behind the policy store boundary.
- The host API is not a sandbox. A real driver must intercept every protected action and restrict filesystem, subprocess, network and credential access. Reject driver capabilities that cannot be enforced. [Node's permission documentation](https://nodejs.org/api/permissions.html) describes its runtime restrictions; native permission controls alone must not be assumed to isolate hostile workers.
- The store is private and durable, but not encrypted or tamper-evident against the local owner. Retention/backup defaults remain a separate decision.

## Acceptance and evidence

`npm test` verifies deny paths, child attenuation, aggregate budgets, expiry/revocation, session fencing, exact approvals, replay prevention, audit failure and SQLite restart/contention. `npm run demo:policy` runs the reproducible fake scenario and checks its expected outcomes. See [local policy usage](../local-policy.md) and [baseline evidence](../artifacts/local-policy/baseline.json).
