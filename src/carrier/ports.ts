import type { Endpoint } from "./udp.js"

/** Inclusive UDP port range, such as `4400-4463`. */
export type PortRange = { low: number; high: number }

export function parsePortRange(value: string): PortRange {
  const match = /^(\d+)-(\d+)$/.exec(value.trim())
  const low = Number(match?.[1])
  const high = Number(match?.[2])
  if (!match || !Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high > 65535 || low > high) {
    throw new Error(`expected a port range such as 4400-4463, got ${value}`)
  }
  return { low, high }
}

/**
 * Ports in one range that this process is not using. A port someone else
 * holds fails its bind, and `startOnPort` moves on to the next one.
 */
export class PortPool {
  private readonly taken = new Set<number>()
  private next: number

  constructor(readonly range: PortRange) {
    this.next = range.low
  }

  get size(): number {
    return this.range.high - this.range.low + 1
  }

  take(): number | null {
    for (let step = 0; step < this.size; step++) {
      const port = this.next
      this.next = port >= this.range.high ? this.range.low : port + 1
      if (this.taken.has(port)) continue
      this.taken.add(port)
      return port
    }
    return null
  }

  release(port: number): void {
    this.taken.delete(port)
  }
}

type Startable = { start: () => Promise<Endpoint>; close: () => Promise<void> }

/**
 * Start a socket owner on a port from the pool. Without a pool it binds port 0.
 * Returns null when every port in the range is in use.
 */
export async function startOnPort<T extends Startable>(
  pool: PortPool | null,
  make: (port: number) => T,
): Promise<{ item: T; port: number | null } | null> {
  if (!pool) {
    const item = make(0)
    await item.start()
    return { item, port: null }
  }
  for (let attempt = 0; attempt < pool.size; attempt++) {
    const port = pool.take()
    if (port === null) return null
    const item = make(port)
    try {
      await item.start()
      return { item, port }
    } catch (err) {
      await item.close().catch(() => {})
      pool.release(port)
      if ((err as { code?: unknown }).code !== "EADDRINUSE") throw err
    }
  }
  return null
}
