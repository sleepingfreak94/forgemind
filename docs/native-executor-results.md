# Native final-text evidence

`NativeExecutor.receipt.finalResult` is `NativeFinalResult | null`. An accepted
turn exposes this readonly, deeply frozen in-memory value:

```ts
{
  schema: 'native-final-text-v1',
  trust: 'evidence-only',
  source: string,
  turnId: string,
  messages: readonly { readonly id: string; readonly text: string }[],
  digest: string
}
```

Text is untrusted model-authored evidence. A model's claim that a review passed,
that permissions changed, or that an operation was authorized grants no authority.
Consumers must independently interpret the text and enforce their own verdict,
policy, rendering and action boundaries. Model-supplied strings remain verbatim;
the evidence wrapper does not authenticate their claims or sanitize their content.

## Provenance and acceptance

Only completed `agentMessage` items for the host-started current turn contribute
text. The collector reconciles `item/completed` with `turn/completed.items`, so an
empty terminal items array retains earlier completed messages. Terminal-only
messages are supported too. Items with phase `final_answer` are included;
`commentary` is excluded. Omitted or null optional phase means an unphased message
and is supported for AppServer compatibility. Other phase values fail closed.
`item/started` text and agent-message deltas never become final evidence. Reasoning,
user messages, tool arguments/results and provider diagnostic text are excluded.

IDs must be nonempty strings and agent text must be a string, including an empty
string. Missing or malformed IDs/text reject the turn with host-authored errors
that do not echo remote values. Identical completed IDs and text deduplicate;
absent phase and `final_answer` are equivalent. Conflicting text, conflicting
commentary/final phase or a completed ID reused for another item type reject the
turn. Other completed item identities are retained only as collision metadata;
commentary text is represented only by a fingerprint, never by retained text.

The result appears only after the existing terminal, current receive-batch,
preack queue, cancellation, authority, runtime, callback and pending-effect checks
succeed and the ready checkpoint is saved. Same-batch late errors, conflicting or
duplicate terminal frames, denied callbacks and observed transport closure suppress
success even if the completion listener already resolved. No pending, partial,
failed, interrupted or cancelled turn publishes a result. An accepted turn with no
eligible final messages has a result with `messages: []`.

A new turn attempt clears the current result and collector before input/turn/runtime
budget charges, including attempts that fail those charges. Resumed thread history
is never fed to the collector; historical effects remain denied by the existing
turn/thread validation. Source binding uses `NativeState.source` at acceptance,
including its advancement through a settled `host_apply`.

Genuine later faults clear the executor's current evidence. Already captured
immutable snapshots remain stable. Deliberate close also clears current evidence;
callers capture the accepted receipt before close. The existing `runNativeTask`
and offline runner already do this, and the production result carries the snapshot
under `native.finalResult` without changes to the runner. Existing verification,
cleanup and return-boundary checks still govern whether the runner returns success.
Turn acceptance covers observed traffic and does not promise absence of future
faults in a persistent session.

## Storage, budgets and digest

Final evidence is in memory only. It is not added to `NativeCheckpoint`, persisted
conversation state or a full transcript. Collector maps clear on reset, stop and
after snapshot publication. Retention is bounded by the already enforced accepted
output and bidirectional wire budgets; there is no separate text allowance.

Existing charging remains unchanged: started/completed agent-message text and
agent deltas are charged wherever they were previously charged. Repeated completed
text, including terminal copies, still charges output every time even when the
retained evidence deduplicates. Copying/freezing/hashing evidence adds no extra
output/result/wire charge. `NATIVE_MAX_WIRE_BYTES = 33554432` is shared by budget
validation and launch preparation. Exactly 32 MiB is permitted; larger task wire
budgets, including 64 MiB, fail at task preflight before account preparation or
execution admission. Minimum/integer checks and other budgets are unchanged.
The runtime still performs zero automatic retries. These bounds do not establish
a provider billing cap or hard provider-request count.

The digest is lowercase hexadecimal SHA-256 of UTF-8 bytes of JavaScript
`JSON.stringify` of the following object, with exactly this insertion order and
no whitespace or trailing newline:

```ts
{ schema, trust, source, turnId, messages }
```

`schema` is `native-final-text-v1`, `trust` is `evidence-only`, and each message
object inserts `id` then `text`. Messages are ordered by their first completed-item
observation (including terminal-array order), with identical IDs deduplicated.
No normalization of strings or sorting occurs. The `digest` field is excluded
from its own input; all other result fields participate. Reconstruct this exact
object to verify a digest rather than relying on arbitrary caller property order.

## Validation scope

`tests/live-workflow/native-executor-result.test.ts` uses real `NativeExecutor`,
`NativeState`, `FixtureNativeHost` and metered `fixtureStdioRpc` with in-process
PassThrough streams and JSONL responses. Its temporary filesystem and typed fake
owner/source authority exercise accepted receipt delivery, actual host callback
source advancement, both completion forms, duplicate metering, malformed/conflicting
items, excluded content, failed/cancelled/budget outcomes, settlement faults,
immutable snapshots, next-turn reset, resume history exclusion and wire preflight.
It starts no subprocesses or sockets and imports no other test suites. It does not
qualify live inference, macOS enforcement or production source-ledger behavior.

Subsequent immutable packets executed all 13 focused tests and 24 existing host
regressions; strict types, build and independent module review passed. A separate
real read-only probe confirmed bounded final-text delivery. These are scoped
module observations, not production or cross-platform certification. See
[backlog status](./backlog-status.md) for the observed checks and remaining limits;
combined-source regression and aggregate review are recorded in the PR handoff.
