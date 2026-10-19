# Native run prevention and validation

This change implements admission and evidence controls for all supported native
entry points. B024 provider diagnosis is a separate task. No provider retry,
account repair, runtime promotion, Cursor integration, native Windows/Linux
enforcement or higher budget is authorized by these controls.

## Before and after

Baseline Git parent: `cd3d7cbc57f63e17ed4d999042d6e073ca45769e`.
The repaired followup snapshot imported as this task's baseline is
`1d5c09e0db7def411b6ebf700a0fb2d7041c898ab452cc35036381b8445ff9a5`.
Its frozen checkout and failed review attempts remain untouched.

| Scenario | Starting behavior | Candidate behavior |
| --- | --- | --- |
| Full suite with missing fixture selectors | Fixture setup reached workers before useful prerequisite failure | Both reviewed versions are checked before discovery/dispatch |
| Host/portable/doctor/typecheck | Prior control logic over-required native fixture selectors | No fixture selectors required for those checks |
| 230,689-byte review packet | Packet failed during launch admission | Offline preflight returns packet-too-large before account/state access |
| Exact UTF-8 packet boundary | Packet creation and admission did not share an encoder | One encoder/loader tests 65,536 acceptance and 65,537 rejection |
| Callable native task | No common admission report or durable selected capture | Shared preflight, assembled input check, private capture before account preparation |
| Managed CLI | Manual terminal capture/handoff could diverge | Fixed worker receives expected file digest and parent binding; both raw copies exist before spawn |
| Provider other/unknown | Three-field sanitized diagnostic only | Same public diagnostic plus private, bounded event/parse/tool context |
| Capture or terminal persistence failure | Resume evidence or single-settlement certainty could be lost | One settlement attempt; independent small Markdown fallback and explicit incompleteness |

Baseline observations for the first admission failures are preserved in the
existing followup control receipts. New E1–E3 findings were static code-path
proofs against the first integrated candidate, not executed security exploits.
The [failure ledger](native-prevention-failures.md) distinguishes these facts.

## Reproducible validation

1. Build and run focused tests for native preflight, CLI preflight, prerequisites,
   managed terminal capture, failure context, callable runner and qualification.
2. Run `npm run verify:portable` without either Codex fixture selector.
3. Run `npm test` with explicit owner-installed reviewed 0.161.0 and 0.162.1
   selectors as described in [contributing](contributing.md).
4. Run `npm run test:host` on macOS without either selector. This tests existing
   host enforcement, not a new Cursor integration or Windows/Linux qualification.
5. Exercise the managed PTY under an actual outer owner TTY with an offline
   synthetic worker. Verify child TTYs, capture creation before spawn, exact raw
   copies/hashes and preserved exit status. This proves launcher mechanics only.
6. Freeze source/build hashes and give an independent reviewer the full diff,
   before/after evidence and actual test receipts. Re-review affected changes.

Commands and complete results are source-bound in private owner-policy receipts.
The PR handoff reports checks actually completed and the exact candidate source;
this checklist does not itself claim those checks ran. Test groups overlap and
must not be added together. No offline fixture establishes provider availability,
billing limits, live inference success or native runtime promotion.

A stopped run is not automatically replayed. Preserve JSON/captures and Markdown,
fix one recorded issue in a fresh guarded scope, run its focused check, then
resume independent validation from the saved checkpoint.
