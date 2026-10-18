# Historical qualification CLI

The CLI imports existing native or supervised execution history and produces a `historical-qualification-v1` report using the qualification library. Every result has `authority: "none"` and scope `historical-evidence-consistency`. It grants no capabilities, starts no services or inference, publishes nothing, and changes no accounts. Importing the CLI module does not execute a command; `qualificationMain(argv, ports?)` returns a conventional exit code.

## Commands

Run `npm run build` first. Use canonical absolute paths, replacing `/canonical/repo` and `/private/qualification` with actual owner-controlled locations. The private directory must already exist outside the workspace, belong to the current POSIX user, and have mode 0700. JSON files must have mode 0600. Ancestors must be directories owned by the user or root, without symlinks or group/world write access; root-owned sticky temporary ancestors are supported. Resolve temporary directory aliases before constructing paths.

```sh
umask 077
mkdir -m 700 /private/qualification
chmod 600 /private/qualification/input.json /private/qualification/build.json
npm run build
node dist/src/local-runtime/qualification-cli.js --help
node dist/src/local-runtime/qualification-cli.js supervised \
  --workspace /canonical/repo \
  --input /private/qualification/input.json \
  --build /private/qualification/build.json \
  --created-at 1792281600000 --expires-at 1792285200000 \
  --output /private/qualification/report.json
node dist/src/local-runtime/qualification-cli.js verify \
  --workspace /canonical/repo --input /private/qualification/report.json
```

The timestamp literals illustrate epoch milliseconds: replace them with an actual creation time at or before now and an expiry strictly after now and creation. Future, expired, reversed, nonintegral, and unsafe integer timestamps are rejected. Expired reports also fail verification. `native` accepts the same flags as `supervised`. Either creation command optionally accepts `--review /private/qualification/review.json`. Unknown, repeated, missing, extra, oversized, or control-containing arguments are denied. Help needs no repository.

Creation prints only `{status,digest,source,outcome,authority,scope}`. Verification prints a bounded library verification projection with `status: "historical-evidence-only"`, `evidenceOnly: true`, and the historical scope. A consistent verification can still have `outcome: "partial"`; consistency is not successful execution or independent review. Errors return code 1 and one fixed JSON denial on stderr, without raw evidence, filesystem paths, or underlying error messages.

## Source and build manifest

Production uses the repository's actual `sourceIdentity(workspace)` reader. The input and build manifest must match that current source identity; a caller cannot supply a creation override. This identity is a source snapshot digest, not a Git commit ID. The CLI checks current source stability around reads and output creation. Ignored build artifacts such as `dist` may need separate pins because they can be omitted from the source snapshot.

Supply a `qualification-build-v1` manifest with exactly these fields:

```json
{
  "schema": "qualification-build-v1",
  "source": "REPLACE_WITH_ACTUAL_SOURCE_SHA256",
  "artifacts": [
    {
      "id": "qualification-cli",
      "path": "/canonical/repo/dist/src/local-runtime/qualification-cli.js",
      "sha256": "REPLACE_WITH_ACTUAL_ARTIFACT_SHA256"
    }
  ]
}
```

The placeholders are deliberately invalid. Substitute actual lowercase nonzero 64-digit SHA-256 values. Hash the actual full artifact bytes, for example with `shasum -a 256 /canonical/repo/dist/src/local-runtime/qualification-cli.js`; never substitute an all-zero or invented digest. Include the actual relevant compiled artifacts under unique IDs and unique paths, up to 32 pins. The library canonicalizes their order and binds the manifest digest into the report.

Build pins may reference workspace files, including `dist`. Each must be a canonical absolute regular file owned by the user with one link, safe ancestors, and no writable group/world bits; ordinary 0644 files are supported. Directories, symlinks, hardlinks, credential-bearing paths, path aliases, and incorrect digests are rejected. The owner reads with `O_NOFOLLOW`, hashes in 64 KiB chunks, and checks descriptor/path inode, device, size, permissions, modification time, and change time before and after reading. Limits are 32 MiB per artifact and 64 MiB aggregate, independently of the JSON limit. Pins are rehashed and compared with the initial snapshots before writing and before final output acceptance.

## Input evidence

Both modes require `qualification-input-v1` with `taskId`, `projectId`, `source`, `fixture` (a boolean), and nonempty unique `requiredChecks`. These fields describe imported history. Use `fixture: true` for offline fixtures; CLI tests never claim provider execution.

Native mode additionally requires `nativeTask`, `parentBinding`, and `result`. Preserve the original native task with its actual `project`, `task`, initial `source`, canonical `root`, `model`, `effort`, `readPaths`, `writePaths`, `checks`, and `budget`. `parentBinding` is the original owner authority binding digest, not a new grant. Use the existing native executor contracts; do not invent a replacement task or checkpoint format.

`result` is the actual `runNativeTask` return or the failure export `{phase,code,receipts}` from `NativeRunError`. A successful import uses the library's allowlisted result projection (`taskId`, `status`, `source`, `readiness`, `checks`, `executionLease`, `native`, `owner`, `runtime`, or supported checkpoint/usage/diagnostic/unavailable/qualification fields). The known optional `result.native.finalResult` is accepted intact (or null/absent) as bounded, untrusted metadata with `{schema:"native-final-text-v1",trust:"evidence-only",source,turnId,messages:[{id,text}],digest}`. Its producer digest hashes `JSON.stringify({schema,trust,source,turnId,messages})` in that property order. Qualification ignores this content for success, review, and authority; it never projects messages, turn IDs, or this digest. Unknown native or outer result fields remain denied. Preserve original export bytes, original task and checkpoint binding, complete checks, and receipt relationships. The CLI does not weaken bindings to accommodate projections or synthetic fixtures. Historical runtime scratch pins are imported evidence, never instructions to open current scratch files.

Native owner phases use the actual `NativeOwner.export()` rows `{id,before_source,after_source,data}`, where `data` is serialized JSON containing exactly `{transitionReceiptId,before,source}`. The row ID equals the transition UUID; source digests must form an ordered contiguous chain from the initial task source to the final result source. Duplicate, reordered, gapped, or tampered rows are rejected. These rows differ from supervised phases. NativeProject generates the transition UUID separately from policy decision and terminal UUIDs. The exported history lacks the full transition envelope and an explicit association from that UUID to its policy receipts. A matching output digest or source string cannot establish the association. Consequently even a valid edited-source chain stays `sourceBound:false`, `executionConsistent:false`, and `partial`; missing history with differing initial/final sources also stays partial. An unchanged source with an empty phase history can qualify. Imported history always has `authority:"none"`.

Native completion requires every check declared in the original task exactly once, passed with exit code zero and terminal-bound to the same final source and task. A narrower `requiredChecks` list cannot hide an omitted, failed, or unbound original check.

Runtime cleanup requires one completed runtime row at the readiness runtime binding. Its ID must equal the sole allowing `external.decided` receipt ID, paired with exactly one distinct completed `external.finished` receipt. Both receipts must preserve matching nonempty request, grant, invocation, host resource, command action, request digest, task, runtime source, principal, session, and policy version; the terminal timestamp cannot precede the decision. Both invocation IDs must equal `runtime.leaseId`, which is distinct from the account execution lease ID. Terminal evidence requires a valid view digest. Lifecycle view digests hash `JSON.stringify(plan)` while host resource suffixes hash canonical serialization, so these different digests are not compared. Missing, detached, contradictory, or duplicate pairs leave cleanup unavailable and qualification partial.

Supervised mode additionally requires `receipt` and `artifacts`. `receipt` is the actual `RunAuthority.export()` shape:

```json
{
  "taskId": "task",
  "run": {"id": "task", "status": "failed", "requests": 0, "input_bytes": 0},
  "phases": [],
  "receipts": []
}
```

A phase has `{seq,name,source,data}`; `data` is the original serialized JSON string, not a parsed object or a field named `dataJSON`. Worktree, candidate, and reviewed phases and terminal policy receipts must retain their actual source/order/output bindings. An early failed run can have no artifacts and produces partial evidence.

The supervised `artifacts` bundle holds at most one each of `before-checks.json`, `after-checks.json`, and `review.json`. Each descriptor is `{name,source,sha256,json}`, where `json` is the exact original UTF-8 string including whitespace and any final newline, and `sha256` hashes those original bytes. Check artifacts contain original full `CheckResult` arrays; review artifacts contain `{verdict,findings,source}` and optional `acceptance`. The corresponding phases, sources, verdicts, and terminal output receipts must agree. Reformatting an artifact changes its pin. These embedded historical artifacts are distinct from current build files.

Optional separate review input uses `qualification-review-v1` with `taskId`, `source`, `reviewer`, `implementer` (identifier or null), `createdAt`, `expiresAt`, and an `artifact` descriptor for `review.json`. Identity, task/source, exact bytes, verdict, and lifetime remain library-validated. A supervised review must also appear in the reviewed phase's artifact bundle. Missing review, expired/future review, unknown implementer, or the same reviewer and implementer cannot establish independent review. The CLI does not create a reviewer attestation.

## Files, digests, and historical verification

Input, build, review, and report reads are limited to 2 MiB each, outside the workspace, regular 0600 files with owner UID and one link, immediately inside a 0700 owner directory. Reads use bounded nofollow descriptors, UTF-8 roundtrip validation, and before/after descriptor/path checks. Credential-bearing locations are rejected before opening evidence files. Keep credential material out of evidence bundles.

Creation passes the exact original input string as `rawInput`. Its digest therefore binds the original UTF-8 bytes, including formatting. The build digest binds the canonical manifest; artifact SHA-256 binds full file bytes. The report digest binds canonical report content excluding its digest field, not the serialized report file's byte hash. These bindings establish consistency with imported history, not authenticity of that history or proof of a provider run.

Output must be a new file outside the workspace in an existing safe owner-private directory. The CLI writes bounded canonical report JSON with a final newline through an exclusive `O_CREAT | O_EXCL | O_NOFOLLOW` descriptor at mode 0600, fsyncs, then checks private path/descriptor binding, artifact pins, report lifetime, and current source stability. It never overwrites a report. A denied creation can leave a partial or complete file after an interrupted write or a changed source. That remaining file is unaccepted evidence: only a successful creation exit and its returned digest signify CLI acceptance. Inspect or remove it separately and use a new output path for another attempt; its mere presence or later structural consistency does not retroactively establish creation acceptance.

Verification defaults to the current workspace source. To inspect a report for an older source while working in a changed repository, explicitly supply that historical identity:

```sh
node dist/src/local-runtime/qualification-cli.js verify \
  --workspace /canonical/repo --input /private/qualification/report.json \
  --expected-source ACTUAL_HISTORICAL_SHA256
```

This override permits historical report matching but still requires the **current** workspace source to stay stable before and after reading. Verification checks the report's structure, digest, semantics, expected source, and lifetime. It does not reopen historical build paths or runtime scratch pins, which may no longer exist. Creation's filesystem observations and imported runtime history remain distinct.

Reports classify observations as reported, imported, fixture, or unavailable. Account entitlement and billing settings remain unavailable; inference consistency describes imported evidence, and token usage is only a reported observation. There is no hard billing cap or guaranteed provider request count, production approval is unavailable, and deployment remains unqualified. Even `completed-scoped` provides no launch, publishing, account, or deployment authority.
