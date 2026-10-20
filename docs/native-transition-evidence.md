# Native source-transition receipt evidence

NativeOwner now exports optional `transitionEvidence` with schema
`native-transition-bindings-v1` and ordered `bindings`. Each binding contains
`transitionReceiptId`, `taskBinding`, the actual `envelope`, `decisionId`,
`terminalId`, producer `decisionDigest`/`terminalDigest` pins, and `digest`. Existing source, phase and receipt fields are unchanged.

The producer snapshots the actual NativeProject transition envelope (artifact kind,
initial source, operation, transition UUID, before/after sources and edit pre/post
hashes). It persists the allowing decision ID returned by reserveExternal and the
terminal ID returned by that same reservation. Only a completed action whose output
digest is the resulting source can support a source phase. Caller-supplied phase
JSON alone cannot advance the owner. Failed, unfinished, recovered or uncertain
actions have no completed association. The SQLite association survives restart;
phase/source advancement remains atomic in the owner ledger. No pending effect is
automatically replayed or reconciled. A second transition attempt for the same before-source requires owner reconciliation. NativeState/cleanup gates remain separate.

The qualifier validates bounded exact shapes, granted unique edit paths, UUIDs,
source continuity, ordered one-to-one phase/binding pairs, unique ordered policy
decision/terminal pairs, and matching task/principal/session/policy/grant/invocation/
request/resource/action/source identities. A related duplicate or recovered external
receipt invalidates the pair. The terminal must be completed, follow the allowing
decision, and bind the exact canonical envelope view and resulting source digest.
The request digest is recomputed using PolicyRuntime's insertion-ordered normalized
context/intent serialization. The resource suffix and view digest hash the canonical
envelope. Each binding digest hashes its canonical fields excluding digest itself.
Full canonical receipt digests are persisted by the producer and compared to the selected rows; rehashing only an outer/additive digest cannot substitute both rows.
The task binding hashes the canonical original task with source replaced by null,
so a resumed task can advance source while preserving all other task identities.

Genuine edited exports can establish sourceBound. Missing checks, review, cleanup,
checkpoint certainty, and all other completion gates still prevent completion.
Historical edited archives without this field remain partial even with matching
UUIDs and output/source hashes. Migrated ledgers with unbound historical phases
keep the legacy export shape; an unchanged archive with empty phases behaves as
before. New malformed or contradictory association evidence is rejected.

This is historical evidence consistency with authority none. Hashes are not
signatures: internally consistent wholesale fabricated history is not authenticated.
No author, model, importer or archive receives executable, release or promotion
authority. Full archive-codec/capture expansion and native enforcement changes are
outside this change.

Focused regression: native-transition-evidence.test.ts uses a real guarded
NativeProject edit fixture through applyEdits, export and qualification, two source
advances and restarts, legacy omission, producer-phase denials and recomputed-hash
substitution attacks. No provider, account or native inference is used.

A guarded application that leaves the exact full source inventory unchanged is an idempotent write, not a source transition. Its existing completed file-application receipt remains; `commitAppliedSource` returns the unchanged source and `transitionReceiptId: null`, consumes the verified preimage, and emits no phase or transition binding. Restarted workflows may repeat such a write and later make a real bound edit. Strict transition validation continues to reject same-source transition claims.

Returning to a previous exact source state does not make its already phased transition pending again. The owner blocks a new producer only when a transition from the current source lacks its corresponding persisted phase. Completed-but-unphased actions remain reconciliation barriers, including across owner restart.
