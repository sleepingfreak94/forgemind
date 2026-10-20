import nodemailer from 'nodemailer';
import { performance } from 'node:perf_hooks';
import type { SendMailOptions, SMTPTransportOptions } from 'nodemailer';
import { connect, checkServerIdentity } from 'node:tls';
import type { ConnectionOptions, TLSSocket } from 'node:tls';
import { dataSnapshot } from '../context-engine/validation.js';
import { recipient, shape } from './weekly-delivery-envelope.js';

export interface GmailSmtpConnection {
  readonly username: string;
  readonly appPassword: string;
  readonly deadlineMs: number;
  /** Absolute monotonic deadline from the adapter; trusted in-process use only. */
  readonly expiresAt?: number;
}
export interface GmailSmtpTransport {
  sendMail(message: SendMailOptions): Promise<unknown>;
  close(): void;
}
export type GmailSmtpFactory = (options: GmailSmtpConnection) => GmailSmtpTransport;
/** Trusted test seam only; never populated from a project, model, CLI or environment. */
export type GmailTlsOptions = ConnectionOptions & { autoSelectFamily: false };
export interface GmailSmtpRuntime {
  connect(options: GmailTlsOptions): TLSSocket;
  createTransport(options: SMTPTransportOptions): GmailSmtpTransport;
}
export function gmailUsername(value: unknown): asserts value is string {
  recipient(value);
  if (!/^[a-z0-9][a-z0-9.]*@gmail\.com$/.test(value)) throw new Error('Invalid private Gmail SMTP owner configuration');
}
export function gmailDeadline(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 30000)
    throw new Error('Invalid private Gmail SMTP owner configuration');
}
const uncertain = () => new Error('Gmail SMTP result uncertain');
const runtimeDefault: GmailSmtpRuntime = {
  connect: options => connect(options),
  createTransport: options => {
    const mailer = nodemailer.createTransport(options);
    // Provider errors must not become unhandled events or console diagnostics.
    mailer.on('error', () => {});
    return { sendMail: message => mailer.sendMail(message), close: () => mailer.close() };
  }
};
/** One connection/message only. close() destroys our socket, not merely Mail.close(). */
export function createGmailSmtpTransport(raw: GmailSmtpConnection,
  runtime: GmailSmtpRuntime = runtimeDefault, beforeIo: () => void = () => {}): GmailSmtpTransport {
  const started = performance.now();
  let config: GmailSmtpConnection;
  try {
    const value = dataSnapshot(raw);
    shape(value, Object.hasOwn(value, 'expiresAt') ? ['username', 'appPassword', 'deadlineMs', 'expiresAt'] :
      ['username', 'appPassword', 'deadlineMs']);
    if (Object.hasOwn(value, 'expiresAt') &&
        (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt < 0)) throw uncertain();
    gmailUsername(value.username); gmailDeadline(value.deadlineMs);
    if (typeof beforeIo !== 'function') throw uncertain();
    if (typeof value.appPassword !== 'string' || !/^[a-z]{16}$/.test(value.appPassword)) throw uncertain();
    config = value as unknown as GmailSmtpConnection;
  } catch { throw new Error('Invalid private Gmail SMTP owner configuration'); }
  const expiresAt = Math.min(started + config.deadlineMs, config.expiresAt ?? Infinity);
  const remaining = () => expiresAt - performance.now();
  const admit = () => {
    if (remaining() <= 0) throw uncertain();
    beforeIo();
    if (remaining() <= 0) throw uncertain();
  };
  let closed = false, used = false, opened = false, socket: TLSSocket | undefined;
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  let stopSetup: (() => void) | undefined;
  let mailer: GmailSmtpTransport | undefined;
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(setupTimer);
    try { stopSetup?.(); } finally {
      try { socket?.destroy(); } finally { mailer?.close(); }
    }
  };
  const options: SMTPTransportOptions = {
    host: 'smtp.gmail.com', port: 465, secure: true, pool: false,
    name: 'forgemind.invalid', auth: { type: 'login', user: config.username, pass: config.appPassword },
    authMethod: 'PLAIN', forceAuth: true, ignoreTLS: false, opportunisticTLS: false,
    tls: { servername: 'smtp.gmail.com', rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: Math.min(10000, config.deadlineMs), greetingTimeout: Math.min(5000, config.deadlineMs),
    socketTimeout: Math.min(10000, config.deadlineMs), dnsTimeout: Math.min(10000, config.deadlineMs),
    maxResponseSize: 4096, maxRecipients: 1, logger: false, debug: false, transactionLog: false,
    disableFileAccess: true, disableUrlAccess: true,
    getSocket(_options, callback) {
      if (closed || opened || remaining() <= 0) { callback(uncertain()); return; }
      opened = true;
      let done = false;
      const finish = (success = false) => {
        if (done) return;
        done = true; clearTimeout(setupTimer); stopSetup = undefined;
        if (success && !closed) { try { admit(); } catch { success = false; } }
        if (!success || closed) {
          socket?.destroy(); callback(uncertain());
        } else callback(null, { connection: socket!, secured: true });
      };
      stopSetup = () => finish();
      setupTimer = setTimeout(() => finish(), Math.max(1, Math.min(10000, remaining())));
      try {
        admit();
        socket = runtime.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com',
          rejectUnauthorized: true, minVersion: 'TLSv1.2', checkServerIdentity, autoSelectFamily: false });
        socket.on('error', () => finish());
        socket.once('close', () => finish());
        socket.once('secureConnect', () => finish(!closed && socket!.authorized === true &&
          ['TLSv1.2', 'TLSv1.3'].includes(socket!.getProtocol() ?? '')));
      } catch { finish(); }
    }
  };
  try { mailer = runtime.createTransport(options); }
  catch { close(); throw uncertain(); }
  return {
    sendMail(message) {
      if (closed || used) return Promise.reject(uncertain());
      used = true;
      try { admit(); return Promise.resolve(mailer!.sendMail(message)).catch(() => { throw uncertain(); }); }
      catch { return Promise.reject(uncertain()); }
    },
    close
  };
}
