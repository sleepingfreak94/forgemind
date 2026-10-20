# Bounded lossless selected native capture

Native capture stores owner-selected results and check stdout/stderr. It does
not record raw authentication, reasoning, provider RPC or automatic transcripts.
Public success/failure fields and execution, lease and retry behavior are unchanged.
Managed TTY copies retain their fixed 2MiB limit and explicit incompleteness.
This feature adds no native Windows/Linux or Cursor support.

## Storage and recovery

Small payloads retain the original `terminal.json` bytes and layout through the
existing 2MiB artifact limit. Larger selected payloads use `terminal-chunk-000.json`,
consecutive zero-padded names, then `terminal-index.json`. Index version 1 has:

- `schema: native-owner-capture-chunks`, `version: 1`, `encoding: base64`.
- `bytes` and `sha256` for the complete original ordered JSON UTF-8 payload.
- Ordered `chunks` with `name`, decoded `bytes`/`sha256`, and actual JSON file
  `storedBytes`/`storedSha256`.

Each chunk is a JSON base64 string, sized including its quotes to fit 2MiB.
Chunk boundaries may split a UTF-8 character; concatenate decoded bytes before
interpreting UTF-8. `decodeNativeCapture(bundle)` returns the original JSON bytes,
without sorting properties or reserializing the returned payload. First obtain
`bundle` with `readOwnerArtifactBundle(options, id)`; it verifies accepted private
filesystem inventory and manifest references. The decoder additionally checks
version, encoding, ordered unique canonical names, lengths, chunk and whole
hashes, canonical base64, restricted JSON, and absence of mixed/extra chunks.
Missing, duplicate, reordered, altered or inconsistent chunks are rejected.
Legacy `terminal.json` is also supported. Index and manifest hashes provide
structural evidence only: they do not authenticate an author or grant authority.

## Limits and failures

The existing descriptor selector and `encodeOwnerJson` defenses remain in use:
no proxy traps, getters, serialization hooks, non-JSON values or silent trimming.
Actual UTF-8 JSON bytes are counted before chunking. Every actual encoded chunk,
index, descriptor, manifest and progress file remains subject to the existing
artifact writer's limits and conservative reservation for publication/progress.
The 2MiB artifact, 16MiB bundle, file count, progress and archive limits are unchanged.
Base64 expands stored size, so some raw payloads smaller than 16MiB cannot fit.
There is no universal-fit guarantee or increased limit.

Only a complete selected payload can be accepted. Overflow, encoding, writing or
acceptance failure preserves incomplete evidence and independently attempts one
small Markdown resume note. Terminal settlement and resume attempts remain
latched; no native execution settlement, provider retry or lease replay occurs.
Failure during publication can leave a manifest plus the existing publication
veto; a manifest filename alone is never proof of acceptance. Use the accepted
bundle reader/inspection API and preserve failed attempts for reconciliation.

## Scoped verification

The baseline scenario uses `status: completed`, selected stdout of 600,000 `é`
characters and stderr of 400,000 `界` characters: 2,400,090 JSON UTF-8 bytes,
including selected result fields. The baseline single-file writer rejected it.
The focused codec and capture tests repeat this scenario through actual writer,
accepted bundle and decoder, checking exact original bytes. Additional coverage
includes escaping/multibyte boundaries, exact small-artifact compatibility,
actual encoded aggregate overflow, reserved overhead, injected write/publication
failures, semantic tampering and one-shot terminal/Markdown behavior.

Build, typecheck and focused checks are run through the owner wrapper; receipts
and exact source identities are reported in the private worker handoff. This
page does not claim full-suite, provider inference or independent review success.
