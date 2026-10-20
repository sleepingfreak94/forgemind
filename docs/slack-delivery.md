# Optional Slack weekly summaries

SlackDelivery is an independent destination for the existing WeeklySchedule. It requires no email recipient, SMTP setup or Teams configuration. Slack configuration/outbox keys are weekly-slack-config and weekly-slack:ID. Email behavior and Sunday 10:00 Asia/Kolkata scheduling are unchanged. Slack starts disabled; tick only generates/recovers/enqueues locally. No webhook, app, channel, account or timer is selected or activated here. SMTP remains deferred.

## Slack setup and message safety

An owner must create/select a Slack app, enable incoming webhooks, authorize the app and explicitly choose the destination channel. A modern incoming webhook is tied to that channel and identity; this feature supplies no channel, username or icon override. Keep its URL private. See [Slack incoming webhook setup](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).

Only the canonical standard endpoint shape https://hooks.slack.com/services/T.../B.../SECRET is supported. The first two segments require T/B plus uppercase letters/digits; the secret permits letters, digits, underscore and hyphen. No query, fragment, credentials, explicit port, percent encoding, alternate path/host, hostname alias or redirect is permitted. GovSlack is explicitly deferred.

The fixed payload contains only text, mrkdwn:false, parse:"none", unfurl_links:false and unfurl_media:false. link_names is omitted. Only the text value is escaped: & becomes &amp;, < becomes &lt;, and > becomes &gt;, in that order. Existing entity-like input is escaped again as literal input; the JSON payload itself is not HTML encoded. There are no blocks, attachments, actions, threads, channel overrides or summary-selected formatting fields.

Slack documents [escaping and disabling automatic parsing](https://docs.slack.dev/messaging/formatting-message-text/#disabling-automatic-parsing), and [markup and unfurl controls](https://docs.slack.dev/reference/methods/chat.postMessage/#formatting-messages). These controls and escaping prevent summary strings from becoming active mentions/markup or initiating link previews. Slack's normal notification policy for posting a message still applies; this does not promise silent delivery. Real tenant behavior remains unverified without a selected webhook.

The text is a fixed historical-evidence heading followed by canonical summary JSON. A complete summary is used if the final escaped/serialized payload fits maxBytes (4096..24576, default 24576). Otherwise a DIGEST label explicitly says it is not the full summary and that all examples were omitted. The complete digest JSON preserves counters, selection/cursor range, due date, dependency hashes and summary ID/digest; omittedExamples equals selectedRuns. Strings and JSON are never sliced. UTF-8 bytes, escaping expansion and outer JSON/control fields all count against the budget. The original validated summary remains in the private envelope for local inspection.

## Trusted owner API and private HTTP adapter

Import SlackDelivery from src/memory/slack-delivery.ts and createSlackWebhookAdapter from src/memory/slack-transport.ts. The factory accepts descriptor-safe plain data with required destinationId and webhookUrl, plus optional deadlineMs (10..30000, default 10000) and maxResponseBytes (0..16384, default 4096). It rejects unknown fields. No bearer token/OAuth acquisition is needed or implemented for this incoming-webhook path.

Only trusted owner application code may resolve the webhook from a private secret manager and create the adapter. Never resolve destinations or executable adapters from model output, summary data, project files, CLI flags or untrusted JSON. Do not log the resolver response, transport request, raw errors or webhook URL, include them in argv, or write them into envelopes/config/evidence. A separate host policy must authorize actual use of the selected webhook and disclosure of retained historical data.

The factory is inert. It returns a frozen opaque capability exposing only destinationId and endpointBinding. A WeakMap holds its private send closure; a JSON/spread copy is not a usable adapter. Binding is SHA-256 of a domain-separated exact canonical endpoint, including every channel/secret path segment. URL or destination changes require fresh configuration/consent; stale pending entries cannot send under another endpoint.

Example owner integration, with a resolver that is an external deployment dependency:

```js
import { SlackDelivery } from '/absolute/checkout/dist/src/memory/slack-delivery.js';
import { createSlackWebhookAdapter } from '/absolute/checkout/dist/src/memory/slack-transport.js';
const delivery = new SlackDelivery('/canonical/private/state', '/canonical/project');
try {
  // Trusted owner resolver; never log the returned {destinationId, webhookUrl}.
  const adapter = createSlackWebhookAdapter(await resolveSelectedSlackWebhook());
  // One-time explicit activation after disclosure consent:
  delivery.configure({ enabled: true, ...adapter, consent: true });
  delivery.schedule.configure(); // existing schedule, no OS job installation
  const result = delivery.tick(); // local enqueue only
  // Separate explicit owner-authorized send action:
  if (result.delivery.entry?.status === 'pending') {
    await delivery.dispatch(result.delivery.entry.envelope.id, { ...adapter, consent: true }, adapter);
  }
} finally { delivery.close(); }
```

Activation and send are shown together only to explain the API; keep them separate owner actions. A periodic sending host must not restore consent or enablement on every invocation. It resolves the already selected private adapter, checks current grants/config, and explicitly dispatches pending entries. Factory construction itself has no network effect. This repository does not supply/activate the deployment-specific secret resolver/owner host.

The native transport performs one HTTPS POST with rejectUnauthorized:true, fixed content-type and exact content-length, agent:false and at most 8192 response header bytes. It independently checks the supported endpoint, request budget and response budget. No redirect following, retries, proxy configuration or pooling is added. A total deadline covers connection/response wait and aborts the request. The body is streamed with a byte cap and compared byte-by-byte against exact ASCII ok; arbitrary response text is never retained or returned.

Acceptance requires a completed HTTP 200 with exactly two body bytes, ok. Slack documents the [normal acknowledgment and errors](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/#handling-errors). Any other status/body (including redirects, 429, error text, case/whitespace variations), oversized/aborted response, invalid callback result, timeout, interrupted request or lost acknowledgment remains uncertain. Accepted is transport acknowledgment evidence, not proof of reading, task completion or exactly-once delivery.

## Durable outbox and recovery

Configure exactly {enabled, destinationId:string|null, endpointBinding:string|null, consent:boolean, maxBytes?}. A configured destination requires both ID and binding and consent:true. To clear it, set both null and consent:false. The default is disabled/unconfigured. Destination IDs use the existing bounded owner identifier syntax. Slack configuration never changes the shared schedule or email/Teams config.

Each immutable envelope ID is domain-separated with projectId, canonical original root, due time, destination ID and endpoint binding. It contains the original validated summary, exact complete payload, mode and original budget. Existing entries preserve their first payload even if the current budget changes; a stricter current budget refuses an oversized pending payload instead of rewriting it.

OwnerStore provides canonical/private external SQLite storage, project/workspace scope isolation, schema/integrity checks and owner permissions. BEGIN IMMEDIATE serializes enqueue/claim changes across connections/processes. Before I/O, dispatch durably commits uncertain and increments attempts. An accepted acknowledgment is recorded separately afterward. A crash after claim or a failure saving acceptance stays uncertain. Another dispatcher/restart cannot replay accepted or uncertain entries; no reset/resend/purge API exists. Pending means no send attempt has been claimed. No network I/O holds a database transaction.

Current schedule enablement, current explicit consent, exact configured destination/binding, envelope binding and opaque adapter must all match before claiming. Disable stops future claims but cannot recall an in-flight request. Concurrent schedule changes fail closed; a later explicit local tick can recover safely. Local tick recovery is never a send retry.

tick recovers the retained latest summary before advancing scheduling and enqueues again after schedule commit. recoverLatest repairs a crash between schedule commit and enqueue without regenerating history. Independent advancement across multiple weeks before recovery is not backfilled; only the retained latest summary is targeted. No exactly-once guarantee spans SQLite and Slack.

## CLI preview and no-install macOS templates

The compiled CLI exposes config, status, preview, tick and outbox, with strict arguments, generic errors and no send, URL, token, recipient or adapter flags. It does not load adapters or enable/disable the shared schedule. Use trusted owner activation to enable scheduling for Slack without email.

```sh
node dist/src/local-runtime/slack-delivery-cli.js --help
node dist/src/local-runtime/slack-delivery-cli.js status --workspace /canonical/project --state-dir /canonical/private/state
node dist/src/local-runtime/slack-delivery-cli.js preview --workspace /canonical/project --state-dir /canonical/private/state
node dist/src/local-runtime/slack-delivery-cli.js config --workspace /canonical/project --state-dir /canonical/private/state --enable true --destination-id SELECTED_ID --endpoint-binding OWNER_DERIVED_SHA256 --consent true
node dist/src/local-runtime/slack-delivery-cli.js tick --workspace /canonical/project --state-dir /canonical/private/state
node dist/src/local-runtime/slack-delivery-cli.js outbox --workspace /canonical/project --state-dir /canonical/private/state --limit 20
node dist/src/local-runtime/slack-delivery-cli.js config --workspace /canonical/project --state-dir /canonical/private/state --enable false
```

All values are placeholders. Never place the webhook URL in endpoint-binding or any command argument. Config without a destination clears consent; enabled/unconfigured delivery reports pending-configuration when scheduling is enabled. Preview renders the retained summary without a destination. status/preview/outbox do not change application rows, enqueue or send; the inherited store constructor may initialize a new private SQLite store, so these are not filesystem read-only opens. Outbox returns deeply frozen entries, including accepted/uncertain, with bounded keyset pages (default 20, max 100; --after LAST_ID). Interrupted stdout does not undo commits; inspect/repeat local tick/outbox.

A future separately authorized launchd ProgramArguments template:

```json
["/absolute/node", "/absolute/checkout/dist/src/local-runtime/slack-delivery-cli.js",
 "tick", "--workspace", "/canonical/project", "--state-dir", "/canonical/private/state"]
```

An owner-selected StartInterval such as 900 seconds can invoke this enqueue-only operation. Existing scheduling computes Sunday 10:00 Asia/Kolkata regardless of host timezone and collapses missed weeks. No plist/job is created, loaded or started.

A separate owner-host argument vector could be ["/absolute/node", "/canonical/private/slack-owner-host.mjs", "--action", "dispatch-pending"]. That host is not supplied or loaded through this CLI. It must privately resolve the selected endpoint, enforce current grants/consent, avoid reactivation, page pending entries and explicitly call dispatch. Actual host installation, app authorization, channel selection, credentials and automatic sending remain separate owner activation work. No account access or messages occur here.

## Focused evidence and review

Slack tests use deliberately fake Slack-shaped credentials with injected offline transports and a fake native request/response seam. They never call Slack/network or install an app. Coverage includes endpoint allowlisting, TLS options, response body/status/bounds, deadline, escaping/format controls, digest budget, restart/crash gap, competing claims, storage corruption, plain-data descriptors, consent and email compatibility. Run compiled slack-*.test.js explicitly after build; shared test routing/manifests remain integration-owner scope. Full integration and independent security review follow this worker handoff.
