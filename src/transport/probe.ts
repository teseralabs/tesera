/**
 * Timing notes for diagnostics and benchmarks. A sender or receiver without a probe does no extra
 * work. Names, steps, and their meanings are unstable and may change in any release.
 */
export interface Probe {
  /** A duration in milliseconds, or a count, under a name such as `sender.send`. */
  note(name: string, value: number): void
  /** Block `blockId` reached `step` at `at`, a `performance.now()` time. */
  step(blockId: number, step: string, at: number): void
}
