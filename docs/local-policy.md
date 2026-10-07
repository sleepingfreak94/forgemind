# Local Policy Runtime

This identity/policy slice was introduced under [ADR-0007](./adr/ADR-0007-local-identity-and-policy.md). Its worker `execute` endpoint remains a deterministic fake action executor. The separate privileged `reserveExternal` endpoint now backs the [real offline host](./host-enforcement.md), with native Codex initialization and deterministic driver execution verified. Live provider/write access and Cursor conformance remain subsequent work.

## Run it

Requires POSIX and Node 26.7 or newer. From the repository root:

Native Windows currently has only the [portable setup/fixture verification path](./windows.md). It cannot open this owner-mode policy runtime; Windows SID/ACL enforcement is pending. Do not replace this boundary with an environment username or relaxed file permissions.

```sh
npm ci
npm test
npm run demo:policy
```

The demo creates disposable workspace and private state directories, grants a child one write capability, allows that fake write, denies an outside-workspace request, revokes the parent and denies the child, then reopens SQLite and verifies that the principal survives while the old session is fenced. It asserts exactly one fake call and cleans up its temporary directories.

## Trusted host integration

```ts
const runtime = LocalPolicyRuntime.open({
  stateDirectory: '/private/owner-controlled/forgemind/project-state',
  workspaceRoot: '/absolute/canonical/task-worktree',
  repositoryId: 'repo:project',
  sourceSnapshot: () => currentHostVerifiedSnapshot,
});

const grant = runtime.issueGrant({
  taskId: 'ticket-123', invocationId: 'coder-123', role: 'coder',
  capabilities: [{ action: 'file.write', resource: 'src/example.ts' }],
  expiresAt: Date.now() + 600_000,
  remainingDepth: 0, maxActions: 10, maxChildren: 0,
});

const endpoint = runtime.bind(grant.id, grant.invocationId);
const result = endpoint.execute({
  requestId: 'ticket-123-write-1',
  action: 'file.write', resource: 'src/example.ts',
  sourceSnapshot: currentHostVerifiedSnapshot,
  content: 'export const value = 1;',
});
```

Import `LocalPolicyRuntime` from `src/policy/runtime.ts` (compiled JavaScript under `dist/`). This example is host code. Workers must receive only a transport endpoint bound to their invocation; do not expose `runtime`, owner methods, the state directory, or the database connection.

`execute` returns a policy decision and `blocked`, `succeeded` or `failed`. An `allow` decision authorizes an attempt; inspect the execution status before claiming success. Storage exceptions abort execution or leave an already-reserved attempt indeterminate. Inspect receipts and reconcile rather than blindly retrying with a fresh ID. The fake executor records requests and in-memory writes; it does not return real file-read or command output.

Resources match exactly. There are no implicit globs, directory grants or arbitrary shell arguments. `command.run` references a host-allowlisted command identifier; the real adapter must map it to a fixed executable, arguments, working directory, environment and sandbox. Network grants need destination and redirect enforcement at the real transport boundary. Unsupported spend/tools/namespaces/concurrency fields are rejected.

Root grant issuance and `approve`, `revoke`, `updatePolicyVersion` are owner-only APIs. The model cannot call them directly. A lead's delegation request must go through trusted invocation registration and checked child issuance. Read-only roles have only file reads; QA receives only the test/artifact paths that the host authorizes.

## Persistence and failure behavior

- The owner UID and stable principal are stored in a private `policy.sqlite` file (0600) in a private directory (0700). The state directory must be canonical and outside the agent workspace. Local owner compromise and same-user hostile processes are outside this prototype's isolation boundary.
- A new launch fences old hosts and grants. Reopening the store proves durability, not permission to resume old work automatically.
- Schema version 2 is created transactionally; version 1 migrates without discarding grants/receipts. Unknown future schema versions are rejected. External attempts persist their sealed envelope, reserved status and terminal view/output evidence; a new host session marks unfinished attempts indeterminate.
- Every action checks all ancestors. Reservations charge ancestor budgets atomically, so siblings cannot multiply the parent allowance.
- Request IDs are unique across the store. Reserved requests cannot execute again, including failures and unknown completion outcomes.
- Approval is bound to the full normalized request digest (including write content where applicable), invocation, grant, source, session and policy. Only merge/release use interactive approval in this slice; capabilities remain necessary.
- Receipts omit raw file content and provider tokens. They contain action/resource identifiers, task/invocation/source references, outcomes and digests. Retention and deletion defaults are still pending.

## Gate before a real adapter

The [Codex protocol slice](./codex-driver.md) and [offline host](./host-enforcement.md) now connect trusted invocation registration, durable launch reservation, selected source snapshots, native sandbox mapping, supervision and terminal checks. The host facade must not be exposed to model JSON. Next implement provider credential/egress/spend and exact write/command enforcement before live tasks. Keep unsupported capabilities disabled; fake tests and offline checks do not certify native model turns or a distributed release authority.
