# Contributing to ForgeMind

ForgeMind is an early technical preview. Feedback on setup, documentation, project memory, and supervised coding workflows is welcome.

## Getting started

Use Node.js 26.7.0 or newer and Git. From the repository checkout:

```bash
npm ci
npm run verify:portable
npm run demo:codex
```

These commands check setup, types and portable fixtures, then run an offline protocol demo. They do not use a model provider. Windows commands and remaining verification gaps are described in [Windows setup](windows.md).

## Reporting problems

Open an [issue](https://github.com/sleepingfreak94/forgemind/issues) with your OS, Node version, repository commit, reproducible steps, expected result and actual result. State whether observations came from a fixture or a real supervised run. Redact account details, credentials, tokens and private project content from logs and screenshots.

## Proposing changes

Read [the repository workflow](../AGENTS.md) and [the architecture](architecture.md), then keep your change focused on one problem. Work on a task branch or isolated worktree, preserve unrelated changes, and describe the behavior before and after your change.

Run checks appropriate to the change. `npm run verify:portable` covers the portable slice. Runtime and policy changes also need relevant focused tests and `npm test` on macOS; `npm run test:host` checks native host enforcement. Native suites require their documented prerequisites and must not fall back to unsandboxed execution. See [host enforcement](host-enforcement.md) and [execution limits](live-workflow.md).

Include the exact source identity, checks actually run, results and remaining gaps in your PR. Independent review is required by the repository workflow. Documentation changes should preserve the distinction between implemented features, fixture results, supervised observations and future goals. Do not add secrets or local runtime artifacts to Git.

## License

ForgeMind is distributed under the [MIT license](../LICENSE).
