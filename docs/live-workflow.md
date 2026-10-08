# Project-path execution adapters

ForgeMind has a reusable implementation pipeline for registered GitHub repositories. **Live execution is disabled.** The owner requires subscription-only use, and the current ChatGPT login route provides no enforceable guarantee against consuming paid credits. Request, byte and time limits do not establish that guarantee.

`project:run` always returns a blocked result before worktree creation or provider access. There is no configuration switch to remove this block. Tests inject synthetic model responses; these are not live coding results.

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
| Plan generation | Synthetic model response plus selected files and validated memory; production blocked |
| Coding | Host validates complete UTF-8 edits against exact paths and preimage hashes; synthetic model tested |
| Checks | Actual macOS Seatbelt execution; single-process commands, scratch writes only, no network/fork |
| Review | Separate model invocation receives source-bound diff/checks; revise/blocked stops completion; live independence unverified |
| Recording | Explicit capture command, pinned recorder/probe, process limits, actual file digest and ffprobe validation; fixture tests |
| Draft PR | Exact origin/base/head checks, task-only commit, non-force push and draft creation; subprocess/network fixtures only |
| Live Codex | Live disabled; native 0.161.0 on macOS passes structured responses and plan/edit/check/review through a local fixture transport |

The orchestration entry point is `src/live-workflow/orchestrator.ts`. Its model dependency injection is for trusted conformance code, never loaded from project configuration or CLI input. The fixture broker also rejects calls without an explicitly injected transport. No paid/API-key fallback is implemented.

The implementation retains failed worktrees and records receipts. Existing run state is never automatically replayed. A trusted host owns action grants; repository leases and preference files do not confer execution authority. The source digest binds file paths, contents and executable bits; HEAD is bound separately. Symlinks, hidden index state, submodules, secret-bearing source paths, mismatched push remotes and checkout filters are rejected.

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

This validates the manifest and exits with status 2 and `providerRequests: 0`. It does not claim successful execution. Run `npm run probe:live-native` to repeat native conformance with a fake local transport. The default suite also runs this test on macOS when the Codex executable exists. It verifies executable/protocol/sandbox compatibility, not account billing or real model quality. The sandbox permits the `com.openai.codex` managed-preferences domain, read-only cfprefsd caches and three exact system policy paths; forks, unrelated file data and direct provider egress remain denied. Managed policy is not stubbed or bypassed.

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

The orchestration API accepts trusted host recording and delivery options. Requested video delivery gates **both local completion and draft PR completion**. Without the required options/reviews it returns `needs-video-sharing`; ambiguous publication returns `needs-video-reconciliation`. A successful delivery adds immutable links to the PR description. The production coding CLI remains blocked.

Native and Git delivery tests use local fixtures. Actual GitHub video upload and reviewer playback remain unverified; no application before/after recording was made for this implementation ticket.

## Remaining gates

- Enforce subscription-only billing before permitting any live request.
- Certify the real provider contract after subscription-only billing can be enforced; native local-transport startup and orchestration now pass.
- Add reviewed multiprocess/build/Docker check profiles; current checks cannot run npm, PHP workers or Compose stacks requiring subprocesses/network/writes.
- Integrate per-task preference confirmation. Execution fixtures currently require complete project-level preferences; onboarding still supports both preference modes.
- Verify actual GitHub publication, live independent review and requested recording delivery.
- Windows and Linux enforcement remain unsupported; no unsandboxed fallback exists.

Run `npm run test:live` for fixture and macOS check evidence, and `npm test` for integration regressions. Native tests skip only when the required host/executable is unavailable. A green fixture suite does not enable production.
