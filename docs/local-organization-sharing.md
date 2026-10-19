# Local owner organization sharing

This additive API leaves OrganizationMemory and its default-deny contract unchanged.
OrganizationRegistry and LocalOrganizationSharing are trusted local owner APIs.
A principal ID is an **owner-asserted label**, never an authenticated person.
Anyone with the owner's local file/process access can assert the owner label. Do not
expose these services, CLI, database, or project memory to agents or remote clients.
This is not multiuser authentication, a network service, or file ACL certification.
Native Windows is deferred; platforms without owner UID checks fail closed.
No identity service, network, model calls, automatic promotion or paid service is used.
Governance/quorum/independent-validation promotion remains disabled.

## Actual owner CLI

Build with npm run build. Invoke node dist/src/local-runtime/organization-cli.js
with a command and all of these required flags (substitute actual canonical paths/IDs):

    --workspace /work/project --state-dir /private/org-state
    --memory-state-dir /private/project-memory
    --org team --principal local-owner --project project-a

The database is /private/org-state/organization-v1/organization.sqlite. One state
directory holds one organization, across explicitly configured projects. A different
organization ID cannot reopen it. State must be canonical and outside each workspace,
OS-user-owned, with directories 0700 and files 0600. Resources bind canonical root
and registered project ID; another root with the same project ID has no access.

Append the flags above to each command:

1. bootstrap fixes the owner label explicitly. Repeating with the same label is
   idempotent; another label cannot bootstrap or become owner.
2. member --member writer --role editor --status active and
   member --member viewer --role reader --status active add asserted labels.
3. Write a private 0600 grants JSON file containing an array such as:
   [{"principalId":"local-owner","read":true,"share":true},
   {"principalId":"writer","read":true,"share":true},
   {"principalId":"viewer","read":true,"share":false}].
   config --enabled true --grants-file /private/grants.json explicitly enables this
   resource. Readers cannot share. Owner must also have explicit resource grants.
4. Use existing project-memory commands to ingest, inspect and validate a record.
   inspect --record-id SHA256 returns the actual validated record and recordBinding
   (hash of its complete content, citations and metadata).
5. Owner reviews that result, then invokes approve --record-id SHA256
   --record-digest SHA256 --binding SHA256. Approval binds originating ProjectMemory
   state directory, root/project, current validated record and full record binding.
   No supplied JSON content is copied. Records must fit the 16KB copy budget.
6. share --approval-id SHA256 as a granted owner/editor performs the controlled copy.
   Repeating a live share is idempotent. OrganizationCandidate JSON grants no rights.
7. read --share-id SHA256 as an active granted reader returns evidence-only content.
   Original local project and private memory store must remain available.
8. revoke --share-id SHA256 as owner permanently tombstones the copy. Suspend/revoke
   membership with member using its reader/editor role and --status suspended or
   revoked. No supplied role can promote a label to owner. status shows owner-visible
   configuration/IDs; promote always denies.

Every command requires explicit workspace/state flags. CLI denials exit 2 with a scoped
receipt. Invalid arguments/files/storage emit a constant sanitized message. Unknown and
duplicate flags are rejected. Grants JSON cannot set membership or owner identity.

## Freshness, persistence and limits

Each operation reads live SQLite state under BEGIN IMMEDIATE, FULL synchronous
rollback-journal transactions and private-file/schema checks. Receipt fields bind
operation, hashed principal, organization/project scope, decision, revision and state
digest. Latest 1000 receipts persist atomically with state; they are local audit
evidence, not independently certified authority. API results contain their receipt.
Denial receipts retain no raw input/content/error. Limits: 128 members/resources/
approvals/copy IDs, 1MB state, 16KB record. Exhaustion fails closed.

Inputs reject getters, proxies, symbols, cycles, exotic objects and excessive
nesting/nodes/bytes without invoking accessors/proxy traps. Async read/share snapshot
input before yielding and check current permissions/source afterwards. Reads verify
reader and originating sharer role, ACL, status and membership epoch, then reopen
actual ProjectMemory and compare the full record binding. Removal, expiry,
supersession or source changes deny access. Observed stale origins tombstone copies.
Membership changes erase that label's copies; reactivation cannot resurrect them.
ACL/config changes invalidate that resource's approvals and copies; identical config
is idempotent. Explicit revoke clears the body and persists across restart.

There is no background watcher. Source changes restored before observation cannot be
detected; bytes already returned cannot be recalled. Same-user filesystem access is
inside the trusted owner boundary; path/inode/schema checks are defense in depth.
SQLite lock timeouts fail closed. No distributed concurrency, remote revocation,
multiuser authentication or native Windows ACL guarantee is claimed.

## Portable verification boundary

The portable test router discovers the organization tests on every platform. Only
registry/sharing storage fixtures and the actual CLI storage lifecycle are skipped
when process.getuid is unavailable, with an explicit UID/POSIX-storage reason.
Every storage case still runs on a supported POSIX host; other storage failures
remain failures. CLI help, duplicate/unknown argument rejection and sanitization,
safe JSON proxy/getter and snapshot checks, and pure authority-state validation
remain portable and run without organization storage.

A separate process actually removes UID identity on a POSIX host (or retains its
absence elsewhere) and asserts that opening organization storage fails closed
before creating the organization database. This is missing-UID contract evidence,
not a native Windows run or Windows ACL certification. Production UID/private-path
checks remain required; there is no unsupported-platform fallback.
