# Windows clone verification

Start with native Windows and PowerShell for setup and deterministic fixture testing. The portable checks are implemented; actual Windows execution has not been verified on this macOS development machine. Native Windows authorization and an enforced sandbox host are still pending, so live coding remains disabled.

## After cloning

Install Git and Node 26.7.0 or a newer compatible 26.x release, then open PowerShell in the cloned repository. See the [official Node downloads](https://nodejs.org/en/download). No Codex/Cursor installation or account login is needed for these checks.

```powershell
git clone <repository-url>
Set-Location forgemind
npm.cmd ci
npm.cmd run verify:portable
```

Replace `<repository-url>` with the published Git remote and use the actual clone folder name. `npm.cmd` invokes the Windows command shim directly without requiring a change to PowerShell's script execution policy. The current local checkout has no remote or commit yet; it must be published before the clone step is available.

The verification command runs the read-only setup doctor, TypeScript checking, compilation, context-engine tests and deterministic Codex/Cursor protocol tests. Test files are enumerated explicitly and passed to Node with no shell glob dependency. HTTP compression tests use synthetic loopback fixtures; no external model/provider traffic is issued.

Expected doctor fields on Windows:

```json
{
  "platform": "win32",
  "nodeSupported": true,
  "dependenciesInstalled": true,
  "sqliteAvailable": true,
  "portableSetupReady": true,
  "localPolicyIdentityAvailable": false,
  "hostBackend": "unimplemented",
  "hostPrerequisitesPresent": false,
  "hostVerified": false,
  "liveCodingEnabled": false
}
```

`portableSetupReady` reports prerequisites; the subsequent test exit code establishes fixture results. `hostVerified` stays false even on macOS because a diagnostic cannot certify sandbox enforcement.

To save results for follow-up:

```powershell
New-Item -ItemType Directory -Force docs/artifacts | Out-Null
npm.cmd run verify:portable 2>&1 | Tee-Object -FilePath docs/artifacts/windows-verification.txt
$verificationExit = $LASTEXITCODE
Write-Output "Verification exit code: $verificationExit"
```

An exit code of zero means the selected portable checks passed. These logs contain fixture output and setup metadata, not account credentials.

## Commands and boundaries

| Command | Native Windows behavior |
| --- | --- |
| `npm.cmd run doctor` | Reports setup readiness and unavailable host capabilities |
| `npm.cmd run typecheck` / `npm.cmd run build` | Compiles the TypeScript code |
| `npm.cmd run test:portable` | Runs deterministic context/driver and verification checks |
| `npm.cmd run demo:context` | Demonstrates a synthetic canonical packet |
| `npm.cmd run demo:codex` | Demonstrates an unsandboxed synthetic Node protocol server, no native Codex |
| `npm.cmd test` | Rejects the full suite because its real policy fixtures require POSIX identity |
| `npm.cmd run test:host` | Rejects; the implemented host requires macOS Seatbelt |
| `npm.cmd run harness -- "task"` | Rejects live coding before resolving an agent |

The POSIX policy and macOS host suites remain separate required checks on their supported platforms. Portable success does not replace them. The legacy ambient `harness --check` diagnostic is outside this Windows verification path.

WSL2 is not required for these fixtures. Its Linux environment does not supply macOS Seatbelt, and no Linux enforced host is implemented here. It is therefore not a shortcut to live harness execution.

## Native Windows execution follow-up

The portable [project onboarding/planning CLI](./project-workflow.md) is also available through `npm.cmd run project:init`, `npm.cmd run project:plan` and `npm.cmd run project:prepare`. It stores preferences/draft documents and prepares workflows without native identity, execution grants or provider calls. Actual Windows execution remains to be verified on a Windows machine.

Implement SID-based identity and private ACL-protected policy/artifact storage; explicit handling of reparse points, alternate data streams and device paths; a default-deny process/filesystem/network boundary; and independently supervised process-tree shutdown with durable evidence. Then test denied reads/writes/network, revocation, fencing, cancellation and restart recovery on Windows.

The chosen backend is [ADR-0017](./adr/ADR-0017-windows-appcontainer-sandbox.md): an owner-built launcher that runs a command in a fresh [AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) inside a kill-on-close [Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects). Phase 1a (the launcher, `src/host-enforcement/windows-sandbox.ts` and its tests) is implemented. Runs don't use it yet, so live coding and checks are still refused on Windows. Existing credential, egress, spend and write gates still apply to both drivers.

## Windows sandbox tests

In an elevated PowerShell (setup needs administrator once):

```powershell
New-Item -ItemType Directory -Force $env:USERPROFILE\forgemind-owner | Out-Null
npm.cmd run build:windows-launcher -- $env:USERPROFILE\forgemind-owner
$env:FORGEMIND_WINDOWS_LAUNCHER = "$env:USERPROFILE\forgemind-owner\forgemind-sandbox.exe"
$env:FORGEMIND_WINDOWS_LAUNCHER_SHA256 = '<sha256 printed by the build>'
node --test dist\tests\host-enforcement\windows-sandbox.test.js
```

Without the two variables, the contained tests are skipped and only the portable ones run. The launcher's digest is pinned before every run. Rebuild it and update the digest after any change to `sandbox-launcher.cs`.
