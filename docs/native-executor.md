# Native executor production route

The native adapter keeps the old LiveTask/provider broker unchanged. Native owns
reasoning and tool sequencing; ForgeMind owns authentication, permissions, source
transitions, supervised execution, checkpoints and receipts. The production route
uses the existing reviewed ForgeMind ChatGPT account through the documented Codex
AppServer token-sharing provider, not ambient native login or an API-key fallback.
No token is copied into project files, native history/configuration, argv or logs.

## Owner invocation

After independent qualification, the owner can invoke:

```sh
node dist/src/local-runtime/native-cli.js \
  --packet /private/native-owner-packet.json \
  --connection /private/forgemind-account \
  --codex /absolute/pinned-codex \
  --state /private/native-task-state
```

The packet has schema `native-owner-packet-v1`, a `task` matching NativeTask and an
`objective`. The immutable packet digest binds objective, budget and permissions; only the
observed source is excluded so verified checkpoint source transitions can resume.
The packet must be owner-private, outside the worker checkout, and unchanged
during each active invocation. A
changed packet, source drift, cancellation, expired account/lease/fence or changed
runtime pin denies further work. Source and owner state must be separate canonical
paths. Only host_read, host_apply and predefined host_check are available. A task
cannot select executable plugins or broaden its path/check permissions.

NativeTask v2 supports explicit `turns:null` and `toolCalls:null`: these counters
remain numeric and cumulative but impose no fixed quota. Runtime, UTF-8 host
input/result bytes, bidirectional raw AppServer wire and accepted output remain
bounded. Retries are persisted with an allowance of zero through two; the current
runner performs **zero automatic retries**. Neither an unknown native effect nor a
pending source transition can replay. Token usage is observed. Hard upstream
provider request count, full native prompt bytes and raw provider response bytes
are unavailable, and no equivalent bound is claimed.

The private native runtime sees no project files. TLS uses the binary-pinned
embedded roots plus the fixed `/private/etc/ssl/cert.pem` CA bundle. The latter is
required to be canonical, root-owned, bounded, nonempty and parseable PEM; its
exact file identity/bytes join the launch dependency pins and runtime digest.
Only fixed SSL_CERT_FILE is added to the child's allowlisted environment; no
ambient SSL_CERT_DIR or CODEX_CA_CERTIFICATE is inherited. Invalid bundles fail
before launch, without granting SecurityServer or expanding network destinations.
Native plugins and unbounded connection retries are explicitly disabled alongside
zero request/stream retries. These are protocol configuration inputs, with the
existing independent OS boundary and receipts still enforcing authority. Its private working directory
and immutable native-runtime-v1 receipt bind the CLI/config/profile pins, fixed
provider, model/effort, account/review, parent grant digest, exact permission digest,
budget digest, lease, fencing epoch and deadline. Host file/check actions use the
separate current project-source authority. The process can stay alive through an
authorized source edit because runtime identity is not project inventory.

## Source transitions and durable recovery

Host application captures S0 inventory, reuses validated digest-bound applyEdits,
derives the expected complete S1 inventory solely from the validated proposal and
rejects unrelated changes. It then durably records the S0-to-S1 owner phase before
updating NativeState.source. The write remains pending until both ledgers and the
bounded result are settled. A failed partial transition or interrupted running
checkpoint requires owner reconciliation and never automatically replays a write.
Old S0 reservations are denied after the verified transition; S1 checks use fresh
source-bound authority. Lifecycle reservation stays bound to immutable runtime.

Completion latches one terminal frame. Ready is committed only after checking
already dispatched fatal/duplicate/conflicting traffic, cancellation, authority,
runtime and pending callbacks. This acceptance boundary covers the current receive
batch and drained preack notifications; it does not await EOF or assert that future
faults cannot occur. Later faults stop the persistent session. Shutdown attempts a
bounded turn/interrupt followed by mandatory supervisor reaping. Uncertain cleanup
is indeterminate.

Authentication is prepared/refreshed by the owner before launch. The existing
same-account credits-off acknowledgement is reused. A missing/reset review remains
an owner interaction; it is never synthesized. Token renewal invalidates an active
native token lease: stop/reap, then restart and thread/resume only between completed
turns. Tokens/history are separate from ForgeMind's private refresh credential
store. No worker receives refresh credentials or account network authority.

## Canary packet, not an inference observation

Use a disposable Git checkout containing `src/canary-counter.js` and
`tests/canary-counter.test.mjs`, whose fixed direct-import check exposes an increment
bug. Exact reads are those two files; the only write is the counter source. The
fixed check is the owner-pinned Node executable with
`--test --test-isolation=none tests/canary-counter.test.mjs`, timeout 30,000 ms.
Model is gpt-6.1-sol, medium effort, default service tier. Runtime is 900,000 ms;
turns/toolCalls are null; retries are zero; host input/result limits are
262,144/1,048,576 bytes; wire/output limits are 33,554,432/2,097,152 bytes.

The existing user authorization covers implementing and qualifying this route.
Actual provider inference remains gated on frozen reviewed production code and
current account authority. Offline fixtures and native initialize/deny probes do
not prove live entitlement, billing settings, successful inference or completion
of the later project-memory/weekly-summary feature work.
