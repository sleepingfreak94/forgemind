# ForgeMind Skill System

Status: Draft for architecture review  
Last updated: 2026-08-23

## Design intent

A skill is a reusable capability package that teaches an agent how to perform a bounded class of engineering work. ForgeMind adopts the portable directory model from the [Agent Skills specification](https://agentskills.io/specification) and adds the trust, versioning, resolution, evaluation, and lifecycle controls required for team use.

A skill declaration requests capabilities; it never grants them.

## Package model

```text
webrtc-debugging/
├── SKILL.md              metadata and activation instructions
├── references/           domain knowledge and diagnostic references
├── scripts/              optional deterministic helpers
├── examples/             representative cases and expected evidence
├── tests/                trigger, workflow, safety, and compatibility tests
├── assets/               optional templates and fixtures
└── forgemind.lock         resolved dependencies and content digests
```

The logical contents are:

| Part | Purpose |
| --- | --- |
| Metadata | Name, description, publisher, version, license, compatibility, provenance, trust, dependencies |
| Instructions | When to use the skill, workflow, boundaries, stopping conditions, expected result |
| Tools | Required capability names and minimum access; non-authoritative |
| Examples | Positive, negative, edge, and failure-path examples |
| Knowledge | Focused source-bound reference material, not a hidden unrestricted corpus |
| Tests | Activation precision, result quality, deterministic helpers, safety, regression, compatibility |

## Skill Registry

The registry is the catalog and lifecycle authority for skill packages. It stores metadata, immutable package digests, publisher identity, signatures/attestations, source commit, license, SBOM, validation receipts, supported agents, and state.

Registry states are `draft → quarantined → verified → deprecated → revoked`. A version may also be rejected. Registry namespaces prevent dependency confusion: identities are fully qualified by registry, publisher, and name.

The registry supports four sources:

- **Public repositories:** imported from a pinned repository commit and reviewed under local policy.
- **Skill registries:** resolved from a trusted public or private registry with signed metadata.
- **Internal company skills:** organization-owned packages with internal review and distribution policy.
- **Generated learned skills:** draft packages produced from repeated validated lessons; always quarantined before tests and review.

The public MCP Registry is not a private skill trust authority, and Skills-over-MCP remains an adapter target rather than the canonical store while the standard matures.

## Skill Resolver

The resolver turns a capability query into an immutable `ResolvedSkillSet`:

1. Match task intent and required capabilities against metadata.
2. Filter by tenant, project, license, publisher, trust state, runtime, platform, agent/model compatibility, and policy.
3. Solve semantic-version constraints and transitive dependencies.
4. Reject revoked, incompatible, conflicting, or unapproved capabilities.
5. Rank by task fit, validation quality, source authority, recency, and context cost.
6. Produce a lock containing exact versions and content digests.
7. Record alternatives and the resolution reason.

Resolution never executes a skill and never selects a mutable `latest` for a production task without locking the digest.

## Skill Loader

Loading uses progressive disclosure:

1. **Discovery:** load only name, description, compatibility, trust, and estimated context cost.
2. **Activation:** load `SKILL.md` instructions for the resolved version.
3. **Execution need:** load only referenced examples, knowledge, scripts, or assets justified by the active step.

The loader verifies the digest and signature, rejects path traversal and links outside the package, scans executable resources, enforces size budgets, and labels all loaded content with origin/trust. References fetched from mutable external URLs are not reproducible and must be vendored or content-pinned for verified releases.

## Skill Versioning

ForgeMind uses semantic versioning for the skill's public behavior:

- Major: incompatible instructions, outputs, capability requirements, or package contracts.
- Minor: backward-compatible workflows, knowledge, examples, or optional capabilities.
- Patch: corrections that do not change expected interface or authority.

Each published version is immutable and content-addressed. Deprecation recommends a successor; revocation prevents new resolution and warns on historical replay. Task packets record both semantic version and digest.

Compatibility is evidence-based, not merely declared. The registry records tested agent driver/version, model family when relevant, operating environment, dependency versions, and evaluation receipt.

## Example: `webrtc-debugging`

### Purpose

Diagnose WebRTC negotiation, connectivity, media, and quality failures with a repeatable evidence-first workflow.

### Domain knowledge

- SDP offer/answer and signaling state.
- ICE candidates, STUN/TURN, NAT, and connectivity checks.
- DTLS/SRTP and certificate negotiation.
- Codecs, media tracks, transceivers, and browser interoperability.
- `getStats` interpretation, packet loss, jitter, RTT, bitrate, and frame behavior.

### Workflow

1. Classify signaling, connection, media, or quality failure.
2. Capture browser/platform versions and a synchronized event timeline.
3. Inspect signaling states and SDP differences without exposing credentials.
4. Inspect ICE candidate pairs and TURN behavior.
5. Inspect DTLS/media state and time-series stats.
6. Form one falsifiable hypothesis at a time.
7. Run the smallest controlled experiment and record outcome.
8. Report root cause, confidence, fix, regression test, and unresolved variance.

### Tools

The skill may request read access to logs, browser diagnostics, packet captures with redaction, test environments, and deterministic parsers. Live call interception, production changes, network capture, or external access require separate explicit grants.

### Examples and tests

- Positive trigger: “ICE reaches checking but never connected behind corporate NAT.”
- Negative trigger: generic HTTP timeout with no real-time media context.
- Workflow test: identify TURN credential expiry from sanitized evidence.
- Safety test: redact SDP credentials, IP addresses under policy, tokens, and personal identifiers.
- Regression test: do not recommend disabling certificate or browser security controls.
- Compatibility test: produce the same structured diagnostic result for each supported Agent Driver.

## Trust and supply-chain security

- Project skills are untrusted until the workspace is trusted and the package is reviewed.
- Publisher identity, signature, digest, source, dependencies, and test receipts are verified before activation.
- Deterministic helpers run in a deny-by-default sandbox with narrow filesystem/network access.
- Hidden files, binaries, install hooks, dynamic downloads, credential access, and instruction injection receive elevated review.
- Skill metadata and MCP tool annotations are claims, not enforcement.
- Imported and learned skills cannot write shared memory or self-publish.
- Revocation and rollback must work after installation.

## Skill evaluation

The minimum suite measures trigger precision/recall, task success, result schema validity, context cost, unsupported-tool behavior, negative cases, prompt-injection resistance, secret handling, and cross-agent compatibility. A verified skill must have source-bound tests and an authorized review receipt.

## Open questions

- Which ForgeMind extensions belong in `SKILL.md` metadata versus a separate manifest?
- Which signature and transparency-log standards should the registry adopt?
- How are licenses and source redistribution handled for bundled knowledge?
- What evidence threshold converts repeated lessons into a generated draft skill?
