# ForgeMind

## Project onboarding and visible plans

Use `npm run project:init -- --workspace /absolute/path/to/project --project-id project-a` to choose project-specific plan approval, draft PR and before/after evidence preferences. Add `--new` to scaffold missing draft PRD/SRS/ADR templates. `npm run project:plan` prepares a supplied plan; `npm run project:prepare` also onboards an unfamiliar project. See [workflow instructions](docs/project-workflow.md). Local document memory is available. Native execution and evidence delivery adapters have fixture coverage; supervised Codex execution requires explicit ChatGPT-plan sign-in and account-control review. See [execution and evidence delivery](docs/live-workflow.md).

## Supervised coding with your ChatGPT plan

ForgeMind can connect its coding pipeline to Codex on macOS using a separate **Sign in with ChatGPT** connection. This route uses OAuth authorization for ChatGPT plan usage; it never falls back to a paid API key. Native Codex remains sandboxed with local broker access only. ForgeMind validates and applies edits in an isolated worktree, runs baseline/candidate checks, and obtains review in a fresh invocation.

Connect from an owner terminal, using a private absolute directory outside every Git checkout:

```sh
npm run project:connect -- --connection /absolute/private/forgemind-account
npm run project:auth-status -- --connection /absolute/private/forgemind-account
```

Open the printed sign-in link in your browser and complete OpenAI's account selection and consent. This registers ForgeMind separately; it does not extract your existing Codex credentials. Tokens are kept in the protected account directory and are not sent to the worker. Expired credentials require reconnection in this first version. See the [official ChatGPT plan sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

Before running, open **ChatGPT → Settings → Usage** for that connected account and disable **Allow other apps to use credits after reaching your usage limit**. A Codex-only setting may not cover ForgeMind's separate connection. Disabling automatic credit purchases alone does not establish that existing credits cannot be spent. The first run asks for an owner acknowledgement naming the account. ForgeMind remembers it in private local state for that host, app/client, account and signed email, so subsequent runs and same-account token renewal do not ask again. There is no five-minute billing-confirmation expiry or confirmation every three requests. Credential expiry and task request/byte/time limits still apply. ForgeMind trusts that owner review and the server's setting; it cannot inspect the toggle automatically or impose its own hard credit cap. Leave execution blocked if you cannot verify the setting. [Official usage controls](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)

Run with a task manifest from the [execution guide](docs/live-workflow.md#task-manifest), an absolute canonical Codex 0.161.0 executable, and private run/worktree directories outside project source:

```sh
npm run project:run -- --workspace /absolute/project --task /absolute/task.json --connection /absolute/private/forgemind-account --codex /absolute/codex --state-root /absolute/private/runs --worktree-root /absolute/private/worktrees
```

On the first run for an unacknowledged account, the CLI displays the canonical connection directory, signed account email, subject, app/client ID and account fingerprint. Match the email to your browser account, review its server control, then enter the displayed `credits-disabled <account-fingerprint>` phrase once. Connections without a signed email remain blocked. It honors the project's plan-review preference. There is no noninteractive approval bypass, model/paid-account fallback, endpoint override or automatic replay. Missing authentication, denied initial acknowledgement, quota errors, token expiry and source drift stop execution. Requests without connection options still report blocked, exit 2, and create no execution worktree or provider request. API-key access has separate billing and is not used by this route. [Official authentication documentation](https://learn.chatgpt.com/docs/auth)

For UI tasks, a trusted host can configure automatic browser QA with `RunOptions.browserQa` or add `--browser-qa-config /private/browser-qa.json` to the complete run command. The callback runs after baseline and candidate checks; both source-bound reports, file hashes and durable artifact receipts are required before fresh review and publication. Baseline reports may reproduce a failure; candidate checks must all pass. Non-UI tasks remain compatible without the adapter. See [the host/report contract](docs/live-workflow.md#automatic-browser-qa-handoff). This implements automatic handoff; an installed, authorized host harness or supervised CUA session must provide actual observations. Synthetic command fixtures do not establish unattended browser capture.

Use `npm run project:inspect -- --workspace /absolute/project` for credential-free readiness inspection, and `npm run probe:live-native` for native conformance with synthetic local responses. Neither certifies your account's billing setting or live model quality. Real account sign-in, credit-disabled inference and quota-exhaustion behavior must be verified separately; passing fixture tests does not certify them. Current task checks are single-process, read-only and offline: Docker/Compose build/check profiles are not integrated. See [execution and evidence limits](docs/live-workflow.md).

REBOS acceptance verified the automatic QA handoff with supervised Chrome observations (32 candidate checks), validated cited stack-memory retrieval and stale-source rejection, and actual reviewed video delivery through the native GitHub helper. Watch [Before](https://github.com/sleepingfreak94/rebos/blob/0800ef42f6b7adfb85a5489df5f7258b1bf27cf1/before.mp4) / [After](https://github.com/sleepingfreak94/rebos/blob/0800ef42f6b7adfb85a5489df5f7258b1bf27cf1/after.mp4). The rendered frontend used explicitly synthetic read-only data, and the orchestration replay used scripted model responses with zero provider requests. See [the acceptance scope and remaining limits](docs/live-workflow.md#rebos-acceptance).

If you later enable connected-app credits or want ForgeMind to ask again, clear the saved acknowledgement:

```bash
node dist/src/local-runtime/live-cli.js billing-reset --connection /absolute/private/forgemind-account
```

Reset stops subsequent dispatches from existing sessions and requires acknowledgement on the next run. A different account, client, host or signed email also requires its own acknowledgement. The saved record contains fingerprints, a timestamp and a random review ID; it contains no tokens or email. It does not inspect or change OpenAI billing settings.


## Windows setup checks

After cloning, use PowerShell: `npm.cmd ci`, then `npm.cmd run verify:portable`. See [Windows instructions](docs/windows.md) for expected results and log capture. Portable fixtures have been checked on macOS; a Windows run is still needed. Native Windows authorization/sandbox execution remains unavailable and live coding stays disabled.

## Codex protocol demo

Run `npm run demo:codex` for the deterministic App Server stdio fixture. Run `npm test` for policy, context and driver checks. See [driver instructions](docs/codex-driver.md) for the optional native handshake probe and the required live-execution host gate.

## Cursor ACP adapter

The [Cursor adapter](docs/cursor-driver.md) now has deterministic ACP conformance tests and a subprocess fixture through the real offline host. Run `npm test` and `npm run test:host`. Native Cursor account/model execution remains unverified and disabled.

## Enforced offline host

Run the macOS native denial/lifecycle suite:

```bash
npm run test:host
```

Probe native Codex initialization through the durable policy and Seatbelt host:

```bash
npm run probe:host -- /absolute/path/to/codex
```

See [host enforcement](docs/host-enforcement.md) for assembly and limits. The offline protocol fixture and native Codex initialization pass under the real host. This offline host does not grant live provider access. Supervised coding uses the separate connection path above; the older `npm run harness -- "task"` launcher remains disabled.

## Ruflo development diagnostic

Inspect temporary MCP configuration without a coding session:

```bash
npm run harness -- --check
```

This diagnostic uses ambient development CLI configuration and is separate from the enforced application host. Ruflo is not a production dependency or globally registered MCP server. Local development state is ignored under `.askme-harness/`.

Project memory setup: [persist and retrieve project decisions](docs/project-memory.md). After initializing a project, use `npm run memory -- ingest --workspace /absolute/path/to/project`, inspect/validate candidates, then prepare plans with cited memory.

## This repository

ForgeMind’s project profile is registered in `config/forgemind-project.json` for [sleepingfreak94/forgemind](https://github.com/sleepingfreak94/forgemind). PRD and ADR documents already exist; a separate SRS has not been supplied. Project defaults show plans, retain text evidence and prepare draft PRs. Requested recordings require separate capture and review; delivery uses the selected project’s evidence branch.

Run `npm ci`, `npm run doctor`, and `npm test` after cloning. Node 26.7.0 or newer is required. To attach another project, pass its absolute path to `project:init`; do not change ForgeMind’s origin to the target project’s remote.

Historical `docs/artifacts/` links refer to local, unpublished validation evidence; raw runtime artifacts are excluded from this repository.
