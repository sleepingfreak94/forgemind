import { setImmediate } from 'node:timers/promises';

const batchBytes = 16 * 1024;
const batchWaitMs = 20;
/** Transport boundaries carry no authority. Checks occur before each bounded batch
 * is forwarded; raw bytes remain untrusted until the broker validates its frames. */
export async function* providerBatches(
  body: ReadableStream<Uint8Array>, signal: AbortSignal, maxBytes: number,
): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024)
    throw new Error('Invalid provider response limit');
  signal.throwIfAborted();
  const reader = body.getReader();
  let read: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let chunk: Uint8Array | undefined, offset = 0, received = 0, done = false;
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error('Cancelled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  // Cancellation may happen while the consumer validates a yielded batch.
  void aborted.catch(() => {});
  try {
    while (!done || chunk) {
      const buffer = new Uint8Array(batchBytes);
      let used = 0, deadline = 0, reads = 0;
      while (used < buffer.length) {
        signal.throwIfAborted();
        if (chunk) {
          const count = Math.min(chunk.length - offset, buffer.length - used);
          buffer.set(chunk.subarray(offset, offset + count), used);
          used += count; offset += count;
          if (!deadline && used) deadline = Date.now() + batchWaitMs;
          if (offset === chunk.length) { chunk = undefined; offset = 0; }
          if (used === buffer.length || (used && Date.now() >= deadline)) break;
        } else {
          if (done) break;
          read ??= reader.read();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              read, aborted,
              ...(used ? [new Promise<'flush'>(resolve => {
                timer = setTimeout(() => resolve('flush'), Math.max(0, deadline - Date.now()));
              })] : []),
            ]);
            if (result === 'flush') break;
            read = undefined;
            if (++reads % 256 === 0) { await setImmediate(undefined, { signal }); signal.throwIfAborted(); }
            if (result.done) { done = true; break; }
            received += result.value.byteLength;
            // Enforce the cumulative limit before copying or expensive source checks.
            if (received > maxBytes) throw new Error('Provider response byte limit');
            chunk = result.value;
          } finally { if (timer) clearTimeout(timer); }
        }
      }
      if (used) {
        // Resolved stream reads can form a microtask loop; explicitly service timers.
        await setImmediate(undefined, { signal });
        signal.throwIfAborted();
        yield buffer.subarray(0, used);
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
