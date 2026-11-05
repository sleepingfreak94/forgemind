---
name: windows-e2e
description: Run a real ForgeMind task on the Windows VM (ssh host forgevm) at an exact commit, and collect its receipt, checks, review and PR as evidence. Use for Windows before/after evidence, or when the owner asks to test or run something on Windows or the VM.
---

# Windows VM end-to-end run

## The VM (as of 2026-11-05)
- SSH host `forgevm`, user `forgemind`, Windows 11 ARM. Commands run in `cmd.exe`.
- ForgeMind checkout: `C:\Users\forgemind\forgemind`. Sandbox host: `C:\Users\forgemind\fm-host2b`.
- Test project: `C:\Users\forgemind\e2e\forgemind-e2e-test`. Its origin is the private `sleepingfreak94/forgemind-e2e-test`, a throwaway repo.
- State: `C:\ForgeMind\state`. Worktrees: `C:\ForgeMind\worktrees`.
- Profiles: Claude `C:\Users\forgemind\.claude`, Cursor `C:\ForgeMind\cursor-profile`.
- Task files and run scripts are in `C:\Users\forgemind\`: `e2e-task*.json`, `e2e-*-run.cmd`, `e2e-*-reset.cmd`.

## Never
- Run a VM e2e while the full Mac suite runs: the VM shares the Mac's CPU.
- Point a run at any repository except the throwaway test project.
- Read, print or copy tokens. `gh auth status` is fine; `gh auth token` is not.
- Approve brain lessons that a test run proposes.

## 1. Sync the VM to the exact commit
`scripts/vm-sync.sh <local worktree> <base commit already on the VM> <branch>` bundles `<base>..<branch>`. On the VM it then fetches the bundle into a local ref, hard-resets the ForgeMind checkout to it (that checkout is disposable), checks the tree is clean, builds, and prints the commit. Quote that commit in the evidence.

## 2. Prepare the test project
- It must be clean as ForgeMind sees it. ForgeMind ignores the system git config, so a CRLF file written by `echo` looks dirty even when `git status` is clean. Edit files from the Mac and copy them over with scp, or rewrite them with `git -c core.autocrlf=false checkout -- <file>`.
- Use a fresh `taskId` for every run, because an existing worktree or task branch refuses the run. Clear leftovers with the matching reset script: `C:\Users\forgemind\e2e-*-reset.cmd`.
- Edit task JSON on the VM with PowerShell `ConvertFrom-Json` and `ConvertTo-Json`, written with `-Encoding ascii`.

## 3. Run it
- **No `gh` publication (local runs, Claude or Cursor):** use SSH with a real terminal. ForgeMind requires stdout to be a TTY, so output must not be redirected on the VM.
  `scripts/vm-run.sh 'C:\Users\forgemind\<script>.cmd' <capture file>`
  Run it in the background and wait for the notification. It keeps SSH stdin open, because Windows closes the terminal at stdin EOF. It stops at `EXIT=` and prints the cleaned output.
- **Draft PR runs:** use the owner's desktop session. `gh` keeps its token in Windows Credential Manager, and an SSH logon cannot read it (it gets a 401). Use a one-time interactive scheduled task:
  ```
  ssh forgevm "schtasks /create /tn ForgeMindE2EPR /tr C:\Users\forgemind\e2e-pr-run.cmd /sc once /st 23:59 /it /f && schtasks /run /tn ForgeMindE2EPR"
  ```
  - Then wait in the background for `C:\ForgeMind\state\<taskId>-*\artifacts\receipt.json`, polling every 20 s for up to 30 minutes in one background command.
  - Always finish with `schtasks /delete /tn ForgeMindE2EPR /f`.
  - This only works while the owner is logged in to the VM desktop.

## 4. Collect evidence
- Read the receipt and failure files:
  ```
  powershell -NoProfile -Command "$r = Get-Content <dir>\artifacts\receipt.json -Raw | ConvertFrom-Json; 'status=' + $r.run.status; $r.phases | % { $_.name + ': ' + $_.data }"
  ```
  Also read `failure.json`, `after-checks.json`, `review.json` and `candidate.patch` from the same folder.
- On GitHub: `gh pr view <n> -R sleepingfreak94/forgemind-e2e-test --json state,isDraft,headRefOid,files,commits,comments`.
- Report every run, including failed and retried ones, with its state directory. A model mistake that the checks rejected is evidence that the harness works. It is not a pass of the feature. If you change the task to avoid a model mistake, say why.

## Known pitfalls
- A `Cursor CLI failed` with `read ECONNRESET` in the plan phase was transient once. Run `windows-cursor.test.js` with `FORGEMIND_WINDOWS_CURSOR_REQUEST=1`, then retry once.
- `Expected base mismatch` means origin's default branch on GitHub lags the local base. The owner must push it from the desktop session.
- A fine-grained PAT needs the test repo listed, with Contents and Pull requests set to read and write.
