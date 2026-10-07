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
| Live Codex | Disabled; native 0.161.0 fixture conformance also fails at managed-preference startup |

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

This validates the manifest and exits with status 2 and `providerRequests: 0`. It does not claim successful execution. Native experiments can be rerun with `npm run probe:live-native`; they use a fake transport and must not be represented as passing while the managed-preference startup error persists.

## Recording and delivery

`recordEvidence` accepts an explicit scenario, capture target, baseline/candidate identities, exact capture command, bounded duration/output/runtime, and pinned probe. The host must authorize recording and probe commands. Before and After are manifest labels; the adapter does not add visible overlays. It validates container metadata and file integrity, not visual coverage or readability. A human or browser reviewer must inspect playback and verify the scenario before delivery.

The provided AVFoundation builder records a numeric macOS device without audio. No screen capture is started by readiness inspection or the blocked run command. Recording commands are trusted host inputs, not model tools; the recording adapter is supervised but is not an OS sandbox. An authorized target and machine recording permission are prerequisites.

Artifacts remain local. Upload/sharing is not integrated. Requested video delivery stops PR completion until a reviewer-accessible authorized destination exists; local links are insufficient. No actual before/after video was recorded for this implementation ticket.

## Remaining gates

- Enforce subscription-only billing before permitting any live request.
- Resolve native sandbox startup and certify a real provider contract without expanding the sandbox casually.
- Add reviewed multiprocess/build/Docker check profiles; current checks cannot run npm, PHP workers or Compose stacks requiring subprocesses/network/writes.
- Integrate per-task preference confirmation. Execution fixtures currently require complete project-level preferences; onboarding still supports both preference modes.
- Verify actual GitHub publication, live independent review and requested recording delivery.
- Windows and Linux enforcement remain unsupported; no unsandboxed fallback exists.

Run `npm run test:live` for fixture and macOS check evidence, and `npm test` for integration regressions. Default tests explicitly skip the unresolved native diagnostic; a green fixture suite does not enable production.
