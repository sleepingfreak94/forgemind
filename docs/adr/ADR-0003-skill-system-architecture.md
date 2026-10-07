# ADR-0003: Skill System Architecture

- Status: Accepted
- Date: 2026-08-23
- Deciders: ForgeMind maintainers

## Context

Teams need reusable domain capabilities such as WebRTC debugging, release diagnostics, migrations, and code review. Copying prompts between projects loses versions, examples, tools, tests, licensing, and trust. Agent-native skill formats are converging around directory packages, but discovery paths, permissions, distribution, and extensions vary.

Skills are a persistent instruction and software supply-chain surface. A skill that can name a tool must not be allowed to grant itself that tool.

## Decision

ForgeMind skills are reusable, immutable-versioned capability packages. A skill contains:

- **metadata:** identity, description, publisher, version, license, compatibility, dependencies, trust and provenance;
- **instructions:** activation guidance and bounded workflow;
- **tools:** declared capability requirements, never authority grants;
- **examples:** representative inputs, outputs, and edge cases;
- **knowledge:** focused references and source/version metadata;
- **tests:** trigger, output, negative, safety, and compatibility evaluations.

ForgeMind will preserve compatibility with the open [Agent Skills specification](https://agentskills.io/specification) for the package's `SKILL.md`, scripts, references, and assets. ForgeMind adds a registry control plane for immutable digests, semantic versions, signatures/attestations, dependency locks, validation results, lifecycle, revocation, and trust policy.

Skill loading follows progressive disclosure: registry metadata at discovery, instructions after resolution, and resources only when needed. Effective tool access is the intersection of user, organization, project, runtime, environment, and skill policy. A skill may reduce requested access but can never expand it.

Generated learned skills enter a quarantined draft state and follow the same tests and review path as imported skills.

## Alternatives considered

### Store reusable prompts in a database

Easy to search, but it does not package tools, references, assets, tests, source control, or offline distribution.

### Adopt one agent's skill implementation exactly

Fast for that agent, but non-portable extensions and discovery rules would couple the platform.

### Treat any Git repository as an executable skill

Flexible, but unsafe and irreproducible without a manifest, lock, content digest, trust checks, and sandbox policy.

### Generate skills automatically from every completed task

High apparent learning velocity, but it turns isolated mistakes into persistent instructions and creates unbounded registry noise.

## Consequences

### Positive

- Skills are portable, reviewable, testable, and reproducible.
- Progressive loading reduces context cost.
- Public, internal, and generated skills share one lifecycle.
- Version locks make task packets replayable.
- Trust and authorization remain host-controlled.

### Negative

- Registry governance and package validation add complexity.
- Compatibility matrices and evaluations require maintenance.
- Some native agent extensions require adapter-specific metadata.

### Risks and mitigations

- **Supply-chain compromise:** signatures, content digests, source attestations, SBOMs, quarantine, and revocation.
- **Instruction injection:** trust labeling, static analysis, sandbox tests, and separation of retrieved data from instructions.
- **Dependency confusion:** fully qualified publisher/name identities and immutable dependency locks.
- **Capability escalation:** policy engine computes effective grants; manifest declarations are non-authoritative.

## Compliance

- Production resolution never selects mutable `latest` without creating an immutable lock.
- Registry states include at least draft, quarantined, verified, deprecated, and revoked.
- Revoked versions cannot be newly resolved and generate warnings for pinned historical packets.
- Skill execution records exact version, digest, publisher, tests, and effective capability grant.

## Related documents

- [Skill system](../skills.md)
- [Security](../security.md)

