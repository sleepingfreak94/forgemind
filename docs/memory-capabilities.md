# Local-owner memory capabilities

This additive module implements injectable semantic/hybrid project retrieval and a separate durable session checkpoint API. Organization memory provides versioned evidence contracts and denial receipts only: organization writes, reads, sharing and promotion remain disabled and unfinished. Existing project-memory documentation describes the earlier slice; this document describes these new APIs. The focused 28-test semantic/session/organization suite, strict types, build and independent module review passed. These module observations do not replace combined-source verification; see [backlog status](./backlog-status.md).

All service objects, embedding adapters and state directories are trusted LOCAL OWNER capabilities. Never provide them to child tools or task agents. Consumers receive immutable packets marked `trust: 'evidence-only'`. Digests bind content; they are not signatures, authentication, organizational authority or execution grants. Same-UID ownership does not authenticate a tenant, organization member, validator or group. No CLI, scheduler, account, credential, setting, paid activation, network request, provider download or orchestration is activated by these modules.

## Semantic retrieval

`SemanticMemory` in `src/memory/semantic.ts` accepts an existing `ProjectMemory` and an optional `EmbeddingProvider` from `semantic-contracts.ts`. The provider contract has immutable `model`, `version` and `dimensions` identity and an asynchronous `embed(request)` method returning real numeric vectors. The owner must supply a vetted local adapter and its model explicitly. There is no default embedding model and no hash/lexical approximation described as an embedding.

```ts
const unavailable = new SemanticMemory(projectMemory);
unavailable.status(); // status: 'provider-needed', provider: null
await unavailable.search('durable transaction recovery'); // empty provider-needed packet

// ownerLocalProvider implements EmbeddingProvider; no adapter is bundled/selected.
const retrieval = new SemanticMemory(projectMemory, ownerLocalProvider);
const semantic = await retrieval.search('durable transaction recovery', 'semantic', 5);
const hybrid = await retrieval.search('durable transaction recovery', 'hybrid', 5);
```

Only public ProjectMemory `list`, `get` and `search` supply records. Current validated registered sources are checked before embedding, after asynchronous embedding, before ranking and at the packet boundary. Candidates, superseded, expired, deleted, deregistered, mutated and foreign-scope records are excluded. Provider identity drift rejects the operation. Each binding covers record content/digest, current source citations, project/workspace, provider identity and `project-semantic-v1`. The index is derived and rebuildable: this implementation retains no vector cache or raw-text cache between calls. It cannot retract text already passed to a trusted provider or packets already exported. Filesystem source checking inherits ProjectMemory's non-atomic snapshot limitation under concurrent external edits.

Cosine uses normalized finite nonzero numeric vectors; dimension mismatches, NaN, infinity, zero/underflow norms and overflowing norms reject. Hybrid ranking uses reciprocal rank fusion, `1/(60+semanticRank) + 1/(60+lexicalRank)` when the public top-ten lexical list contains the same digest. Semantic mode sorts cosine alone. Equal scores sort by record ID. Similarity is relevance evidence only.

| Boundary | Limit |
| --- | --- |
| Vector dimensions | 1–4096 |
| Eligible corpus | 256 records; reject excess, no silent subset |
| Provider record input | 32768 UTF-8 bytes including title/newline |
| Aggregate corpus text | 262144 UTF-8 bytes; reject before embedding |
| Query | 2048 UTF-8 bytes |
| Results | 1–10 requested; whole entries omitted to fit packet |
| Complete packet | 24000 bytes including digest |

Packets report eligible and successfully embedded counts with `complete-or-reject` coverage policy. In-flight invalidation may reduce coverage. An empty result is not proof of absence. Re-run retrieval and check current registered sources before consequential use. No embedding vector is an authenticity check. Only already validated source text reaches the adapter, but secret scanning and DLP are not solved: owners must register and query appropriate material.

`tests/memory/semantic.test.ts` contains deterministic numeric vectors only for tests, known cosine arithmetic, a labeled differently-worded query fixture and a reproducible lexical-versus-hybrid recall@1 report. It binds source, record, model, version and index identities. This is fixture plumbing evaluation, not production embedding quality, generalization evidence or a selected model. The focused suite has been executed successfully. A separate pinned local CPU-model smoke used three public synthetic queries; its source/model/dataset bindings and results are recorded in [sanitized smoke evidence](./backlog-smoke-evidence.json). That small smoke is neither a default model selection nor broad quality certification.

## Durable structured sessions

`SessionMemory(directory, canonicalWorkspace, clock = Date.now)` owns a different SQLite file/schema from MemoryDatabase. The directory must be absolute, canonical and outside the registered workspace. When `typeof process.getuid === 'function'`, directories must be owned by the local UID with exact mode 0700, and the DB and existing journal/WAL/SHM sidecars must be owned by that UID with exact mode 0600. Canonical path, directory/file type, symlink rejection, regular single-link file and workspace/project scope checks apply on every platform; symlinks and hardlinked files reject before opening. Each database persists both canonical workspace and project ID; copying it to another project/store location does not transfer scope. Path checks are local filesystem defenses, not isolation from a hostile same-UID process; Windows ACL enforcement is unqualified.

```ts
const sessions = new SessionMemory('/absolute/private/session-state', workspaceRoot);
try {
  const fields = {
    sessionId: 'session-42', taskId: 'task-42', sourceSnapshot: sourceSha256,
    evidenceRefs: [{ id: evidenceIdSha256, sha256: evidenceContentSha256 }],
    completedStepIds: ['inspect'], nextStepIds: ['implement'],
    hypothesesSummary: 'The owner suspects a transaction ordering issue.'
  };
  const first = sessions.put(fields, 3600); // required owner TTL, integer seconds
  const next = sessions.checkpoint({ ...fields, completedStepIds: ['inspect', 'implement'], nextStepIds: ['verify'] }, {
    expectedDigest: first.record.digest, expectedRevision: first.record.revision
  });
  const continuationEvidence = sessions.get(fields.sessionId);
  const page = sessions.list(50); // next page: list(50, lastSessionId)
  sessions.remove(fields.sessionId, { expectedDigest: next.record.digest, expectedRevision: next.record.revision });
} finally { sessions.close(); }
```

Only the exact structured fields above are accepted. IDs are ASCII letters/digits/underscore/hyphen, start with a letter/digit, and are at most 128 characters; they are never filesystem paths. Snapshot/evidence references require SHA-256 strings and remain owner-supplied assertions, not independently verified filesystem snapshots. At most 32 distinct evidence references, 64 distinct completed steps and 64 distinct next steps are accepted. Completed/next steps cannot overlap. The hypothesis summary is nonempty, bounded to 2048 UTF-8 bytes. Unknown fields, accessor properties, rawConversation/messages/secrets fields and malformed nested objects reject without evaluating accessors. Free text can still contain sensitive material: comprehensive DLP, secret detection and encryption are not implemented.

TTL is required on `put`: 1–604800 integer seconds (at most seven days), with safe integer millisecond timestamps. Missing/invalid TTL and unsafe/injected clocks reject. Checkpoints increment revision, require the exact expected digest/revision, retain creation/expiry and task identity, and cannot extend retention. Packets include created/updated/expiry timestamps, project/workspace, digest and revision, bounded to 16000 bytes. Up to 256 active records and 10000 permanently reserved IDs are allowed per store; listing returns at most 50 packets per page. A capacity error requires explicit owner lifecycle handling; tombstones are never silently recycled.

SQLite uses short transactions, a one-second busy timeout, rollback journals, full synchronization and secure deletion. Schema version 1 is checked structurally and future/malformed versions fail closed. Failed writes roll back. A persisted clock high-water mark prevents later clock rollback from resurrecting an observed-expired session or reducing timestamps; `put` derives creation/update/expiry timestamps and checks expiry overflow against the effective time (the maximum of its maintenance timestamp and the validated high-water mark read inside its insertion transaction). Expiry is lazy but durable at access/open: expired bodies become NULL and revisions advance in a committed maintenance transaction, even if a subsequent update rejects. Deletion similarly removes the body and leaves only ID/hash/revision/state/expiry tombstone metadata. Reusing a deleted/expired ID or replaying an old checkpoint fails, including after restart. `close()` releases the connection even after profile drift.

This is continuation infrastructure only. It does not select agents, authenticate task participants, replay transcripts or implement cross-agent orchestration. Returned packets and backups can outlive the store's TTL. Secure deletion cannot guarantee erasure from filesystem snapshots, SSD remapping, journal history outside the store, external backups or exported packets. Restoring an older backup may roll back tombstones/high-water state; backup retention and restore reconciliation remain owner responsibilities. No background expiry scheduler is installed.

## Organization conformance remains blocked

`organization-memory.ts` defines `OrganizationCandidate`, source/provenance/evidence bindings, validation requirements and denial receipts. `validateOrganizationCandidate` checks strict bounded shape, hashes, consistent project/source bindings and packet digest. It only checks conformance of claims; even a well-formed candidate does not establish source access, independent evidence, membership or validator authority.

```ts
const organization = new OrganizationMemory();
organization.status(); // blocked-policy-unconfigured, enabled: false
organization.promote(candidate); // decision: denied, trust: evidence-only
organization.share(candidate);  // denied
organization.write(candidate);  // denied; nothing stored
organization.read(candidate);   // denied; no organization content returned
```

Missing trusted principal/group mapping, ACL policy, validator/quorum and independent evidence binding policy are explicit. There is no authority configuration setter, membership boolean, capability minting, actual organization storage or network adapter. Forged `authorized: true`, validation flags, scope flags and plausible metadata never enable an operation. Malformed input yields a content-free denial without echoing the input. Organizational sharing/promotion acceptance requires a separately designed trusted principal/policy/evidence protocol and independent review.
