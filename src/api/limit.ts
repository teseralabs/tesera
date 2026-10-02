// Public HTTP allowances. These are separate from the relay's UDP policy.
// A session secret is not an identity here. Quotas belong to a client address.

import { isLoopback, normalizeHost } from "../carrier/udp.js"

export const API_WINDOW_MS = 60_000
export const API_IDLE_MS = 120_000
export const API_MAX_LIMIT_ENTRIES = 4_096
export const API_TRANSFER_REQUESTS = 30
export const API_TRANSFER_BYTES = 100 * 1024 * 1024
export const API_ACTIVE_PER_IP = 4
export const API_INFO_REQUESTS = 120

export type ApiLimitConfig = {
  windowMs: number
  idleMs: number
  maxEntries: number
  transferRequests: number
  transferBytes: number
  activePerIp: number
  infoRequests: number
}

export const DEFAULT_API_LIMITS: ApiLimitConfig = {
  windowMs: API_WINDOW_MS,
  idleMs: API_IDLE_MS,
  maxEntries: API_MAX_LIMIT_ENTRIES,
  transferRequests: API_TRANSFER_REQUESTS,
  transferBytes: API_TRANSFER_BYTES,
  activePerIp: API_ACTIVE_PER_IP,
  infoRequests: API_INFO_REQUESTS,
}

export type LimitResult = { ok: true } | { ok: false; retryAfterSec: number }

type Entry = {
  seen: number
  active: number
  transferHits: number[]
  infoHits: number[]
  bytes: { at: number; n: number }[]
}

const ok: LimitResult = { ok: true }

/** Loopback addresses allowed to supply a client through X-Forwarded-For. */
export function trustedProxies(hosts: readonly string[]): Set<string> {
  const trusted = new Set<string>()
  for (const host of hosts) {
    const normalized = normalizeHost(host)
    if (!isLoopback(normalized)) throw new Error("--trust-proxy must be a loopback address")
    trusted.add(normalized)
  }
  return trusted
}

/**
 * The socket peer is the caller.
 * X-Forwarded-For is read only when that peer is one of `trusted`, which can only be loopback.
 * A direct connection from any other address keeps that address, header included.
 */
export function clientAddress(peer: string | undefined, forwarded: string | undefined, trusted: ReadonlySet<string>): string {
  const socket = ipv4(peer) ?? "0.0.0.0"
  if (!trusted.has(socket) || forwarded === undefined) return socket
  const hops = forwarded
    .split(",")
    .map((part) => ipv4(part))
    .filter((part): part is string => part !== null)
  for (let index = hops.length - 1; index >= 0; index--) {
    const hop = hops[index]
    if (hop && !trusted.has(hop)) return hop
  }
  return socket
}

export class ApiLimiter {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly limits: ApiLimitConfig,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    this.sweep()
    return this.entries.size
  }

  admitInfo(ip: string): LimitResult {
    const entry = this.take(ip)
    if (!entry) return { ok: false, retryAfterSec: this.fullRetry() }
    entry.infoHits = this.fresh(entry.infoHits)
    if (entry.infoHits.length >= this.limits.infoRequests) {
      return { ok: false, retryAfterSec: this.until(entry.infoHits[0] ?? this.now()) }
    }
    entry.infoHits.push(this.now())
    return ok
  }

  admitTransfer(ip: string): LimitResult {
    const entry = this.take(ip)
    if (!entry) return { ok: false, retryAfterSec: this.fullRetry() }
    entry.transferHits = this.fresh(entry.transferHits)
    if (entry.transferHits.length >= this.limits.transferRequests) {
      return { ok: false, retryAfterSec: this.until(entry.transferHits[0] ?? this.now()) }
    }
    if (entry.active >= this.limits.activePerIp) return { ok: false, retryAfterSec: 1 }
    entry.transferHits.push(this.now())
    return ok
  }

  /** Whether `n` more transfer bytes would still fit. Does not record them. */
  bytesFit(ip: string, n: number): LimitResult {
    if (n > this.limits.transferBytes) return { ok: false, retryAfterSec: this.seconds(this.limits.windowMs) }
    const entry = this.entries.get(ip)
    if (!entry) return ok
    entry.bytes = this.freshBytes(entry.bytes)
    const sum = this.byteSum(entry.bytes)
    if (sum + n <= this.limits.transferBytes) return ok
    return { ok: false, retryAfterSec: this.byteRetry(entry.bytes, sum + n - this.limits.transferBytes) }
  }

  /** Record transfer bytes that were accepted or sent. */
  addBytes(ip: string, n: number): LimitResult {
    if (n < 1) return ok
    const entry = this.take(ip)
    if (!entry) return { ok: false, retryAfterSec: this.fullRetry() }
    entry.bytes = this.freshBytes(entry.bytes)
    entry.bytes.push({ at: this.now(), n })
    const sum = this.byteSum(entry.bytes)
    if (sum <= this.limits.transferBytes) return ok
    return { ok: false, retryAfterSec: this.byteRetry(entry.bytes, sum - this.limits.transferBytes) }
  }

  hold(ip: string): void {
    const entry = this.entries.get(ip)
    if (!entry) return
    entry.active += 1
    entry.seen = this.now()
  }

  release(ip: string): void {
    const entry = this.entries.get(ip)
    if (!entry) return
    entry.active = Math.max(0, entry.active - 1)
    entry.seen = this.now()
  }

  private take(ip: string): Entry | null {
    this.sweep()
    const existing = this.entries.get(ip)
    if (existing) {
      existing.seen = this.now()
      return existing
    }
    if (this.entries.size >= this.limits.maxEntries) return null
    const created: Entry = { seen: this.now(), active: 0, transferHits: [], infoHits: [], bytes: [] }
    this.entries.set(ip, created)
    return created
  }

  private sweep(): void {
    const now = this.now()
    for (const [ip, entry] of this.entries) {
      if (entry.active > 0) continue
      if (now - entry.seen >= this.limits.idleMs) this.entries.delete(ip)
    }
  }

  private fresh(times: number[]): number[] {
    const cutoff = this.now() - this.limits.windowMs
    return times.filter((at) => at > cutoff)
  }

  private freshBytes(events: { at: number; n: number }[]): { at: number; n: number }[] {
    const cutoff = this.now() - this.limits.windowMs
    return events.filter((event) => event.at > cutoff)
  }

  private byteSum(events: { at: number; n: number }[]): number {
    return events.reduce((sum, event) => sum + event.n, 0)
  }

  private byteRetry(events: { at: number; n: number }[], excess: number): number {
    let left = excess
    for (const event of events) {
      left -= event.n
      if (left <= 0) return this.until(event.at)
    }
    return this.seconds(this.limits.windowMs)
  }

  private until(at: number): number {
    return this.seconds(at + this.limits.windowMs - this.now())
  }

  private fullRetry(): number {
    const now = this.now()
    let soonest = this.limits.idleMs
    for (const entry of this.entries.values()) {
      if (entry.active > 0) continue
      const left = entry.seen + this.limits.idleMs - now
      if (left < soonest) soonest = left
    }
    return this.seconds(soonest)
  }

  private seconds(ms: number): number {
    return Math.max(1, Math.ceil(ms / 1000))
  }
}

function ipv4(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().replace(/^::ffff:/i, "")
  if (trimmed.length === 0) return null
  try {
    return normalizeHost(trimmed)
  } catch {
    return null
  }
}
