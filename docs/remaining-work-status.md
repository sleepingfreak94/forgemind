# Remaining-work implementation

This follow-up starts from merged PR24, Git78621235a86b4bab5fb6b351f9dd2d094b8f8431. The original [partial delivery](backlog-execution-status.md) and [failure index](backlog-execution-bugs.md) are historical records.

## Implemented behavior

- [Child output retention](child-output-retention.md): the supervisor waits for both output streams to finish before terminal IPC/exit, with bounded cleanup. A controlled slow-reader reproduction retained short output before repair and exact bytes afterward. This fixes the reproduced early-exit failure mode; the historical missing raw result does not establish its original cause.
- [Local embeddings](local-embeddings.md): the optional pinned CPU provider validates native path components and retains runtime/model pins, canonical paths, ownership and child permissions. Unsupported ownership fails closed. A trusted local cache must be explicitly configured; no model is downloaded or globally enabled. Native dependencies remain trusted owner code.
- [Teams](teams-delivery.md) and [Slack](slack-delivery.md): optional destination-specific private outboxes require no email recipient. Each needs destination binding and consent. Trusted owner adapters protect webhook secrets and bound HTTP requests; unknown outcomes never replay automatically. CLI preview/tick never sends. Oversized summaries produce an explicitly labelled structured digest.
- The intentionally nonprivate embedding configuration fixture explicitly sets its mode, preserving the rejection assertion under restrictive caller umasks. This fixture correction changes no production validation.

Final verification and independent review must bind the reconciled source/build. Actual check results and hosted CI belong in the task PR and private owner receipts. Component observations cannot replace final integration checks or live delivery evidence.

## Preserved earlier CI evidence

[PR24 portable CI](https://github.com/sleepingfreak94/forgemind/actions/runs/39279973946) passed: Ubuntu390/0skips; Windows354/36platform-specific skips. These actual original job-log counts cover PR24 head09c3bcb, not this follow-up. Portable checks do not certify native Windows/Linux enforcement.

## Still dependent on owner or external state

B024 remains unresolved. Its retained attempt failed during native request/stream handling before tools, without a proven local cause. The follow-up offline account-status check could not validate a usable connection; that collapsed status does not distinguish missing, expired or invalid state. No account reset, fabricated acknowledgement, provider switch or blind retry is performed. Restore the established owner connection before a bounded exact-source read-only canary. Native live qualification remains incomplete until actual evidence succeeds.

Real delivery requires a selected registered project/private state, Teams workflow or Slack workspace/channel webhook, destination consent and private authentication. No real message or OS job is sent/installed here. Follow the [activation checklist](weekly-activation-checklist.md). Service ownership/access cannot be inferred from email. HTTP acceptance is distinct from confirmed message display.

Local organization controls already exist. Actual organization labels, member roles, project grants and source approvals need explicit owner choices; no members are invented. Local labels are owner assertions, not remote authentication.

SMTP, Cursor integration and native Windows/Linux enforcement remain deferred. Scheduling remains Sunday10:00 Asia/Kolkata. Changing it needs a validated schedule change. Local jobs require host availability and collapse missed weeks instead of backfilling every historical week.

## Bug accounting and evidence

M2/M2-R1 and LOG-A1 retain their old two-attempt histories and used at most two newly authorized repairs each; neither budget is reset. Original failures and frozen worker candidates remain. The distinct umask fixture finding records its reproduced failure and one scoped correction. Construction, fixture and helper failures remain in private attempt ledgers.

Blocking findings prevent the affected slice from publication. Final independent review and task-scoped draft PR creation do not authorize merging, release or native runtime promotion.
