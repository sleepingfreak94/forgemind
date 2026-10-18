# Owner account execution leases

Native runs register one opaque execution lease in the selected account's private
`chatgpt-execution.sqlite`. This is a separate admission transaction boundary;
registering another worker does not create the credential writer lock and does not
invalidate healthy readers. The lease binds the exact credential generation digest,
account/host/review, immutable parent run binding and original deadline. The ledger
contains no access, refresh or ID tokens. Credential generation comparison remains
exact: reconnect, token change, account/host/scope drift and review reset invalidate
existing sessions. There is no same-account token adoption during a native turn.

Before a refresh acquires any credential lock or creates a pending marker, it
atomically requires no active, revoked or indeterminate execution lease and records
a durable refresh intent. Admissions are blocked until that intent settles. Active
workers cause the typed `chatgpt-refresh-deferred` outcome, with zero refresh POSTs;
the owner can retry after workers settle. The implementation does not wait or retry
a provider operation automatically. A lost response retains the existing pending
marker and refresh intent, preventing token replay and new admission.

`runNativeTask` owns the lease through launch, inference, reaping, final
source/account/runtime checks and durable outcome settlement. The existing outer
`withNativeAccess` callback is a non-owning token scan; returning a live host does
not release execution ownership. A factory requires a recognized execution handle
before launch, even though its argument remains optional for legacy rejection-only
fixture source compatibility. No arbitrary task object can qualify a handle.

Release requires genuine runtime-bound cleanup evidence issued by the supervised
transport after confirmed process-group reaping. A failure before any process is
created can issue proven prelaunch evidence. Cancellation, revoked credentials or
a failed task do not prevent release after proven cleanup; they do prevent claiming
successful task completion. Evidence cannot be forged or replayed across releases.
Durable lease outcome appears in the terminal run receipt.

Owner/process crashes, expired deadlines and uncertain cleanup leave blocking
leases. PID disappearance and elapsed time do not authorize stealing a lease.
`reconcileChatGPTExecution` is an explicit owner API requiring genuine containment
evidence for the recorded runtime and a current owner check. There is no automatic
post-crash evidence-acquisition mechanism: if the original trusted supervisor's
proof is unavailable, the lease remains blocked pending a separately qualified
containment/recovery procedure. Do not erase ledger rows to bypass this gate.

Drain all legacy unleased native/provider runs before enabling concurrent runs with
this adapter. Prepare sufficient lifetime before admitting a concurrent wave;
credential rotation alone is serialized. Different isolated worker worktrees,
project claims, exact permissions and budgets are still required. These leases are
account execution coordination, not billing attestation or new execution authority.

Offline evidence uses synthetic accounts only: separate subprocess admissions,
refresh deferral and single rotation, intent/admission exclusion, cancellation,
expiry/reconnect/review reset, crash and uncertain cleanup, forged/replayed proof,
ledger replacement, and actual pinned native initialize/stop without inference.
Baseline plan/concurrent-reader tests passed 32/32; baseline behavior explicitly
invalidated an old session after external same-account credential change. Existing
refresh/plan/concurrent-reader/run/process tests passed 92/92 during implementation.
An initial synthetic fixture failed because its ID token lacked the required three
segments; a subsequent worker fixture kept stdin open after settlement. Both fixture
errors were corrected; the lease/process focused checks subsequently passed 12/12.
These checks do not prove live entitlement or production account rotation behavior.

Explicit verified reconnect supersedes its exact captured refresh-intent ID and old
generation independently of the currently saved credential digest or absence.
Capture under both owned locks binds current connection, retained registration and
host, stable pending file identity/content, and intent/absence. Pending and intent
must agree with each other when both exist. Fresh signed OAuth must retain the
account. Before saving, every capture is rechecked; after saving, checks switch to
the exact fresh files. Only the captured pending marker and intent are conditionally
removed. Unexpected disappearance, replacement or creation fails closed.

Credential save and metadata removal are separate durable operations. A failure
can leave fresh credentials with old pending/intent or intent only; another explicit
verified reconnect recovers these states without replaying an old refresh token.
Absent credentials require retained identity when recovery metadata exists.
Execution leases are retained (possibly revoked), never cleared by reconnect; their
containment-proof gate remains. A late abandoned response cannot overwrite fresh
credentials. Synthetic regressions cover post-save failure, partial invalidation,
intent-only recovery, pending/intent and identity tampering, and unresolved leases.
