# Context optimization implementation

The context boundary is implemented in `src/context-engine`. Pass-through is the default and makes no network requests. Headroom is an explicit optional backend; it is not installed or enabled by these changes. See [ADR-0008](./adr/ADR-0008-optional-context-optimization.md).

## Try the default

```bash
npm run demo:context
npm run typecheck
npm test
```

The demo uses synthetic evidence and a fixture authority. It proves that the default preserves protected sections and evidence, recovers the original, and makes zero Headroom/provider requests. Tests that use a fake proxy require permission to bind temporary loopback ports.

## Host integration

```typescript
import { PassThroughContextOptimizer, PacketContextOptimizer } from '../context-engine/optimizer.js';
import { MemoryOriginalStore } from '../context-engine/originals.js';
import { HeadroomCompressor } from '../context-engine/headroom.js';

// authority and executor are trusted host implementations, never agent input.
const originals = new MemoryOriginalStore({ ttlMs: 60_000, maxBytes: 4 * 1024 * 1024 });
const defaultOptimizer = new PassThroughContextOptimizer({ authority, originals });

// Explicit opt-in only after a real host executor and proxy have been verified.
const compressor = new HeadroomCompressor({
  endpoint: 'http://127.0.0.1:8787/v1/compress',
  model: driverModelId,
  timeoutMs: 5_000,
  maxResponseBytes: 1024 * 1024,
  executor,
});
const optionalOptimizer = new PacketContextOptimizer({ authority, originals, compressor });
```

This is a wiring sketch: `authority`, `executor` and `driverModelId` must come from the host. No allow-all implementation is provided. All inputs must be plain JSON data; content hashes are SHA-256 of the exact UTF-8 evidence content. Inputs are cloned, validated and frozen before awaiting a host decision. Outputs are immutable views with canonical packet and view digests.

The evidence authority checks the full scope, evidence ID, content digest, source URI/version and compression eligibility against host-owned records. It rechecks at reading, compression, final packing and recovery. The network executor must enforce exact endpoint/body intent and durable reservation/receipt semantics, validate live grants and source identity immediately before execution and after awaiting it, and honor the abort signal. Supplying the existing fake action receipt is insufficient. The driver must also authorize sending the final view to its provider; this component does not grant provider access.

## Preservation, budgets and fallback

The optimizer preserves objective, acceptance criteria, policy, permissions and checkpoint, plus all eight scope fields and source provenance. Only eligible evidence content may change. Original and transformed digests distinguish the source from the agent view; transformed text remains untrusted evidence.

`maxBytes` is a hard limit on the canonical serialized view, including provenance/reference overhead. Protected content and metadata must fit before any proxy request. No section is silently truncated. If `maxTokens` is supplied, the host must provide a synchronous `TokenCounter` matching the driver's representation; it cannot be inferred from bytes. Driver-specific prompt framing may require an additional budget check.

The Headroom request contains only a model identifier and one tool message with the eligible evidence text. The bridge reads no ambient credentials, changes no model settings and forwards no provider requests. It permits exact HTTP/HTTPS loopback URLs with `/v1/compress`, without DNS, URL credentials, query parameters or redirects. Response bytes and the entire HTTP exchange are bounded. There are no retries.

Transport failures, malformed/incompatible responses and HTTP timeouts produce an explicit original-evidence fallback when the whole packet fits. Denial, unknown host executor errors, caller cancellation and expired packets fail closed, including when denial occurs after a timeout. The bridge rejects extra messages, instruction roles, changed tool IDs, extra message fields, growing content and nonempty CCR hashes. Size reduction alone cannot establish semantic accuracy; real task evaluations are still required.

## Original lifetime and deletion

`MemoryOriginalStore` requires explicit TTL and byte capacity. Entries are isolated by tenant, principal, project, task, invocation, session, policy version and source snapshot, and expire no later than the packet. Capacity evicts older insertions. Every reference is checked before returning a view, but a later packet or time passage can evict/expire it. Recovery performs live authorization and checks deletion/expiry again after the awaited decision.

The host should use `deleteScope`, `deleteReference` or `clear` on cleanup/revocation as appropriate. An absent or expired original yields `original-unavailable`; there is no persistent recovery, upstream CCR dependency or cross-session cache. Application-wide retention defaults remain a separate decision.

## Validation and next integration

Local fixtures exercise exact preservation, provenance relabeling rejection, accessor rejection, mutation during awaits, scope isolation, revocation, cancellation, deletion, budget failure, malformed proxy responses, redirect blocking and body timeouts. They do not establish conformance with a deployed Headroom version or a real agent/model.

Next connect the Codex Driver with pass-through and real policy/sandbox enforcement. Record the raw source-bound baseline, then evaluate an explicitly versioned Headroom service for retained identifiers/citations, error diagnosis, task completion, bytes/tokens, latency and authorized original expansion. Graphify remains a later analyzer candidate.
