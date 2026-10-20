# Activate weekly summaries and local sharing

Weekly summaries can use the private email outbox, Microsoft Teams or Slack. SMTP integration is deferred. Choose the destination per registered project; an email address does not identify a Teams tenant or local organization member.

## Select the project and destination

Use a registered project with its canonical workspace and canonical owner-private state outside every Git checkout. Confirm the reviewed source/build and applicable owner action grants. Inspect the retained historical summary before consenting to disclose its selected content.

For Teams, follow [Teams delivery](teams-delivery.md). The owner selects a Microsoft Teams Workflows webhook for the intended team/channel, chooses a stable destination ID, and resolves its private URL and required token inside trusted owner application code. Store secrets through an approved private mechanism; keep them out of repository files, CLI arguments, model prompts, public receipts and chat. The supplied transport does not acquire tenant tokens or establish workflow access.

For Slack, follow [Slack delivery](slack-delivery.md). The owner selects an incoming webhook for the intended workspace/channel and resolves its secret URL privately. The supported standard Slack endpoint is bound to that chosen channel. Do not put the URL in CLI arguments, model output, repository files, logs or chat. No app installation or workspace access is inferred.

Configure the adapter destination ID and endpoint binding with explicit consent and payload budget. Enable the shared weekly schedule explicitly from the owner host. Inspect status and a preview, then tick and inspect the outbox. Tick queues locally; sending is a separate owner-authorized dispatch with the matching opaque adapter. Destination changes require fresh explicit configuration. Never automatically replay an accepted or uncertain entry.

For email, retain [email outbox](weekly-delivery.md) behavior. Gmail SMTP setup is postponed; no password, OAuth flow or mailbox send is needed to verify local queueing or Teams.

## Schedule and verify

The due-time contract is Sunday 10:00 Asia/Kolkata. A separately installed macOS owner job can invoke the documented tick command periodically, with absolute ProgramArguments and private logs. Tick computes the due week and deduplicates concurrent/restarted calls. A trusted owner-host job separately resolves the selected adapter and dispatches pending entries under current grants. The repository CLI does not load arbitrary adapters or send messages.

Inspect the job definition before installation. Set bounded runtime, overlap handling, private paths and a disable/remove procedure. Local scheduling requires the machine and relevant user session to be available; document sleep/offline behavior. Missed weeks collapse to the latest retained due result; historical backfill is not supplied. Changing day/time/time zone needs a separately validated schedule change.

Before ongoing delivery, verify one labelled test: preview, due tick, one dispatch, server acceptance, restart without duplicate, and disable preventing later claims. Server acceptance is not proof of display or mailbox receipt; record delivery only if confirmed. Unknown outcomes stay uncertain for reconciliation. Use controlled clocks for due/not-due tests, without changing the system clock.

No real destination or owner job is activated by this runbook. Project, channel, workflow access and private authentication remain owner inputs.

## Configure local organization sharing

Follow [local organization sharing](local-organization-sharing.md). Obtain the organization label, owner-managed member labels, roles, per-project grants and source-record approvals. Sharing stays disabled until these choices are explicit. A local member label is an owner assertion, not remote authentication.

Use the existing owner CLI/API with private state. Verify allowed/denied reads, another-project denial, removal/revocation, restart persistence and source invalidation. Re-adding a member or restoring source bytes must not resurrect an invalidated copy. Previously returned bytes cannot be recalled.

Do not infer membership from Gmail, Git authors, the OS account or model output. Actual grants remain pending owner choices. Native Windows/Linux enforcement and Cursor integration remain deferred.
