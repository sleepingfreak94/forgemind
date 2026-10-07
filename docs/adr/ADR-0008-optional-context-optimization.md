# ADR-0008: Optional context optimization

Status: Accepted for the initial implementation boundary  
Date: 2026-10-07

## Decision

Add a TypeScript `ContextOptimizer` boundary between the canonical task packet and the Agent Driver. Use `PassThroughContextOptimizer` by default. Preserve objective, acceptance criteria, policy, permissions, checkpoint, scope, source references and original digests exactly. Only explicitly eligible, freshly authorized evidence may be compressed.

Implement an opt-in `HeadroomCompressor` for the compression-only `POST /v1/compress` protocol. Send one evidence item per request; never send protected sections or credentials to a model through this component. Accept one compatible tool message, reject redirects and CCR retrieval markers, and retain ForgeMind-owned scoped originals. The initial endpoint restriction is an exact literal loopback URL.

Require trusted host `EvidenceAuthority` and `NetworkExecutor` ports. Test receipts and the existing fake policy executor do not authorize real network access. The production executor must reserve the exact endpoint/body action, enforce the sandbox, persist receipts, and recheck grant/source/session liveness before and after awaited operations. No permissive production executor is supplied.

Compression availability failures may return the original evidence only if the complete view still fits its budget. Denial, cancellation, expiry, unknown executor failures and missing originals block the operation. Token budgets require an explicit driver-compatible counter; byte counts are not token estimates.

## Scope and rollout

The boundary, pass-through implementation, bounded in-memory original store, HTTP bridge, synthetic demo and local proxy conformance tests are implemented. No Headroom service is installed or activated, no provider account is changed, and no real-model accuracy or savings claim is made.

First wire the raw pass-through path to the Codex Driver and its real policy enforcement. Then pin and test a real Headroom deployment, compare task outcomes against that exact raw baseline, and opt in only when evidence supports it. Cursor compatibility must be evaluated separately. Graphify remains deferred to the code-intelligence milestone.

## Consequences

Original recovery is reauthorized and available only while an entry remains in the configured process-local TTL/capacity store. Restart, eviction, expiry or explicit deletion can make it unavailable; this is not durable memory or a lossless lifetime guarantee. Store TTL/capacity are explicit host choices, not defaults for application-wide retention.

Headroom remains a replaceable optimization backend. Its memory, learning, model routing, prompt rewriting and provider forwarding are outside this slice. A smaller response does not prove that task-critical facts survived compression.

## References

- [Implementation and host wiring](../context-optimization.md)
- [Headroom repository](https://github.com/headroomlabs-ai/headroom)
- [Headroom API reference](https://docs.headroomlabs.ai/docs/api-reference)
- [Headroom CCR documentation](https://docs.headroomlabs.ai/docs/ccr)
- [Headroom limitations](https://docs.headroomlabs.ai/docs/limitations)
