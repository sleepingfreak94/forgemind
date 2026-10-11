/** One bounded lifetime for the native worker and its upstream broker request. */
export function invocationBudget(taskRuntimeMs: number, taskSignal: AbortSignal): {
  timeoutMs: number; signal: AbortSignal; dispose(): void;
} {
  if (!Number.isSafeInteger(taskRuntimeMs) || taskRuntimeMs < 1 || taskRuntimeMs > 900000)
    throw new Error('Invalid invocation runtime');
  taskSignal.throwIfAborted();
  const timeoutMs = Math.min(taskRuntimeMs, 300000), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Invocation deadline')), timeoutMs);
  timer.unref();
  return { timeoutMs, signal: AbortSignal.any([taskSignal, controller.signal]),
    dispose() { clearTimeout(timer); controller.abort(new Error('Invocation finished')); } };
}
