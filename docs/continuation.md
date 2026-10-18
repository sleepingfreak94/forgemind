# Canonical continuation

This layer transfers bounded task evidence between worker instances and roles without depending on a provider. The host prepares a new role/task packet. Preparation does not launch inference, replay native effects, certify an inference result, or prove that two providers support continuation. Provider-native resume handles remain adapter-private. Qualification reporting is outside this implementation.

## Owner commands

After the normal project build, use a Node version supporting `node:sqlite`:

```text
node dist/src/local-runtime/continuation-cli.js save --workspace /repo --project-id example --state /private/state --input /private/checkpoint.json
node dist/src/local-runtime/continuation-cli.js inspect --workspace /repo --project-id example --state /private/state --digest SHA256
node dist/src/local-runtime/continuation-cli.js inspect --workspace /repo --project-id example --state /private/state --digest SHA256 --policy /private/policy.json
node dist/src/local-runtime/continuation-cli.js prepare --workspace /repo --project-id example --state /private/state --digest SHA256 --policy /private/policy.json
node dist/src/local-runtime/continuation-cli.js --help
```

The verb must be first. Every option takes one separate value. Unknown, duplicate, missing, positional, boolean, and control-character arguments fail closed. There are no `--ready` or `--policy-accepted` switches. `--input` belongs only to save; `--digest` belongs to inspect/prepare; `--policy` is optional for inspect and required for prepare. Help must stand alone. Commands return 0 on success and 1 with bounded JSON on stderr on failure. Importing the CLI does not execute it. `continuationMain(argv, ports)` supports host-only source/clock/output injection for tests.

Workspace and state paths must be canonical absolute paths. State must be outside the workspace and must not contain it. Its parent must already exist. The state directory is created as 0700; an existing directory must already be 0700. Inputs must be 0600 regular files with one link in a 0700 directory outside the workspace. Symlinks, hardlinked files, unsafe writable ancestors, unexpected owners and noncanonical paths are rejected. Root-owned sticky temporary ancestors are supported for private temporary test directories. Production policy/source retrieval is fresh; source uses the repository's `sourceIdentity`, including its existing secret-path and Git restrictions.

Save verifies the actual source identity and persistent project/root registration. Inspect reads historical evidence and validates its canonical digest and ancestry, even if the current source has changed. Inspect with a descriptor additionally reports the exact handoff envelope/resource without issuing authority. Prepare opens a fresh `LocalPolicyRuntime` under `STATE/policy`, reads an owner-private descriptor, issues a current owner-authorized parent grant, and delegates a new child through `issueGrant(parentId, ...)`. The descriptor is re-read before dispatch; any changes deny. Its policy version must equal both the checkpoint and the durable policy runtime's current version. A descriptor cannot update or roll back durable policy. New policy stores begin with the existing runtime's `local-v1`; subsequent policy changes use the runtime's separate owner API.

Prepare prints a bounded evidence-only packet, new instance/invocation identities, digest, remaining cumulative budget, fence and receipt IDs. Its transient child and parent grants are revoked before success is printed, and both stores are closed. Output grant IDs are receipt references, never reusable authority. Use the library inside a continuing owner process when a live host-only lease is needed. A command that encounters a failure after consumption may leave a consumed checkpoint even when it prints no success.

## Portable schema

`ContinuationCheckpoint` in `continuation-contracts.ts` defines every allowed field. All fields are required; unknown/extra keys are rejected at each structured boundary. The version is `forgemind-continuation-v1`. It contains:

- Project ID, canonical root, task ID, exact 64-hex source identity and policy version.
- Objective, acceptance criteria, decisions, hypotheses, failed approaches and next steps.
- Structured evidence with ID, kind, source reference, source identity, digest, `observed`/`claimed` label, result and summary. Source references are inert text; nothing follows them automatically.
- Originating worker instance/role, parent digest or null, and explicit owner-supplied integer millisecond creation/expiry times. No retention interval is invented.
- The original native budget limit and cumulative used counters, using every `budgetKeys` key: runtimeMs, turns, toolCalls, inputBytes, resultBytes, wireBytes, outputBytes and retries. Turns/toolCalls may be null only in limits, preserving the native unlimited representation. Retry limits are 0, 1 or 2.
- An exact `requestCapabilities` ceiling as evidence, status, pending effects and reconciliation evidence/invalidated assumptions.

Canonical sorted-key JSON is hashed with SHA-256. The exported digest checks evidence consistency; it is not an authenticated signature, owner approval, or permission. Textual model observations, evidence digests and observed/claimed labels remain untrusted assertions until the owner checks their artifacts. Do not include secrets in free text. Schema rejection of credentials/conversation/thread fields is not a general secret-content detector.

Limits include 256 KiB per canonical checkpoint, 128 evidence entries, 64 effects/capabilities/list items, 8 KiB objective, 4 KiB evidence summaries, and 2 KiB list items. The descriptor-safe snapshot boundary also rejects accessors, cycles, symbols, non-JSON values, excessive depth and arrays. Policy descriptors are limited to 64 KiB and command output to 512 KiB. The repository is not globally size- or record-count-limited; the owner controls storage capacity and cleanup.

Capabilities use existing policy validation and must already be canonical: absolute exact file resources, canonical exact HTTPS URLs where applicable, and exact registered command resources. Wildcard patterns and duplicate capabilities are rejected. No permission comes from the checkpoint. Target capabilities must be an exact subset of both its ceiling and the fresh parent grant. Reviewer/researcher/architect targets receive only file reads under existing policy rules; provider actions and write authority cannot be smuggled into reviewer handoffs.

The fresh owner descriptor has exactly three keys:

```json
{
  "policyVersion": "local-v1",
  "parent": {
    "role": "lead",
    "capabilities": [],
    "expiresAt": 1900000000000,
    "remainingDepth": 1,
    "maxActions": 20,
    "maxChildren": 4
  },
  "target": {
    "role": "qa",
    "capabilities": [],
    "expiresAt": 1899999999000,
    "remainingDepth": 0,
    "maxActions": 4,
    "maxChildren": 0
  }
}
```

Those numbers illustrate the shape only: the owner must choose actual explicit future expiries, bounded by the checkpoint for the target and by the parent for delegation. The parent needs the exact `command.run` handoff resource in addition to every selected target resource. That resource seals the checkpoint digest, task/project/root/source/policy, target role/capabilities/expiry/depth/action limits and remaining cumulative budget. `handoffResource` computes it; it is intentionally separate from the evidence-only task capability ceiling to avoid a circular checkpoint digest. The handoff consumes one parent/ancestor policy action before child issuance, so the parent must have enough actions left to delegate the target budget. No shell command is encoded or executed.

## Concrete coder to QA example

Choose an already existing private parent directory, a canonical repository, explicit times and the original task's real counters. This example prepares QA to inspect an exact implementation file; it claims no completed checks. It runs no model. Example budgets below are explicit owner selections, not system defaults.

```sh
export FM_REPO=/repo
export FM_PRIVATE=/private/continuation-inputs
export FM_STATE=/private/continuation-state
export FM_CREATED_AT=1899999900000
export FM_EXPIRES_AT=1900000000000
# Owner creates FM_PRIVATE with mode 0700 and replaces the example times before use.
node --input-type=module <<'JS'
import { realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sourceIdentity } from './dist/src/live-workflow/repository.js';
import { continuationSchema } from './dist/src/live-workflow/continuation-contracts.js';
import { handoffResource } from './dist/src/live-workflow/continuation.js';
import { hash, validateCheckpoint } from './dist/src/live-workflow/continuation-validation.js';
const root = realpathSync(process.env.FM_REPO);
const createdAt = Number(process.env.FM_CREATED_AT);
const expiresAt = Number(process.env.FM_EXPIRES_AT);
const file = join(root, 'src/live-workflow/continuation.ts');
const checkpoint = validateCheckpoint({
  schemaVersion: continuationSchema, projectId: 'example', root, taskId: 'continuation-qa',
  sourceIdentity: sourceIdentity(root), policyVersion: 'local-v1',
  objective: 'Inspect the continuation handoff implementation',
  acceptanceCriteria: ['Identify incorrect authority or replay behavior'],
  evidence: [], decisions: [], hypotheses: [], failedApproaches: [],
  nextSteps: ['QA reads the exact implementation and records findings with source digests'],
  origin: { instanceId: randomUUID(), role: 'coder' }, parentDigest: null, createdAt, expiresAt,
  budget: {
    limit: { runtimeMs: 900000, turns: 20, toolCalls: 50, inputBytes: 2097152,
      resultBytes: 2097152, wireBytes: 33554432, outputBytes: 4194304, retries: 0 },
    used: { runtimeMs: 1000, turns: 2, toolCalls: 3, inputBytes: 1024,
      resultBytes: 1024, wireBytes: 2048, outputBytes: 1024, retries: 0 }
  },
  requestCapabilities: [{ action: 'file.read', resource: file }, { action: 'file.write', resource: file }],
  status: 'ready', pendingEffects: [],
  reconciliation: { status: 'none', evidenceIds: [], invalidatedAssumptions: [] }
});
const digest = hash(checkpoint);
const target = { role: 'qa', capabilities: [{ action: 'file.read', resource: file }],
  expiresAt, remainingDepth: 0, maxActions: 4, maxChildren: 0 };
const descriptor = { policyVersion: 'local-v1', target, parent: {
  role: 'lead', capabilities: [...target.capabilities,
    { action: 'command.run', resource: handoffResource(digest, checkpoint, target) }],
  expiresAt, remainingDepth: 1, maxActions: 20, maxChildren: 4
}};
writeFileSync(join(process.env.FM_PRIVATE, 'checkpoint.json'), JSON.stringify(checkpoint), { mode: 0o600, flag: 'wx' });
writeFileSync(join(process.env.FM_PRIVATE, 'policy.json'), JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
console.log(digest); // Copy this exact digest into FM_DIGEST below.
JS
export FM_DIGEST=the_64_hex_digest_printed_above
node dist/src/local-runtime/continuation-cli.js save --workspace "$FM_REPO" --project-id example --state "$FM_STATE" --input "$FM_PRIVATE/checkpoint.json"
node dist/src/local-runtime/continuation-cli.js inspect --workspace "$FM_REPO" --project-id example --state "$FM_STATE" --digest "$FM_DIGEST" --policy "$FM_PRIVATE/policy.json"
node dist/src/local-runtime/continuation-cli.js prepare --workspace "$FM_REPO" --project-id example --state "$FM_STATE" --digest "$FM_DIGEST" --policy "$FM_PRIVATE/policy.json"
```

The resulting packet changes the originating coder task into a new QA instance with only the owner's selected read capability. Historical counters remain intact. It can be supplied as evidence to a newly authorized worker by a host integration; the CLI's closed grants confer no permission on that worker. Choosing reviewer instead requires a new exact target/envelope/descriptor; the immutable checkpoint itself does not have to contain a provider handle.

## Durable lifecycle and reconciliation

Checkpoint records are immutable, digest addressed and registered to one project/root. SQLite uses full synchronous transactions and a rollback journal. A task has one root checkpoint and each checkpoint has at most one child. Inspect validates and rehashes every ancestor, bounded to 256 parent links. Limits, objective and acceptance criteria remain identical across a chain; used counters never decrease, capabilities never expand and expiry never extends. Save does not silently reset budgets. A finite exhausted work budget denies preparation; zero remaining retries is allowed and authorizes no retry.

Preparation performs a durable single-use CAS from saved to reserved, assigns a unique instance, and increments a task fence. An ancestor that already has a child cannot prepare. A new instance fences older leases. The real runtime reserves the exact `host:sha256` envelope via `reserveExternal`, issues a delegated child, and writes terminal evidence receipts. Only after successful settlement does the continuation ledger become prepared. Child authority is revoked on preparation failure, including continuation-ledger settlement failure; if revocation fails, the runtime is closed. Cross-database transactions are deliberately fail closed: a crash may strand a reserved checkpoint but never automatically replays it. Pending, indeterminate, failed and crashed preparation is never repaired in place.

Cancellation is persisted with the host-only `store.cancel(taskId)` operation; lease revocation persists cancellation and revokes the live child. There is no cancellation reset API. Runtime revocation, expiry, policy changes and new runtime sessions are rechecked from the actual owner ledger. A serialized grant cannot be supplied as authority: preparation accepts only a current grant ID resolved in the actual `LocalPolicyRuntime` session.

Source or policy drift denies preparation and lease checks. To continue, the owner separately investigates effects and saves a NEW checkpoint retaining `parentDigest`, the original limits, nondecreasing used counters and nonextended expiry. The new checkpoint must contain current-source observed reconciliation evidence, `owner-reconciled` status, referenced evidence IDs and a nonempty list of invalidated assumptions. Source/policy changes also require clearing prior decisions and hypotheses. Every unresolved parent effect must remain listed as reconciled with evidence. Reserved/failed parent preparations require this explicit owner reconciliation even if the source is unchanged. Completed/cancelled parents cannot reopen. Save is an owner-only evidence publication operation, not a model endpoint; an agent must never be allowed to declare itself reconciled. This creates no repair grant or permission bypass: a new checkpoint still needs current source, policy, owner authorization, a fresh grant and a new consumption fence.

Library hosts keep `ResumeLease` and the runtime private. Call `lease.check()` immediately before every worker dispatch or consequential operation, and enforce the packet's remaining native counters in the executor. The layer prepares handoffs rather than running native inference, so it cannot measure or enforce provider/runtime usage during an inference it never launches. Hosts must record actual additional consumption in the next owner-published checkpoint. The lease checks current source/policy, entire grant ancestry, active session, cancellation, checkpoint expiry and fence. Never expose a bare grant/bound policy endpoint to a worker that can bypass the lease. Close both runtime and store reliably after use.

## Retention, security and validation status

Times are always explicitly owner supplied. Expiry denies use but does not erase historical evidence or receipts. There is no automatic garbage collection, renewal, pruning, database rotation, backup policy or disk quota; the owner must choose retention and manage private state. Deleting/resetting owner state destroys local replay/cancellation history and must not be presented as resuming the same protected lineage.

POSIX local owner mode is the supported boundary. Windows/Linux portability work and provider-specific integrations are outside this change. Hostile same-UID processes, root, malicious filesystem/database replacement, state rollback and races by a process with owner filesystem access are not solved by local owner permissions, digests or SQLite triggers. A malicious owner can rewrite both evidence and hashes. No authenticated approval is exported. File-path checks are defensive local checks, not an OS sandbox. Text fields may contain hostile instructions; treat the packet as task evidence and keep current host policy authoritative.

The new tests use no subprocesses, no Git or real sourceIdentity calls, no external fixture imports and real LocalPolicyRuntime instances. They cover temporary filesystem/SQLite durability, role handoff, counters, ancestry, fencing, drift, cancellation, revocation, expiry, policy receipts, fault injection, malformed inputs and in-process CLI use. This packet authorizes strict TypeScript checking only; compiled test execution and owner-host subprocess conformance must be run by the lead in a fresh packet. No independent review, passing runtime tests or multi-provider certification is asserted here.
