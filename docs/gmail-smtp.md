# Trusted owner Gmail SMTP delivery

This module supplies an optional callback for the existing WeeklyDelivery outbox.
Creating it does not connect, authenticate, verify an account, enqueue, schedule,
or send. The email CLI still never sends. Account/passkey/app-password setup and
real acceptance require separate trusted owner actions and independent review.

## Owner API

Import from src/memory/gmail-smtp.ts:

- createGmailSmtpAdapter(options, resolveAppPassword, factory?) returns OwnerEmailAdapter.
- sendGmailSetupTest(options, stableTestId, resolveAppPassword, factory?) returns Promise<AdapterResult>.
- gmailSetupTestText is the exact constant setup subject and body.
- gmailMessageId(envelopeId) formats the deterministic weekly Message-ID.

GmailOwnerOptions contains only username, recipient and optional deadlineMs.
Username is the selected canonical lowercase @gmail.com mailbox and is also the
sole sender. Recipient uses the existing narrow canonical mailbox syntax.
deadlineMs is an integer1..30000, default20000. There is no endpoint, sender
override, credential, file path, arbitrary mail-content, proxy or logging option.

The trusted owner supplies resolveAppPassword(): string | Promise<string>.
It must return the16 lowercase ASCII app-password letters without UI display
spaces. A passkey/account password/OAuth token is not an app-password substitute.
This module never reads credentials from files, environment, argv or project/model
content. Secrets remain transient in process memory; immutable JS strings and
library copies cannot be reliably zeroized. Do not log resolver/factory arguments
or provider errors. Select/resolve the secret only in the private reviewed host.

The optional factory is a trusted in-process offline test seam, never untrusted
configuration. Production can omit it or use the guarded owner factory below. Its type GmailSmtpFactory and the lower-level
GmailSmtpRuntime test seam are exported from gmail-smtp-transport.ts.

The low-level createGmailSmtpTransport(connection, runtime?, beforeIo?) accepts a
synchronous trusted guard as its third argument. A private host can bind current
action capability/source/build/host/dependency/secret/config/consent checks with:

~~~ts
const factory = connection =>
  createGmailSmtpTransport(connection, undefined, synchronousCurrentOwnerGuard);
~~~

The guard runs before sendMail, immediately before native TLS connect and before
handing the verified socket to SMTP. A throw is sanitized, closes owned resources
and leaves uncertainty. Cleanup never needs renewed permission. This is admission
control; it cannot recall bytes already sent. The total deadline assumes trusted
callbacks do not block the JavaScript event loop indefinitely. The adapter passes
its original absolute monotonic expiresAt through the trusted connection options.
The transport caps it by its own deadlineMs budget and checks expiry before and
after each guard; credential resolution, factory work and slow guards cannot
restart or extend the deadline. Direct transport callers may omit expiresAt.

## Weekly integration

Use the current reviewed Sunday schedule. Configure only WeeklyDelivery's email
settings; do not reset the shared schedule or fabricate a run/history record.
After tick/recoverLatest, explicitly dispatch only the selected pending entry:

~~~ts
const adapter = createGmailSmtpAdapter(
  { username: privateConfig.username, recipient: privateConfig.recipient },
  trustedOwnerResolveAppPassword,
);
await delivery.dispatch(entry.envelope.id, {
  serviceId: ownerSelectedServiceBinding,
  recipient: privateConfig.recipient,
  consent: true,
}, adapter);
~~~

The owner still supplies current authority, consent, source/config checks and
service binding. The callback independently snapshots and canonically validates
the complete real EmailEnvelope using existing outbox/envelope/summary helpers,
including subject, exact serialized summary body, IDs/digests and recipient.
It never rewrites/truncates the summary. Message-ID is
<forgemind-weekly.ENVELOPE_ID@forgemind.invalid>.
Only the fixed sender, intended single SMTP envelope recipient, canonical subject
and message parts are passed to Nodemailer. The plain-text part is readable lines
followed by the exact canonical evidence JSON; the HTML part is rendered by
renderWeeklyEmail (weekly-email.ts) from the same validated summary. Content is
UTF-8/base64 MIME, with no attachments, alternatives, links, images, scripts,
remote content, Bcc/Cc, arbitrary headers or raw MIME input.
File and URL resolution are disabled at both transport and message levels.

WeeklyDelivery commits uncertain before the callback. This adapter never returns
not-accepted: failure, timeout, cancellation/closure or ambiguous results throw
only "Gmail SMTP result uncertain", preserving the durable uncertain state.
Accepted/uncertain entries are never automatically retried on restart. Message-ID
alone is not deduplication or exactly-once delivery.

## Labelled setup test

Setup is a separate explicit owner action, not a fabricated weekly envelope.
Its subject AND plaintext body are exactly:

ForgeMind delivery setup test. No project content included.

Before calling sendGmailSetupTest, the private owner host must durably/exclusively
claim a stable SHA256 hex test ID in a separate ledger/domain with current consent,
source/config/recipient/sender binding and fixed payload digest, default uncertain.
The API neither deduplicates nor writes a ledger; calling twice sends twice.
On unknown outcome retain the claim and do not replay. Its Message-ID is
<forgemind-setup.STABLE_TEST_ID@forgemind.invalid>, distinct from weekly IDs.
Pass the same options and app-password resolver as the adapter. No custom subject,
body, recipient list, summary or run is accepted. The host records sanitized
acceptance/uncertainty only; preserve the exact body hash independently.

## Transport and acceptance boundary

The only production endpoint is smtp.gmail.com:465 with implicit TLS,
certificate/hostname verification, TLS1.2 minimum and explicit SNI. Authentication
is PLAIN inside verified TLS, with no anonymous fallback. There is no pooling,
provider retry, alternate port/server, downgrade, STARTTLS fallback or proxy.
Connect/DNS/handshake are capped at10s, greeting5s, idle socket10s, each also
limited by the total deadline. SMTP response size is capped4096 and recipients1.
The total deadline includes credential resolution and MIME/send completion.
Late credential resolution cannot start a connection; late results cannot succeed.

Installed Nodemailer10.1.7 non-pooled SMTPTransport.close() only emits close and
releases OAuth listeners; Mail.close delegates to it. Therefore this implementation
owns the explicit TLS socket through getSocket and destroys it immediately on
deadline and cleanup, including during setup and after DATA. It also guards late
socket callbacks and accepts only one send per transport. Tests exercise actual
Nodemailer/MIME/SMTP state over an in-memory duplex peer; no real socket is opened.

Acceptance requires exactly the intended accepted recipient, empty rejected,
absent-or-empty pending (ordinary SMTP has no pending field), empty rejectedErrors
if present, exact returned sender/recipient envelope and Message-ID, and a bounded
single ASCII final DATA response250 2.0.0. Any other result stays uncertain.
SMTP acceptance is not inbox delivery. Provider response text is discarded.
The persisted receipt is a local deterministic gmail-smtp-ENVELOPE_ID marker
(or gmail-smtp-setup-TEST_ID), not a provider queue receipt.

See [official Nodemailer SMTP documentation](https://nodemailer.com/smtp) for
implicit TLS, timeouts and file/URL security controls. Installed source close
semantics were inspected independently of the docs. This component does not
configure an account, prove Gmail acceptance, install a timer or send by default.
