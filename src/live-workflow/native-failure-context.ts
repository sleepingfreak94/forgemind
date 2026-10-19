import { types } from 'node:util';

const nativeErrorKinds = [
  'contextWindowExceeded','sessionBudgetExceeded','usageLimitExceeded','rateLimitExceeded',
  'flexUnavailable','serverOverloaded','cyberPolicy','misalignmentPolicyViolation','tooManyDenials',
  'internalServerError','unauthorized','badRequest','threadRollbackFailed','sandboxError','other',
] as const;
const nativeHttpErrorKinds = [
  'httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts',
] as const;
export type NativeErrorKind = typeof nativeErrorKinds[number] | typeof nativeHttpErrorKinds[number] | 'activeTurnNotSteerable' | 'unknown';
export interface NativeProviderDiagnostic {
  readonly kind: NativeErrorKind;
  readonly httpStatusCode: number | null;
  readonly willRetry: boolean | null;
}
export interface NativeFailureContext {
  readonly schemaVersion: 1;
  readonly origin: 'error-notification' | 'turn-completed' | 'unspecified';
  readonly parseStatus: 'recognized' | 'provider-other' | 'missing' | 'unrecognized';
  readonly nativeCliVersion: '0.162.1';
  readonly lastTool: 'host_read' | 'host_apply' | 'host_check' | null;
}

/** Reject proxies before reflection, then accept only plain own data properties. */
function dataRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== 'object' || types.isProxy(raw)) return null;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const value: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return null;
    const descriptor = descriptors[key]!;
    if (!Object.hasOwn(descriptor, 'value')) return null;
    value[key] = descriptor.value;
  }
  return value;
}

/** Inputs are sanitized even for the internal event capturer; raw values never survive. */
export function createNativeFailureContext(parseStatus: NativeFailureContext['parseStatus'], trustedContext?: unknown): Readonly<NativeFailureContext> {
  const context = dataRecord(trustedContext);
  const origin = context?.origin;
  const lastTool = context?.lastTool;
  return Object.freeze({
    schemaVersion: 1,
    origin: origin === 'error-notification' || origin === 'turn-completed' ? origin : 'unspecified',
    parseStatus: parseStatus === 'recognized' || parseStatus === 'provider-other' || parseStatus === 'missing' ? parseStatus : 'unrecognized',
    nativeCliVersion: '0.162.1',
    lastTool: lastTool === 'host_read' || lastTool === 'host_apply' || lastTool === 'host_check' ? lastTool : null,
  });
}
function parseDiagnostic(raw: unknown): {kind: NativeErrorKind; httpStatusCode: number | null; parseStatus: NativeFailureContext['parseStatus']} {
  let kind: NativeErrorKind = 'unknown', httpStatusCode: number | null = null;
  let parseStatus: NativeFailureContext['parseStatus'] = 'unrecognized';
  if (raw === null || raw === undefined) return {kind, httpStatusCode, parseStatus: 'missing'};
  const error = dataRecord(raw);
  if (!error) return {kind, httpStatusCode, parseStatus};
  const info = error.codexErrorInfo;
  if (info === null || info === undefined) return {kind, httpStatusCode, parseStatus: 'missing'};
  if (typeof info === 'string' && (nativeErrorKinds as readonly string[]).includes(info)) {
    kind = info as NativeErrorKind;
  } else {
    const value = dataRecord(info), keys = value ? Object.keys(value) : [];
    if (keys.length === 1) {
      const key = keys[0]!, detail = dataRecord(value![key]);
      if (detail && (nativeHttpErrorKinds as readonly string[]).includes(key)) {
        const status = detail.httpStatusCode;
        if (status === null || status === undefined) kind = key as NativeErrorKind;
        else if (Number.isSafeInteger(status) && (status as number) >= 0 && (status as number) <= 65535) {
          kind = key as NativeErrorKind; httpStatusCode = status as number;
        }
      } else if (detail && key === 'activeTurnNotSteerable') kind = key;
    }
  }
  if (kind !== 'unknown') parseStatus = kind === 'other' ? 'provider-other' : 'recognized';
  return {kind, httpStatusCode, parseStatus};
}
// Only constructor-produced immutable facts are eligible for receipts.
const providerDiagnostics = new WeakMap<object, Readonly<NativeProviderDiagnostic>>();
const providerContexts = new WeakMap<object, Readonly<NativeFailureContext>>();
/** Remote text is deliberately never assigned to Error.message, cause or receipts. */
export class NativeProviderError extends Error {
  readonly diagnostic: Readonly<NativeProviderDiagnostic>;
  constructor(rawError: unknown, willRetry: unknown, trustedContext?: unknown) {
    const {kind, httpStatusCode, parseStatus} = parseDiagnostic(rawError);
    super('Native provider failure: ' + kind);
    this.name = 'NativeProviderError';
    this.diagnostic = Object.freeze({kind, httpStatusCode, willRetry: typeof willRetry === 'boolean' ? willRetry : null});
    providerDiagnostics.set(this, this.diagnostic);
    providerContexts.set(this, createNativeFailureContext(parseStatus, trustedContext));
  }
}
function key(error: unknown): error is object {
  return error !== null && (typeof error === 'object' || typeof error === 'function');
}
/** Identity lookups never inspect caught values, including revoked proxies. */
export function nativeProviderDiagnostic(error: unknown): Readonly<NativeProviderDiagnostic> | null {
  return key(error) ? providerDiagnostics.get(error) ?? null : null;
}
export function nativeProviderFailureContext(error: unknown): Readonly<NativeFailureContext> | null {
  return key(error) ? providerContexts.get(error) ?? null : null;
}
