import { gunzipSync, zstdDecompressSync } from 'node:zlib';

/** Bounds local CLI metadata and decompression, not authorized provider spend.
 * The maximum task payload remains 256 KiB. CLI descriptors may be stripped
 * before forwarding; even that untrusted envelope has a fixed 2 MiB ceiling. */
export const NATIVE_ENVELOPE_MAX_BYTES = 2 * 1024 * 1024;

export function decodeNativeRequest(bytes: Uint8Array, encoding: string | string[] | undefined): string {
  if (bytes.byteLength > NATIVE_ENVELOPE_MAX_BYTES) throw new Error('Prompt transport limit');
  let decoded: Uint8Array = bytes;
  try {
    if (encoding === 'gzip') decoded = gunzipSync(bytes, { maxOutputLength: NATIVE_ENVELOPE_MAX_BYTES });
    else if (encoding === 'zstd') decoded = zstdDecompressSync(bytes, { maxOutputLength: NATIVE_ENVELOPE_MAX_BYTES });
    else if (encoding !== undefined && encoding !== 'identity') throw new Error('Unsupported encoding');
  } catch (error) {
    if (error instanceof Error && error.message === 'Unsupported encoding') throw error;
    throw new Error('Invalid or oversized compressed request');
  }
  if (decoded.byteLength > NATIVE_ENVELOPE_MAX_BYTES) throw new Error('Prompt transport limit');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(decoded); }
  catch { throw new Error('Invalid request UTF-8'); }
}

/** Check the complete sanitized JSON, including schema and provider fields,
 * before reserving inference. Counting bytes here does not estimate tokens. */
export function outboundPromptBytes(payload: string, maximum: number): number {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 262144)
    throw new Error('Invalid provider prompt limit');
  const bytes = Buffer.byteLength(payload);
  if (bytes < 1 || bytes > maximum) throw new Error('Provider prompt byte limit');
  return bytes;
}
