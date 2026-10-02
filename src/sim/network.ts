import { mulberry32 } from "../util.js"

export type Adversity = {
  lossRate: number
  delayMs: number
  jitterMs: number
  reorderMs: number
  bandwidthBps: number
  blackhole: boolean
}

export function defaultAdversity(): Adversity {
  return {
    lossRate: 0,
    delayMs: 0,
    jitterMs: 0,
    reorderMs: 0,
    bandwidthBps: 0,
    blackhole: false,
  }
}

export function fillAdversity(partial?: Partial<Adversity>): Adversity {
  const adversity = { ...defaultAdversity(), ...partial }
  if (adversity.lossRate < 0 || adversity.lossRate > 1) {
    throw new Error("lossRate must be between 0 and 1")
  }
  if (adversity.delayMs < 0 || adversity.jitterMs < 0 || adversity.reorderMs < 0 || adversity.bandwidthBps < 0) {
    throw new Error("delay, jitter, reorder, and bandwidth cannot be negative")
  }
  return adversity
}

export type Admit =
  | { action: "drop"; reason: "blackhole" | "loss" }
  | { action: "forward"; waitMs: number }

export class PathSim {
  private nextAt = 0

  constructor(
    readonly adversity: Adversity,
    private readonly random: () => number,
  ) {}

  static from(adversity: Adversity, seed: number): PathSim {
    return new PathSim(adversity, mulberry32(seed))
  }

  admit(bytes: number): Admit {
    if (this.adversity.blackhole) return { action: "drop", reason: "blackhole" }
    if (this.adversity.lossRate > 0 && this.random() < this.adversity.lossRate) {
      return { action: "drop", reason: "loss" }
    }
    let wait = this.adversity.delayMs
    if (this.adversity.jitterMs > 0) wait += this.random() * this.adversity.jitterMs
    if (this.adversity.reorderMs > 0) wait += this.random() * this.adversity.reorderMs
    if (this.adversity.bandwidthBps > 0) {
      const now = Date.now()
      const start = Math.max(now, this.nextAt)
      this.nextAt = start + (bytes * 8_000) / this.adversity.bandwidthBps
      wait += start - now
    }
    return { action: "forward", waitMs: wait }
  }
}

/**
 * One coin flip per time window, shared by every relay that holds this gate.
 * Tesserae sent together share a fate. A later retransmission falls in a new window.
 */
export class CorrelatedGate {
  private windowStart = -1
  private closed = false

  constructor(
    private readonly rate: number,
    private readonly random: () => number,
    private readonly windowMs: number,
  ) {
    if (rate < 0 || rate > 1) throw new Error("correlated loss must be between 0 and 1")
  }

  closedNow(): boolean {
    const now = Date.now()
    if (this.windowStart < 0 || now - this.windowStart >= this.windowMs) {
      this.windowStart = now
      this.closed = this.rate > 0 && this.random() < this.rate
    }
    return this.closed
  }
}
