import { systemClock, type Clock } from "./clock.js"

export class Signal {
  private waiters: Array<() => void> = []

  notify(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  wait(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }
}

export function sleep(ms: number, clock: Clock = systemClock): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms)
  })
}

/** Wait for `work`, but no longer than `ms`. The timer is cleared either way, so it never holds a process open. */
export async function waitAtMost(work: Promise<unknown>, ms: number, clock: Clock = systemClock): Promise<void> {
  let timer: unknown
  const limit = new Promise<void>((resolve) => {
    timer = clock.setTimeout(resolve, ms)
  })
  try {
    await Promise.race([work.then(() => {}, () => {}), limit])
  } finally {
    clock.clearTimeout(timer)
  }
}

export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

export function concatBytes(chunks: Uint8Array[]): Buffer {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = Buffer.allocUnsafe(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
