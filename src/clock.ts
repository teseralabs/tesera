/**
 * Where the transport and the relay read time and set timers. The system clock is the default.
 * Tests pass a virtual one, so a slow machine can't stretch a round trip or a rate limit.
 * Time spent computing, such as encryptMs, is measured on the real clock either way.
 */
export interface Clock {
  /** Wall time in milliseconds, as Date.now. */
  now(): number
  /** Monotonic milliseconds, as performance.now. Never 0 once a transfer runs. */
  mono(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
  setInterval(run: () => void, ms: number): unknown
  clearInterval(timer: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  mono: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
}

/** Let a background timer not hold the process open. A timer without `unref` is left alone. */
export function unrefTimer(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref()
}
