# Optional Microsoft Teams weekly summaries

TeamsDelivery composes the existing WeeklySchedule as a destination independent of email. It requires no email recipient or SMTP configuration. Existing email behavior and the Sunday 10:00 Asia/Kolkata due calculation are unchanged. Teams delivery and scheduling start disabled. No real channel, workflow URL, account, provider or periodic job is selected here. SMTP remains deferred.

Use Microsoft Teams **Workflows**, with the **When a Teams webhook request is received** trigger, rather than a legacy Microsoft 365 Connector. The owner must configure the workflow to consume a JSON object with a text property and post it to the intended chat/channel. Microsoft documents this POST format in [Create Incoming Webhooks](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook#create-webhooks-using-workflows) (updated May 6, 2026). Tenant authentication requirements vary: this adapter supports a private URL plus an optional owner-supplied bearer token; it does not acquire/refresh tokens, negotiate authentication or establish tenant access. No billing/licensing assumptions are made.

Workflows belong to user owners, rather than to the team/channel. Configure appropriate co-owners, connections, authentication and workflow lifecycle separately. HTTP acceptance does not prove the workflow posted a message or that anyone read it. This implementation has offline fixture evidence only.

## Owner configuration and actual HTTP path

Trusted owner application code imports TeamsDelivery from src/memory/teams-delivery.ts and createTeamsWorkflowAdapter from src/memory/teams-transport.ts. The adapter factory takes exactly:

- destinationId: bounded owner-assigned ASCII identifier (letters, digits, underscore, hyphen).
- webhookUrl: privately resolved HTTPS workflow endpoint with a non-root path; no userinfo, fragment, whitespace or nonstandard port.
- bearerToken: optional private printable ASCII token, at most 8192 bytes.
- deadlineMs: optional total deadline, 10..30000 milliseconds, default 10000.
- maxResponseBytes: optional response body cap, 0..16384 bytes, default 4096.

The factory performs no I/O. Only dispatch invokes it. Resolve secrets through an explicitly trusted owner secret manager/host adapter; never load endpoint choices or executable adapters from summary/model output, project configuration, CLI flags or untrusted JSON. Trusted owner code must verify that the selected endpoint is the intended Microsoft Workflows endpoint and permitted by its network policy. The adapter does not discover/attest Microsoft ownership of arbitrary HTTPS hosts.

The returned frozen capability contains only destinationId and endpointBinding. A private WeakMap retains the send closure; a deserialized/spread copy cannot dispatch. endpointBinding is SHA-256 of a domain-separated canonical endpoint URL, including path and query. Neither the raw URL nor bearer token is persisted in delivery config, envelopes, outcomes, error text or receipt fields. Token rotation preserves binding; any endpoint URL change changes it. Keep the secret resolver and transport instrumentation private: never print their inputs or errors, serialize capabilities' closure state, or put secrets in argv, logs or evidence.

Example for a separately authorized owner host (the resolver shown is an owner integration dependency, not supplied by this repository):

```js
import { TeamsDelivery } from '/absolute/checkout/dist/src/memory/teams-delivery.js';
import { createTeamsWorkflowAdapter } from '/absolute/checkout/dist/src/memory/teams-transport.js';
// resolveSelectedWorkflow is trusted owner code; it returns the selected private
// {destinationId, webhookUrl, bearerToken?} in memory. Never log this object.
const delivery = new TeamsDelivery('/canonical/private/state', '/canonical/project');
try {
  const adapter = createTeamsWorkflowAdapter(await resolveSelectedWorkflow());
  // Initial activation only, after consent to disclose retained historical data:
  delivery.configure({ enabled: true, ...adapter, consent: true });
  delivery.schedule.configure(); // existing schedule, no OS timer installation
  const result = delivery.tick(); // durable local enqueue only
  // Separate explicit authorized send action:
  const entry = result.delivery.entry;
  if (entry?.status === 'pending') {
    await delivery.dispatch(entry.envelope.id, { ...adapter, consent: true }, adapter);
  }
} finally { delivery.close(); }
```

Do not repeat configure/activation automatically on every timer tick; doing so could restore consent after revocation. A sending host should resolve the currently selected private adapter and explicitly authorize each dispatch against the existing persisted consent/config. The code above shows activation and dispatch together for API clarity; they are separate owner actions. Activation and schedule configuration use separate durable transactions; inspect status after interruption.

The built-in transport uses Node HTTPS for one POST with content-type application/json and exact content-length. It does not follow redirects, retry, use a pooled agent, or capture response bodies/headers in public results. Request payloads are at most 24 KiB, response headers at most 8192 bytes, and response body bytes are counted while streaming and discarded. The total deadline aborts the request, including connection/response wait. Every completed 2xx is transport acceptance; non-2xx (including redirects, authentication failures and throttling), oversized/aborted responses, errors, malformed results and deadline expiry remain uncertain. There is no automatic retry, even for 429.

## Durable destination outbox and payloads

Separate OwnerStore keys are weekly-teams-config and weekly-teams:ID. Email keys, manifests, lockfiles and schema are unchanged. Store path isolation, canonical/private external storage, owner permissions, strict schema and integrity checks come from the existing OwnerStore.

Configure exactly {enabled, destinationId:string|null, endpointBinding:string|null, consent:boolean, maxBytes?}. A configured destination requires both ID and binding with consent true. Clearing it requires both null and consent false. Consent must cover disclosure of the retained historical summary, not just newly generated work. Disabling Teams changes only its config; it never disables or reconfigures the shared schedule/email configuration. The owner may disable email separately when selecting Teams instead.

Each envelope ID includes a separate Teams domain, project, canonical original root, due time, destination ID and endpoint binding. It contains the validated original summary plus the immutable, complete JSON payload, its mode and original payload budget. Existing IDs retain their first payload/budget even if the config budget changes. A stricter current budget refuses an oversized pending payload rather than rewriting it.

The payload is fixed {text:"..."} framing followed by canonical JSON. If the complete historical summary fits the configured payload budget, the mode is full-summary. Otherwise the mode is digest and the visible label says DIGEST (not the full summary; examples omitted). The digest retains counters, evidence hashes, selection, cursor range, due date and summary ID/digest; it omits all examples and explicitly reports that omission. JSON is never sliced; escaped JSON/UTF-8 bytes including outer framing count against the limit. maxBytes is 4096..24576, default 24576. No user-controlled message formatting, recipients, card actions or endpoint fields are interpreted.

BEGIN IMMEDIATE serializes enqueue and dispatch claims across connections/processes. Before leaving storage, dispatch commits uncertain and increments attempts. A concurrent dispatcher sees uncertain and cannot resend. Crash after claim, timeout, lost acknowledgment or failure to save acceptance remains uncertain after restart, with no reset/resend API. Accepted entries also cannot replay. There is no exactly-once guarantee across SQLite and Teams. Deduplication entries are retained indefinitely.

Current schedule enablement, current consent and exact destination/binding must match both the envelope and the opaque adapter before claiming. Changing either destination or URL cannot send stale pending entries. In-flight requests cannot be recalled by disable. No network operation holds a database transaction.

tick repairs the retained latest summary before advancing the schedule, then repairs/enqueues after schedule commit. Recovery never regenerates historical summaries. If another caller advances scheduling through several weeks without Teams recovery, only the latest retained result is recovered; no historical backfill policy is supplied. Shared schedule configuration must remain compatible across destinations.

## Local CLI and read-only preview

Build using the established owner build. The standalone compiled CLI has strict parsing, generic redacted errors and no send/URL/token/adapter arguments. It neither enables nor disables the shared schedule. A trusted host must explicitly enable the existing schedule when activating Teams without email.

```sh
node dist/src/local-runtime/teams-delivery-cli.js --help
node dist/src/local-runtime/teams-delivery-cli.js status --workspace /canonical/project --state-dir /canonical/private/state
node dist/src/local-runtime/teams-delivery-cli.js preview --workspace /canonical/project --state-dir /canonical/private/state
node dist/src/local-runtime/teams-delivery-cli.js config --workspace /canonical/project --state-dir /canonical/private/state --enable true --destination-id SELECTED_ID --endpoint-binding OWNER_DERIVED_SHA256 --consent true
node dist/src/local-runtime/teams-delivery-cli.js tick --workspace /canonical/project --state-dir /canonical/private/state
node dist/src/local-runtime/teams-delivery-cli.js outbox --workspace /canonical/project --state-dir /canonical/private/state --limit 20
node dist/src/local-runtime/teams-delivery-cli.js config --workspace /canonical/project --state-dir /canonical/private/state --enable false
```

Placeholders must be replaced by the owner; never substitute the webhook URL for the binding. Config without destination clears consent and reports pending-configuration when enabled. status, preview and outbox do not mutate application rows or enqueue/dispatch. Opening a new owner store may initialize its private SQLite storage using existing constructors; these commands are not filesystem read-only. preview renders the retained summary without a destination. outbox pages immutable exact entries, including accepted/uncertain, at most 100 per call (default 20); use --after LAST_ID for keyset pagination. Interrupted stdout cannot undo commits: repeat tick/outbox to recover.

## macOS periodic invocation template (no installation)

For a future separately authorized launchd job, use absolute argument vectors and private owner-managed logs. A template ProgramArguments value is:

```json
["/absolute/node", "/absolute/checkout/dist/src/local-runtime/teams-delivery-cli.js",
 "tick", "--workspace", "/canonical/project", "--state-dir", "/canonical/private/state"]
```

An owner can choose a StartInterval such as 900 seconds; the existing schedule computes Sunday 10:00 Asia/Kolkata and collapses missed weeks. A macOS local-time calendar trigger is unnecessary. The job enqueues only and requires prior schedule/destination activation. No plist is installed, loaded or started by this feature.

A separate owner-host invocation template is ["/absolute/node", "/canonical/private/teams-owner-host.mjs", "--action", "dispatch-pending"]. That host is a deployment-specific trusted component, not an adapter-loading option in this CLI. It must resolve the already selected workflow privately, enforce current grants/consent, page pending entries only, and call dispatch explicitly. Do not pass URLs or tokens as arguments/environment dumps, log resolver responses, infer a workflow from project data, or reactivate disabled config from the job. Actual automatic sending/host installation requires separate owner activation with a selected workflow; none is provided/activated here.

## Verification and limits

Teams tests inject non-routable fixture endpoints and fake transports, including a fake native request/response stream. They cover real adapter framing/bounds, explicit consent, endpoint changes, durability, deduplication, concurrency, corrupt/descriptor boundaries, digest labeling and email compatibility without network calls or external messages. Run the compiled teams-*.test.js files explicitly; shared test routing belongs to integration. Independent review and real tenant/workflow compatibility are still required. No live Teams acceptance or message delivery is claimed.
