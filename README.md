# ForgeMind

## Project onboarding and visible plans

Use `npm run project:init -- --workspace /absolute/path/to/project --project-id project-a` to choose project-specific plan approval, draft PR and before/after evidence preferences. Add `--new` to scaffold missing draft PRD/SRS/ADR templates. `npm run project:plan` prepares a supplied plan; `npm run project:prepare` also onboards an unfamiliar project. See [workflow instructions](docs/project-workflow.md). Local document memory is available. Native execution and evidence delivery adapters have fixture coverage; live model requests remain blocked until subscription-only billing is enforceable. See [execution and evidence delivery](docs/live-workflow.md).

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

See [host enforcement](docs/host-enforcement.md) for assembly and limits. The offline protocol fixture and native Codex initialization pass under the real host. Live provider access and writable coding tasks are disabled, including the older `npm run harness -- "task"` launcher.

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
