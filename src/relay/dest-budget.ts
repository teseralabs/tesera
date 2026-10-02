import type { Endpoint } from "../carrier/udp.js"
import { UNVERIFIED_DEST_BYTES, UNVERIFIED_DEST_MAX, UNVERIFIED_DEST_TTL_MS } from "../constants.js"

type Entry = { remaining: number; reachable: boolean; at: number }

/**
 * Byte allowance for addresses that have not sent a valid tesera datagram.
 * The key is host and port. A later transfer does not refill what is left.
 */
export class DestBudget {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly bytes = UNVERIFIED_DEST_BYTES,
    private readonly max = UNVERIFIED_DEST_MAX,
    private readonly ttlMs = UNVERIFIED_DEST_TTL_MS,
  ) {}

  get size(): number {
    return this.entries.size
  }

  remaining(endpoint: Endpoint, now = Date.now()): number | null {
    this.sweep(now)
    const entry = this.entries.get(keyOf(endpoint))
    if (!entry) return null
    return entry.remaining
  }

  markReachable(endpoint: Endpoint, now = Date.now()): void {
    this.sweep(now)
    const key = keyOf(endpoint)
    const existing = this.entries.get(key)
    if (existing) {
      existing.reachable = true
      existing.at = now
      return
    }
    if (this.entries.size >= this.max) return
    this.entries.set(key, { remaining: this.bytes, reachable: true, at: now })
  }

  /** False drops the forward. A reachable address is not counted against the allowance. */
  spend(endpoint: Endpoint, bytes: number, now = Date.now()): boolean {
    this.sweep(now)
    const key = keyOf(endpoint)
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= this.max) return false
      entry = { remaining: this.bytes, reachable: false, at: now }
      this.entries.set(key, entry)
    } else {
      entry.at = now
    }
    if (entry.reachable) return true
    if (bytes > entry.remaining) return false
    entry.remaining -= bytes
    return true
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) this.entries.delete(key)
    }
  }
}

function keyOf(endpoint: Endpoint): string {
  return `${endpoint.host}:${endpoint.port}`
}
