# Local project memory

Status: implemented local-owner SQLite service, document ingestion, keyword/exact retrieval, lifecycle and supplied-plan integration. This is the project-memory slice from [the implementation plan](./project-memory-plan.md). Native plan/edit/review and reviewed evidence-branch adapters now have fixture coverage; see [execution status](live-workflow.md). Semantic retrieval and production live coding remain unavailable.

## Attach a project

Run these commands from the ForgeMind checkout with the repository's required Node version (`npm run doctor` checks setup). On native Windows PowerShell use `npm.cmd`; actual Windows execution and ACL enforcement remain unverified.

```bash
npm run project:init -- --workspace /absolute/path/to/your-project --project-id your-project
npm run memory -- ingest --workspace /absolute/path/to/your-project
npm run memory -- list --workspace /absolute/path/to/your-project
```

Existing onboarding reuses preferences. Add `--new` only for a new project that needs missing draft PRD/SRS/ADR templates. Edit registered document paths in `config/forgemind-project.json` when the project uses different files. PRD and SRS may be missing; ADRs are discovered recursively as `.md` files beneath the registered directory. No arbitrary repository or chat content is ingested.

Ingestion stores candidates. `list` returns IDs, digests, status and source references. Review the exact record before authorizing reuse:

```bash
npm run memory -- inspect --workspace /absolute/path/to/your-project --id RECORD_ID
npm run memory -- validate --workspace /absolute/path/to/your-project --id RECORD_ID --digest REVIEWED_DIGEST
npm run memory -- search --workspace /absolute/path/to/your-project --query "storage decision"
```

Replace uppercase placeholders with the actual output values. Validation is an explicit local-owner action against that exact digest. An ADR's `Status: Accepted` never validates itself. Conversely, validating a Draft document permits retrieval of that qualified evidence; it does not approve the draft's requirements. Every citation retains the source status.

## Plan with prior decisions

Once memory is initialized in the default location, `project:plan` and `project:prepare` load it automatically for that project/workspace. They retrieve using the supplied plan's objective. `--memory-query` can provide more precise keywords.

```bash
npm run project:prepare -- --workspace /absolute/path/to/your-project --task-id ticket-42 --source-snapshot SOURCE_SHA256 --plan /absolute/path/to/plan.json --preview
```

The plan is still supplied JSON, and `SOURCE_SHA256` is still the trusted caller's asserted source identity. Retrieved context is quoted evidence, with record/source digests and status; it cannot change agent permissions. The packet is limited to ten entries and less than 32 KiB including metadata. Its content enters the plan digest, and changes during interactive review require a new preparation. An empty packet means no current validated matching evidence; it is not proof that no relevant decision exists.

For a custom private state location, add `--state-dir /absolute/private/state` to memory commands and `--memory-state-dir /absolute/private/state` to project commands. The location must be outside the selected project. Custom locations are explicitly supplied rather than stored as authority in the project profile.

## Save findings and maintain decisions

`npm run memory -- add --workspace ... --file /absolute/path/to/candidate.json` adds a post-task finding as a candidate. The JSON contract is:

```json
{
  "kind": "decision",
  "title": "Storage decision",
  "text": "Use SQLite transactions for durable project decisions.",
  "sources": [
    { "path": "docs/adr/ADR-0001-storage.md", "sha256": "EXACT_SOURCE_SHA256", "status": "Accepted" }
  ]
}
```

Supported finding types are `decision`, `fact`, `lesson` and `fix`. Copy exact source references from `list`/`inspect`. Findings must cite currently registered documents. Add optional `supersedes: "OLD_RECORD_ID"` to replace a validated decision: the old record remains active until the new candidate is explicitly validated, then supersession and index changes commit atomically. Conflicting records without a supersession link remain visible together. Add optional `expiresAt` as Unix milliseconds to limit applicability. No model infers promotion or a contradiction-resolution verdict.

Run `ingest` again after document edits. Source changes, removal, registration changes and expiry are checked during every lookup, including exact-ID retrieval. Stale results are immediately suppressed even before ingestion. Ingestion creates new candidates for new document content, supersedes active records from changed versions and redacts all historical derivatives of removed/deregistered sources. Source restoration does not resurrect a tombstoned version automatically.

```bash
npm run memory -- delete --workspace /absolute/path/to/your-project --id RECORD_ID --digest REVIEWED_DIGEST
npm run memory -- rebuild --workspace /absolute/path/to/your-project
npm run memory -- audit --workspace /absolute/path/to/your-project
```

Deleting a document memory redacts its derived findings and blocks reimport of that exact source version. Deleting a finding affects that finding. Source files remain untouched. Content-free IDs, hashes and audit events remain. `rebuild` reconstructs the search index from current validated authoritative records.

## Storage, retention and trust

The default store is `~/.forgemind/memory/<digest-of-project-and-workspace>/memory.sqlite`. Canonical workspace and project ID are also checked inside the database, so copying a profile or database into another project does not grant access to its memory. Moving a workspace currently creates a distinct store; no relocation/migration command is provided.

SQLite uses a transactional schema migration, short write transactions, a one-second busy timeout, full synchronous durability and rollback journals. Both SQLite and FTS5 secure deletion are enabled for content removal ([SQLite FTS5 documentation](https://www.sqlite.org/fts5.html#the_secure_delete_configuration_option)). Busy writes fail without partial changes; callers can retry the complete operation. The keyword baseline uses literal word matching and deterministic title/text ranking; FTS operators in user queries are not executed as query syntax. The index is derived and rebuildable.

Project records without an explicit expiry remain for the project's lifecycle, until superseded or deleted. Superseded versions stay owner-visible as metadata and are excluded from normal retrieval; their content remains until source removal, explicit deletion or expiry. Expired record content is purged lazily on the next memory operation that accesses records. Deleted versions retain content-free tombstones. No full conversations, session history or embeddings are stored by this slice.

This API is for the trusted local owner/host. Do not expose the mutable service, state directory or owner CLI to an untrusted agent. POSIX ownership and private modes are checked; Windows ACLs, hostile same-UID process isolation, authenticated multiuser access, tenant/organization memory, encryption, secret scanning and automatic backup/export deletion are not implemented here. Registered documents are stored in full. Only register documents appropriate for local persistence. Already-exported packets and external backups remain under their owner's retention controls; consumers must revalidate freshness before consequential use. Source files are read with bounded sizes and safe-path checks, but no claim of an atomic filesystem snapshot across concurrent external edits is made.

The workflow still returns `liveCodingEnabled: false`. Memory recall and owner evidence validation never grant runtime execution, network, spend, Git or publishing permissions.
