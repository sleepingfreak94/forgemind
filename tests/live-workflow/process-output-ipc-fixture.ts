// Test-only preload: transmit the terminal message but never run its callback.
// This exercises the supervisor's IPC-completion watchdog without a live service.
const send = process.send;
if (send) {
  process.send = ((message: unknown, ...args: unknown[]) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'reaped')
      return Reflect.apply(send, process, [message]);
    return Reflect.apply(send, process, [message, ...args]);
  }) as NonNullable<typeof process.send>;
}
