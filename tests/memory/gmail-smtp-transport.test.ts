import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { Duplex } from 'node:stream';
import nodemailer from 'nodemailer';
import type { SendMailOptions, SMTPTransportOptions } from 'nodemailer';
import type { ConnectionOptions, TLSSocket } from 'node:tls';
import { createGmailSmtpTransport } from '../../src/memory/gmail-smtp-transport.js';
import type { GmailSmtpConnection, GmailSmtpRuntime } from '../../src/memory/gmail-smtp-transport.js';
import { createGmailSmtpAdapter } from '../../src/memory/gmail-smtp.js';
import { envelope } from '../../src/memory/weekly-delivery-envelope.js';
import { createWeeklyAccumulator, finishWeeklySummary } from '../../src/memory/weekly-summary.js';
import { resolve } from 'node:path';

const username = 'offline.owner@gmail.com', address = 'recipient@example.invalid', password = 'abcdefghijklmnop';
const connection = { username, appPassword: password, deadlineMs: 1000 };
const e = () => envelope(finishWeeklySummary(createWeeklyAccumulator({ projectId: 'project',
  originalRoot: resolve('/', 'project'), dueAt: 0, lowerExclusive: 0, upperInclusive: 0 })), address);
/** In-memory SMTP peer, never a listener, socket connection or network request. */
class Socket extends Duplex {
  authorized = true; encrypted = true; protocol = 'TLSv1.3'; remoteAddress = '127.0.0.1'; remotePort = 465;
  commands: string[] = []; mime = ''; private input = ''; private data = false;
  constructor(readonly flags: { noSecure?: boolean; noGreeting?: boolean; holdData?: boolean } = {}) {
    super();
    setImmediate(() => {
      if (this.destroyed || flags.noSecure) return;
      this.emit('secureConnect');
      if (!this.destroyed && !flags.noGreeting) this.push('220 offline.invalid ESMTP\r\n');
    });
  }
  getProtocol() { return this.protocol; }
  setTimeout(_ms: number, _cb?: () => void) { return this; }
  setNoDelay(_value?: boolean) { return this; }
  setKeepAlive(_value?: boolean) { return this; }
  _read() {}
  _final(callback: (error?: Error | null) => void) { callback(); this.push(null); }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.input += chunk.toString('utf8');
    const reply = (s: string) => queueMicrotask(() => { if (!this.destroyed) this.push(s + '\r\n'); });
    for (;;) {
      if (this.data) {
        const end = this.input.indexOf('\r\n.\r\n'); if (end < 0) break;
        this.mime = this.input.slice(0, end); this.input = this.input.slice(end + 5); this.data = false;
        if (!this.flags.holdData) reply('250 2.0.0 offline-accepted');
      } else {
        const end = this.input.indexOf('\r\n'); if (end < 0) break;
        const line = this.input.slice(0, end); this.input = this.input.slice(end + 2);
        this.commands.push(line.startsWith('AUTH ') ? 'AUTH PLAIN' : line);
        if (line.startsWith('EHLO ')) reply('250-offline.invalid\r\n250 AUTH PLAIN');
        else if (line.startsWith('AUTH PLAIN ')) reply('235 2.7.0 authenticated');
        else if (line.startsWith('MAIL FROM:')) reply('250 2.1.0 sender');
        else if (line.startsWith('RCPT TO:')) reply('250 2.1.5 recipient');
        else if (line === 'DATA') { this.data = true; reply('354 continue'); }
        else reply('500 unknown');
      }
    }
    callback();
  }
}
function harness(flags: ConstructorParameters<typeof Socket>[0] = {}, customize: (s: Socket) => void = () => {}) {
  let socket: Socket | undefined, smtp: SMTPTransportOptions | undefined, tls: (ConnectionOptions & { autoSelectFamily: false }) | undefined, opens = 0;
  const runtime: GmailSmtpRuntime = {
    connect(options) { opens++; tls = options; socket = new Socket(flags); customize(socket); return socket as unknown as TLSSocket; },
    createTransport(options) { smtp = options; const m = nodemailer.createTransport(options); m.on('error', () => {});
      return { sendMail: value => m.sendMail(value), close: () => m.close() }; }
  };
  return { runtime, get socket() { return socket!; }, get smtp() { return smtp!; }, get tls() { return tls!; }, get opens() { return opens; } };
}
test('real Nodemailer over in-memory TLS peer enforces fixed framing and preserves decoded plaintext exactly', async () => {
  const h = harness(), adapter = createGmailSmtpAdapter({ username, recipient: address }, () => password,
    options => createGmailSmtpTransport(options, h.runtime));
  assert.equal(h.opens, 0); const message = e(); assert.equal((await adapter(message)).status, 'accepted');
  assert.equal(h.opens, 1); assert.ok(h.socket.destroyed);
  assert.equal(h.smtp.host, 'smtp.gmail.com'); assert.equal(h.smtp.port, 465); assert.equal(h.smtp.secure, true);
  assert.equal(h.smtp.pool, false); assert.equal(h.smtp.forceAuth, true); assert.equal(h.smtp.authMethod, 'PLAIN');
  assert.equal(h.smtp.logger, false); assert.equal(h.smtp.debug, false); assert.equal(h.smtp.transactionLog, false);
  assert.equal(h.smtp.disableFileAccess, true); assert.equal(h.smtp.disableUrlAccess, true); assert.equal(h.smtp.maxRecipients, 1);
  assert.equal(h.smtp.maxResponseSize, 4096); assert.equal(h.smtp.connectionTimeout, 10000);
  assert.equal(h.smtp.greetingTimeout, 5000); assert.equal(h.smtp.socketTimeout, 10000);
  assert.equal(h.tls.host, 'smtp.gmail.com'); assert.equal(h.tls.port, 465); assert.equal(h.tls.servername, 'smtp.gmail.com');
  assert.equal(h.tls.rejectUnauthorized, true); assert.equal(h.tls.minVersion, 'TLSv1.2'); assert.equal(h.tls.autoSelectFamily, false);
  assert.equal(typeof h.tls.checkServerIdentity, 'function');
  assert.deepEqual(h.socket.commands.filter(s => s.startsWith('MAIL FROM:')), ['MAIL FROM:<' + username + '>']);
  assert.deepEqual(h.socket.commands.filter(s => s.startsWith('RCPT TO:')), ['RCPT TO:<' + address + '>']);
  assert.equal(h.socket.commands.filter(s => s === 'DATA').length, 1);
  const split = h.socket.mime.indexOf('\r\n\r\n'), headers = h.socket.mime.slice(0, split);
  assert.match(headers, /Content-Type: text\/plain; charset=utf-8/i); assert.match(headers, /Content-Transfer-Encoding: base64/i);
  assert.ok(!/^Bcc:|^Cc:|^Content-Disposition:/im.test(headers)); assert.ok(!/text\/html|multipart\//i.test(headers));
  assert.equal(Buffer.from(h.socket.mime.slice(split + 4).trim(), 'base64').toString('utf8'), message.body);
});
test('deadline destroys real owned socket after DATA even though non-pooled Nodemailer.close cannot do so', async () => {
  const h = harness({ holdData: true });
  const adapter = createGmailSmtpAdapter({ username, recipient: address, deadlineMs: 100 }, () => password,
    options => createGmailSmtpTransport(options, h.runtime));
  await assert.rejects(adapter(e()), { message: 'Gmail SMTP result uncertain' });
  assert.equal(h.opens, 1); assert.ok(h.socket.commands.includes('DATA')); assert.ok(h.socket.destroyed);
});
test('deadline also destroys an established TLS connection waiting forever for SMTP greeting', async () => {
  const h = harness({ noGreeting: true });
  await assert.rejects(createGmailSmtpAdapter({ username, recipient: address, deadlineMs: 30 }, () => password,
    options => createGmailSmtpTransport(options, h.runtime))(e()), { message: 'Gmail SMTP result uncertain' });
  assert.ok(h.socket.destroyed); assert.equal(h.socket.commands.length, 0); assert.equal(h.opens, 1);
});
for (const bad of ['unauthorized', 'TLSv1.1']) test('TLS peer rejected before SMTP auth: ' + bad, async () => {
  const h = harness({}, socket => { if (bad === 'unauthorized') socket.authorized = false; else socket.protocol = bad; });
  await assert.rejects(createGmailSmtpAdapter({ username, recipient: address }, () => password,
    options => createGmailSmtpTransport(options, h.runtime))(e()), { message: 'Gmail SMTP result uncertain' });
  assert.ok(h.socket.destroyed); assert.equal(h.socket.commands.length, 0);
});
test('connection/handshake timeout destroys pending socket; late TLS cannot resurrect I/O', async () => {
  const h = harness({ noSecure: true }), transport = createGmailSmtpTransport({ ...connection, deadlineMs: 10 }, h.runtime);
  const pending = transport.sendMail({ from: username, to: address, text: 'offline' });
  await assert.rejects(pending); assert.ok(h.socket.destroyed);
  h.socket.emit('secureConnect'); assert.equal(h.socket.commands.length, 0);
  transport.close(); await assert.rejects(transport.sendMail({ text: 'second' })); assert.equal(h.opens, 1);
});
test('close before Nodemailer requests a socket prevents all future connections and is idempotent', async () => {
  const h = harness(), transport = createGmailSmtpTransport(connection, h.runtime);
  transport.close(); transport.close(); await assert.rejects(transport.sendMail({ text: 'never sent' }));
  assert.equal(h.opens, 0);
});
test('owner transport options cannot replace endpoint, TLS, credentials, logging or deadline policy', () => {
  let touched = false;
  const h = harness(), getter = Object.defineProperty({ ...connection }, 'appPassword',
    { enumerable: true, get() { touched = true; return password; } });
  for (const raw of [getter, new Proxy(connection, {}), { ...connection, host: 'evil.invalid' }, { ...connection, port: 587 },
    { ...connection, tls: { rejectUnauthorized: false } }, { ...connection, logger: true }, { ...connection, deadlineMs: 30001 },
    { ...connection, deadlineMs: 0 }, { ...connection, expiresAt: NaN }, { ...connection, expiresAt: Infinity },
    { ...connection, expiresAt: -1 }, { ...connection, expiresAt: undefined }, { ...connection, appPassword: password + '\n' }, { ...connection, username: 'not-gmail@example.invalid' }])
    assert.throws(() => createGmailSmtpTransport(raw as GmailSmtpConnection, h.runtime),
      { message: 'Invalid private Gmail SMTP owner configuration' });
  assert.equal(touched, false); assert.equal(h.opens, 0);
});
test('transport setup errors are sanitized without fallback or raw secret reflection', async () => {
  let connects = 0;
  const transport = createGmailSmtpTransport(connection, {
    connect() { connects++; throw Error(password); },
    createTransport(options) {
      return { sendMail: () => new Promise((resolve, reject) => options.getSocket!(options, err => err ? reject(err) : resolve({}))),
        close() {} };
    }
  });
  await assert.rejects(transport.sendMail({ text: 'offline' }), { message: 'Gmail SMTP result uncertain' });
  transport.close(); assert.equal(connects, 1);
});

for (const denyAt of [1, 2, 3]) test('current owner guard denies SMTP admission phase ' + denyAt + ' without fallback', async () => {
  const h = harness(); let checks = 0;
  const adapter = createGmailSmtpAdapter({ username, recipient: address }, () => password,
    options => createGmailSmtpTransport(options, h.runtime, () => { if (++checks === denyAt) throw Error(password); }));
  await assert.rejects(adapter(e()), { message: 'Gmail SMTP result uncertain' });
  assert.equal(checks, denyAt);
  if (denyAt < 3) assert.equal(h.opens, 0);
  else { assert.equal(h.opens, 1); assert.ok(h.socket.destroyed); assert.equal(h.socket.commands.length, 0); }
});

for (const expireAt of [1, 2, 3]) test('expired total deadline denies guarded SMTP admission phase ' + expireAt, async t => {
  let now = 0, checks = 0;
  t.mock.method(performance, 'now', () => now);
  const h = harness();
  const adapter = createGmailSmtpAdapter({ username, recipient: address, deadlineMs: 30 }, () => password,
    options => createGmailSmtpTransport(options, h.runtime, () => { if (++checks === expireAt) now = 31; }));
  await assert.rejects(adapter(e()), { message: 'Gmail SMTP result uncertain' });
  assert.equal(checks, expireAt);
  if (expireAt < 3) assert.equal(h.opens, 0);
  else { assert.equal(h.opens, 1); assert.ok(h.socket.destroyed); assert.equal(h.socket.commands.length, 0); }
});
test('resolver and factory time consume the original deadline before socket admission', async t => {
  let now = 0, checks = 0;
  t.mock.method(performance, 'now', () => now);
  const h = harness();
  const adapter = createGmailSmtpAdapter({ username, recipient: address, deadlineMs: 30 },
    () => { now = 10; return password; },
    options => { now = 20; return createGmailSmtpTransport(options, h.runtime,
      () => { if (++checks === 2) now = 31; }); });
  await assert.rejects(adapter(e()), { message: 'Gmail SMTP result uncertain' });
  assert.equal(checks, 2); assert.equal(h.opens, 0);
});
test('supplied absolute deadline cannot extend the direct transport budget', async t => {
  let now = 0, checks = 0;
  t.mock.method(performance, 'now', () => now);
  const h = harness(), transport = createGmailSmtpTransport({ ...connection, deadlineMs: 30, expiresAt: 100000 },
    h.runtime, () => { if (++checks === 2) now = 31; });
  await assert.rejects(transport.sendMail({ text: 'offline' }), { message: 'Gmail SMTP result uncertain' });
  transport.close(); assert.equal(h.opens, 0);
});
