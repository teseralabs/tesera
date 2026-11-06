import type { Clock } from "../src/clock.js"

type Timer = { at: number; seq: number; run: () => void; every: number; live: boolean; unref: () => void }

/**
 * Time that moves only from one timer to the next. Before each timer fires, every promise that is
 * ready runs to completion, so work that takes a slow machine longer takes no virtual time at all.
 * Timers due at the same moment fire in the order they were set, which makes a run repeatable.
 *
 * Everything in the run has to wait on this clock or on promises: a real timer or a real socket is
 * invisible to it. `run` drives the clock until the work settles.
 */
export class VirtualClock implements Clock {
  private t = 10_000
  private readonly epoch = 1_800_000_000_000
  private seq = 0
  private readonly heap: Timer[] = []

  now(): number {
    return this.epoch + Math.floor(this.t)
  }

  mono(): number {
    return this.t
  }

  setTimeout(run: () => void, ms: number): unknown {
    return this.add(run, ms, 0)
  }

  clearTimeout(timer: unknown): void {
    if (timer && typeof timer === "object" && "live" in timer) (timer as Timer).live = false
  }

  setInterval(run: () => void, ms: number): unknown {
    return this.add(run, ms, Math.max(1, ms))
  }

  clearInterval(timer: unknown): void {
    this.clearTimeout(timer)
  }

  /** Drive the clock until `work` settles, and give its result. Fails past `limitMs` of virtual time. */
  async run<T>(work: Promise<T>, limitMs = 10 * 60_000): Promise<T> {
    let settled = false
    work.then(
      () => (settled = true),
      () => (settled = true),
    )
    const until = this.t + limitMs
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (settled) return work
      const next = this.pop()
      if (!next) throw new Error("the work is waiting on something this clock can't see")
      if (next.at > until) throw new Error(`still running after ${limitMs} ms of virtual time`)
      this.t = Math.max(this.t, next.at)
      if (next.every > 0) {
        next.at = this.t + next.every
        next.seq = this.seq++
        this.push(next)
      }
      next.run()
    }
  }

  private add(run: () => void, ms: number, every: number): Timer {
    const timer: Timer = { at: this.t + Math.max(0, ms || 0), seq: this.seq++, run, every, live: true, unref: () => {} }
    this.push(timer)
    return timer
  }

  private pop(): Timer | undefined {
    for (;;) {
      const top = this.heap[0]
      if (!top) return undefined
      const last = this.heap.pop() as Timer
      if (this.heap.length > 0) {
        this.heap[0] = last
        this.down(0)
      }
      if (top.live) return top
    }
  }

  private push(timer: Timer): void {
    this.heap.push(timer)
    let i = this.heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.before(this.heap[i] as Timer, this.heap[parent] as Timer)) break
      this.swap(i, parent)
      i = parent
    }
  }

  private down(i: number): void {
    for (;;) {
      const left = 2 * i + 1
      const right = left + 1
      let best = i
      if (left < this.heap.length && this.before(this.heap[left] as Timer, this.heap[best] as Timer)) best = left
      if (right < this.heap.length && this.before(this.heap[right] as Timer, this.heap[best] as Timer)) best = right
      if (best === i) return
      this.swap(i, best)
      i = best
    }
  }

  private before(a: Timer, b: Timer): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq)
  }

  private swap(a: number, b: number): void {
    const held = this.heap[a] as Timer
    this.heap[a] = this.heap[b] as Timer
    this.heap[b] = held
  }
}
