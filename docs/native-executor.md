# Native executor offline foundation

This adapter exercises the native AppServer reasoning/tool loop with an actual
local Node fixture process. It is not a qualified production executor. The old
LiveTask, provider broker, native driver and OfflineSeatbeltHost remain unchanged.
`nativeReadiness(..., 'live', ...)` always fails closed: no production host exists
in this change, and approval alone cannot make it launch ready.

## Implemented contract

`NativeTask` binds project, task, immutable source, exact read/write paths,
predefined checks, model/effort and cumulative budget. `NativeState` stores that
binding with schema, thread, completed stage, callback identities, pending actions
and counters in an owner-private SQLite directory outside the worker checkout.
The workspace must be a canonical real directory, validated before state creation.
Persisted updates use synchronous SQLite durability and compare-and-swap updates;
a stale second handle cannot overwrite counters or claims. A restarted executor
must present the same binding/current source and obtain a fresh owner authority
and boundary. Pending actions, interrupted running state and indeterminate cleanup
require explicit owner reconciliation; none can automatically replay a write.

The fixture uses pinned 0.162.1 AppServer schema shapes: experimental initialize,
thread/start with persistent history and function dynamic tools, thread/resume,
turn/start, nullable callback namespace, before-ack thread/turn notifications, and
turn/interrupt. Thread results must echo Sol model/provider/effort, standard service
tier, read-only/no-network sandbox configuration and pinned CLI version. These
configuration echoes are protocol checks, not proof of filesystem isolation.

Only host_read, host_apply and host_check are supported. Host reads use exact
paths, safe-path validation, current source and action receipts. Apply reuses
`applyEdits`, including preimage digest checks and RunAuthority-compatible action
receipts. Checks resolve an exact predefined ID and record a command receipt.
The fixture check callback is synthetic; it does not certify a production command
sandbox. A production callback must reuse `runChecks` or an equally qualified
supervisor. Unknown tools, native approval requests, builtin operation items,
malformed/replayed callbacks and exhausted budgets stop the session.

## Budget semantics

Enforced cumulatively across resumed processes:

- Active runtime in milliseconds, host-started turns, host tool callbacks.
- UTF-8 host turn input and callback arguments; serialized host result bytes.
- Both directions of raw AppServer JSONL stdio, counted before transport acceptance.
- Accepted agent output bytes, conservatively including repeated delta/final text.
- Exact file and predefined check grants.

Runtime uses monotonic elapsed time, prepaid minimum slices and a watchdog.
Interrupted running state cannot resume, so a crash cannot reset active usage.
Completion notifications latch one terminal frame without immediately marking
state ready. Settlement rechecks already dispatched fatal/duplicate/conflicting
traffic, cancellation, current authority, runtime and pending callbacks before
committing ready. This boundary covers the current receive batch and drained
preack notifications; it does not wait for EOF or claim absence of future faults.
A later observed disconnect/fault stops the persistent session and invalidates its
checkpoint. Stop requests attempt a bounded turn/interrupt, then mandatory supervisor stop.
Unavailable or failed cleanup remains indeterminate. Token usage notifications are
observations only. **Hard upstream provider request count, full native prompt bytes,
and raw upstream provider response bytes are unavailable.** These limits do not
replicate the old broker's request/prompt/raw-provider limits.

The sole constructible host is `FixtureNativeHost`, clearly marked offline.
Serialized task configuration cannot create a live-qualified host. Its raw stdio
meter reuses `JsonlRpc` with bounded lines, aggregate transport size and timeouts.
Fixtures are trusted test seams, not security boundaries or credentials providers.

## Validation

Build/typecheck and `node --test dist/tests/live-workflow/native-executor.test.js`
exercise actual fixture processes, digest-bound read/apply/check, before-ack
notifications, process restart with thread/resume and fresh receipts, cumulative
budgets, exact paths, stale digests, callback denials, concurrent stale state,
cancellation, revocation, expiry, disconnect and failed cleanup. No authenticated
inference, native account login, production sandbox or live model was tested.

## Proposed canary activation contract — not accepted or executed

A future independently reviewed production host must enforce filesystem/network
and executable boundaries independently of native configuration, supervise the
native process and descendants, bind source/fencing authority and current auth,
provide owner-private persistent CODEX_HOME/state, meter raw stdio, and demonstrate
restart/cancel/expiry/revocation cleanup. Existing OfflineSeatbeltHost cannot supply
these guarantees unchanged. Direct authenticated provider network access and
native account authentication require separately approved production implementation;
ambient credentials must not be copied into worker files or fixture processes.
Model catalog presence does not prove personal ChatGPT plan access or entitlement.

After that implementation and independent qualification, request explicit owner
acceptance of this distinct native budget contract for one disposable canary:

| Setting | Proposed value |
| --- | --- |
| Model/access | gpt-6.1-sol, medium effort, default service tier, personal ChatGPT access |
| Runtime / host turns / host callbacks | 900,000 ms / 3 / 30 |
| Host input / result bytes | 32,768 / 262,144 |
| Raw AppServer wire / accepted output bytes | 33,554,432 / 2,097,152 |
| Exact read paths | src/canary-counter.js, tests/canary-counter.test.mjs |
| Exact write path | src/canary-counter.js |
| Predefined check | check-canary: owner-pinned Node executable, --test --test-isolation=none tests/canary-counter.test.mjs, 30,000 ms |

The disposable project/check inputs must be prepared and source-bound by the
owner before the pilot. The scenario is a counter increment bug with a fixed
failing assertion, repaired via host_apply and verified by the fixed check. This
proposal authorizes nothing: production host implementation, independent review,
current action/auth fences and explicit acceptance remain required. The unavailable
upstream metrics above must appear in the eventual pilot request and receipt.
