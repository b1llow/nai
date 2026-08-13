import type { Context } from "hono";

/**
 * Keep a background promise alive for the Worker invocation.
 * `ctx.waitUntil` is not available under Hono `app.request()` in Node tests,
 * so fall back to `void` there. Do not destructure `executionCtx`.
 */
export function ctxWaitUntil(c: Context, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    void promise;
  }
}

/** Attach a pump promise to waitUntil, or void it when no execution context. */
export function retainPromise(
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  promise: Promise<unknown>,
): void {
  if (waitUntil) {
    waitUntil(promise);
    return;
  }
  void promise;
}
