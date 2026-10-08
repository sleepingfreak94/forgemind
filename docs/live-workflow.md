# Project-path execution adapters

ForgeMind has a reusable implementation pipeline for registered GitHub repositories. Supervised Codex execution on macOS uses a dedicated ChatGPT-plan OAuth connection and a remembered owner acknowledgement of its server-side credit control. Unattended execution and requests without a reviewed connection remain disabled. Request, byte and time limits are not a hard billing cap.

The trusted owner must verify that connected apps cannot use credits after included usage is exhausted. ForgeMind cannot inspect that toggle programmatically. Its interactive confirmation is an owner assertion, not a machine billing attestation. If the setting is unavailable or cannot be verified, do not confirm or run. The server control must remain off throughout execution. There is no API-key fallback.

## Connect and run

Use an owner terminal and canonical absolute paths outside project source:

```sh
npm run project:connect -- --connection /absolute/private/account
npm run project:auth-status -- --connection /absolute/private/account
npm run project:run -- --workspace /absolute/project --task /absolute/task.json --connection /absolute/private/account --codex /absolute/codex --state-root /absolute/private/runs --worktree-root /absolute/private/worktrees
```

Connection prints the supported OpenAI browser sign-in URL. Complete account selection and consent yourself. ForgeMind stores only its own tokens in protected local state outside Git checkouts; existing Codex login files and ambient API keys are not read. Signed identity, granted plan-usage scope and selected registration must validate before tokens are accepted. Expired access requires reconnecting; automatic token renewal is not integrated.

Before the first account acknowledgement, review **ChatGPT → Settings → Usage → Allow other apps to use credits after reaching your usage limit** and ensure it is off for the selected account. Match the displayed signed account email to your browser account, then enter the displayed `credits-disabled <account-fingerprint>` phrase only after that review. The terminal also shows the canonical connection directory, app/client ID and subject; connections without a signed email remain blocked. The acknowledgement is persisted in owner-only local account state, bound to the host, client, account and signed email. It survives later runs and same-account OAuth token renewal without another prompt; there is no five-minute billing-review expiry or three-request confirmation cycle. Each open session still pins its exact credential record and stops on credential changes, disconnect, reset or token expiry. A new session can use renewed credentials for the same acknowledged identity. A new identity or missing acknowledgement requires the initial interactive confirmation. Session expiry actively aborts outstanding fetches, including stalled headers or response bodies; local cancellation cannot undo server work already accepted. See [official sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [account usage controls](https://learn.chatgpt.com/docs/sign-in-with-chatgpt) and [plan inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

The owner broker alone holds OAuth credentials and sends inference to the documented `https://api.openai.com/v1/responses` plan route. The Codex worker can access only that local broker and private scratch, not account tokens or project files. Each phase receives selected source as evidence, returns structured JSON, and uses existing host edit/check/review adapters. Redirects, provider errors, quota failures and incomplete streams stop the task without automatic retry, account/model switching or paid fallback. Native Codex 0.161.0 remains pinned.

The broker sends the selected `reasoning.effort` and omits `reasoning.summary`: summaries are opt-in in the [public Responses API](https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries). Codex's internal summary setting `none` is not forwarded as a wire value. This request-format guard is covered by synthetic public-route completion, quota and failed-stream tests; fixture success does not establish live provider acceptance. A failed live run remains preserved and is never automatically replayed.

To forget the saved acknowledgement without signing out or making a provider request:

```bash
node dist/src/local-runtime/live-cli.js billing-reset --connection /absolute/private/account
```

The next dispatch checks that the saved review still exists and has the same random review ID. Reset invalidates existing sessions even if the same account is acknowledged again. It cannot undo provider work already accepted. The private acknowledgement file uses the same bounded, owner-only, no-link, locked, atomic storage as the connection; it stores account/identity hashes, confirmation time and a review ID, with no tokens or email. Removing the connection and establishing a new one discards its old acknowledgement; normal renewal of an intact same-account connection retains it. This change does not increase model-request, byte, runtime or publishing grants.

A run without connection options still validates its manifest and publication requirements, then returns blocked with exit 2 and zero provider requests, and creates no worktree. There is no `--yes`, imported API-token argument, environment enable flag or project-profile billing permission. Production session capabilities and test transports cannot be combined. Non-macOS hosts fail closed.

For a task with `draftPr: true`, also supply the complete publication tuple on `project:run`:

```sh
--gh /canonical/path/to/gh --author-name "Repository Owner" --author-email "123+owner@users.noreply.github.com"
```

These three flags are optional together for local-only tasks. Partial tuples are rejected, and a draft PR task missing the tuple fails before authentication, owner review, worktree creation or model access, including when connection options are absent. All path flags retain the canonical absolute-path grammar; author fields are identity strings. Names must start with a letter or digit, use only letters, marks, digits, spaces and ordinary name punctuation (`. , ' ’ _ -`), have no surrounding whitespace, and fit in 120 UTF-8 bytes. Emails must be ASCII dot-separated atoms of letters, digits, `_`, `+` or `-`, with a DNS-style domain containing a dot; the local part is limited to 64 characters and the address to 254. Controls, identity delimiters and command syntax are rejected.

The trusted host pins the explicitly selected existing `gh` executable's content hash before account review. Use its canonical resolved path, with executable permission, trusted ownership and no group/world write permission. Publication rechecks the pin and uses only the existing fixed `gh auth git-credential` Git helper against GitHub; helper arguments and tokens cannot be supplied. The helper can use the owner's existing GitHub CLI keyring connection. ForgeMind does not extract credentials or run `gh auth setup-git`. Commits receive the explicit identity through per-command `git -c user.name=... -c user.email=...`; no author environment override or local/global Git config write is needed.

Trusted API hosts can supply `RunOptions.publication` with `author: { name, email }` and `gitCredentialHelper: { ghPath, sha256 }`. Orchestration forwards these to the ticket commit and draft PR publisher. Existing fixture/API calls without an author remain compatible; the production CLI enforces explicit publication inputs. This wiring does not authorize model requests or establish live GitHub publication evidence.

## Inspect a project

From ForgeMind:

```sh
npm run project:inspect -- --workspace /absolute/path/to/project
```

Use another repository's absolute path in the same command. It reads that project's `config/forgemind-project.json`, origin, HEAD, default branch, document locations, preferences and dirty paths. It does not read authentication files or contact GitHub. Register a new project with the existing [onboarding and memory workflow](project-memory.md) first.

ForgeMind's own repository destination is separate: a target project's remote is never used to publish ForgeMind implementation changes.

## Implementation and evidence

| Capability | Current evidence / limit |
| --- | --- |
| Isolated task checkout | Git fixture tests; clean source required; original checkout preserved |
| Plan generation | Selected files and validated memory through the reviewed plan session; synthetic transport tested, real inference pending |
| Coding | Host validates complete UTF-8 edits against exact paths and preimage hashes; synthetic model tested |
| Checks | Actual macOS Seatbelt execution; single-process commands, scratch writes only, no network/fork |
| Review | Separate model invocation receives source-bound diff/checks; revise/blocked stops completion; live independence unverified |
| Recording | Explicit capture command, pinned recorder/probe, process limits, actual file digest and ffprobe validation; fixture tests |
| Draft PR | Exact origin/base/head checks, task-only commit, non-force push and draft creation; subprocess/network fixtures only |
| Live Codex | Supervised ChatGPT-plan route implemented; real account/inference verification pending; native local-transport conformance is separate evidence |

The orchestration entry point is `src/live-workflow/orchestrator.ts`. Its model dependency injection is for trusted conformance code, never loaded from project configuration or CLI input. Production instead requires a branded, authenticated owner-reviewed plan session. Arbitrary objects or fixture dependencies cannot authorize production requests. No paid/API-key fallback is implemented.

The implementation retains failed worktrees and records receipts. Existing run state is never automatically replayed. A trusted host owns action grants; repository leases and preference files do not confer execution authority. The source digest binds file paths, contents and executable bits; HEAD is bound separately. Symlinks, hidden index state, submodules, secret-bearing source paths, mismatched push remotes and checkout filters are rejected. Each provider action's durable policy envelope records the selected connection fingerprint, acknowledgement timestamp and credential expiry without tokens. Exported receipts bind that envelope by digest; `receipt.json` does not export the envelope contents.

## Task manifest

The following illustrates the accepted format; executable paths must match the local machine. Model selection must be explicitly verified before any future live enablement.

```json
{
  "schemaVersion": 1,
  "taskId": "fix-example",
  "objective": "Correct the selected calculation and preserve its tests",
  "readPaths": ["src/calculation.js", "tests/calculation.test.js"],
  "writePaths": ["src/calculation.js"],
  "checks": [{
    "id": "calculation",
    "executable": "/absolute/path/to/node",
    "args": ["--test", "--test-isolation=none", "tests/calculation.test.js"],
    "timeoutMs": 30000
  }],
  "model": "explicit-owner-selected-model",
  "effort": "high",
  "maxModelRequests": 3,
  "maxPromptBytes": 262144,
  "maxOutputBytes": 1048576,
  "maxRuntimeMs": 300000,
  "draftPr": true
}
```

```sh
npm run project:run -- --workspace /path/to/project --task /path/to/task.json
```

For this draft PR manifest, also supply the publication tuple shown above. Without it, the CLI exits with a publication configuration error before account access. With the tuple but without connection options, the CLI validates the manifest and exits with status 2 and `providerRequests: 0`. Run `npm run probe:live-native` to repeat native conformance with a fake local transport. The default suite also runs this test on macOS when the Codex executable exists. It verifies executable/protocol/sandbox compatibility, not account billing or real model quality. The sandbox permits the `com.openai.codex` managed-preferences domain, read-only cfprefsd caches and three exact system policy paths; forks, unrelated file data and direct provider egress remain denied. Managed policy is not stubbed or bypassed.

## Compact coding edits

For small changes to an existing file, the coding prompt prefers a versioned exact text replacement:

```json
{"path":"styles.css","beforeSha256":"<whole-file SHA-256>","format":"text-replacements-v1","replacements":[{"before":"<unique original text>","after":"<replacement text>"}]}
```

The host verifies the whole-file digest and strict UTF-8, then resolves every nonempty anchor against the same original file. Missing, ambiguous, overlapping, unchanged or malformed operations are rejected. It permits at most 100 operations per file, 1 MiB of replacement text per proposal and 256 KiB per fragment and resulting file. Untouched bytes, line endings and mode are preserved. All files are validated before the first write; existing path/link checks, authority receipts and immediate pre-write hash/source checks still apply. A file uses either replacement operations or complete `content`, never both. Complete content remains available for compatibility, file creation and deletion. No fuzzy matching, regex, automatic retry or whole-file fallback is performed.

This format reduces output amplification for large files. Synthetic native fixtures establish protocol compatibility, not live provider reliability, latency or completion. A separately confirmed REBOS attempt reached real planning and passing baseline checks, then its coding stream terminated before edits; its sole cause remains unproven and its failed run is preserved. Session, request, byte and runtime limits are unchanged.

## Recording and delivery

`recordEvidence` accepts an explicit scenario, capture target, baseline/candidate identities, exact capture command, bounded duration/output/runtime, and pinned probe. The host must authorize recording and probe commands. Before and After are manifest labels; the adapter does not add visible overlays. It validates container metadata and file integrity, not visual coverage or readability. A human or browser reviewer must inspect playback and verify the scenario before delivery.

The provided AVFoundation builder records a numeric macOS device without audio. No screen capture is started by readiness inspection or the blocked run command. Recording commands are trusted host inputs, not model tools; the recording adapter is supervised but is not an OS sandbox. An authorized target and machine recording permission are prerequisites.

The evidence adapter publishes reviewed recordings to `evidence/<task-id>/<pair-sha256>` in the **target project’s GitHub origin**, in a separate orphan checkout. Only `before.mp4`, `after.mp4` and an allowlisted `evidence.json` are exported. Links use the confirmed immutable evidence commit. Each video is capped at 20 MiB. No source branch or default branch is pushed by this adapter.

Prepare a read-only preview from source-bound recording manifests:

```sh
npm run evidence:prepare -- --workspace /path/to/project --before /private/evidence/before.json --after /private/evidence/after.json
```

After an independent code review of that exact source, inspect both videos for actual scenario coverage, readable framing, playback and privacy for the repository’s audience. Delivery is an explicit local-owner action:

```sh
npm run evidence:deliver -- --workspace /path/to/project --before /private/evidence/before.json --after /private/evidence/after.json --code-review /private/evidence/review.json --state-root /private/durable-delivery-state --evidence-parent /private/evidence-checkouts --author-name "Repository owner" --author-email "owner@example.invalid"
```

The review JSON must contain `verdict: "pass"` and `source` matching the candidate identity. The interactive terminal requires `approve <pairSha256>` to attest that the independent review and playback/privacy checks were performed. A JSON verdict alone is not proof of reviewer independence. There is no noninteractive approval flag. Use an existing private durable state directory and an existing evidence parent outside the source checkout. Each pair gets a permanent attempt fence; failed or unknown pushes require manual reconciliation, never a blind retry or deletion of the fence.

Authentication is opt-in: provide both `--gh /absolute/path/to/gh` and `--gh-config-dir /private/gh-config` to use a pinned GitHub CLI helper. Ambient Git helpers, hooks, proxies and tokens are not inherited. The helper may access its explicitly selected authentication store; ForgeMind does not extract credentials. Confirm the selected store authenticates to the intended repository before delivery.

The orchestration API accepts trusted host recording and delivery options. Requested video delivery gates **both local completion and draft PR completion**. Without the required options/reviews it returns `needs-video-sharing`; ambiguous publication returns `needs-video-reconciliation`. A successful delivery adds immutable links to the PR description. The supervised coding CLI requires its own authenticated, owner-reviewed account connection; video delivery approval does not authorize inference.

Native and Git delivery tests use local fixtures. Actual GitHub video upload and reviewer playback remain unverified; no application before/after recording was made for this implementation ticket.

## Remaining gates

- Keep the selected account's server-side connected-app credit control off. The saved owner acknowledgement is not an automatic billing attestation; reset it if that setting changes.
- Verify real OAuth sign-in, credit-disabled inference and quota-exhaustion behavior; local-transport conformance is not live-provider evidence.
- Add reviewed multiprocess/build/Docker check profiles; current checks cannot run npm, PHP workers or Compose stacks requiring subprocesses/network/writes.
- Integrate per-task preference confirmation. Execution fixtures currently require complete project-level preferences; onboarding still supports both preference modes.
- Verify actual GitHub publication, live independent review and requested recording delivery.
- Windows and Linux enforcement remain unsupported; no unsandboxed fallback exists.

Run `npm run test:live` for fixture and macOS check evidence, and `npm test` for integration regressions. Native tests skip only when the required host/executable is unavailable. A green fixture suite does not authorize a real account request; explicit sign-in and account-control review remain required.
