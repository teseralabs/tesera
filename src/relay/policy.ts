import { readFile, rename, writeFile } from "node:fs/promises"
import { formatId, parseId } from "../identity/id.js"
import type { LimitedBy } from "../metrics.js"

/** Who may join this relay. `private` is the safe default. `open` is a public relay. */
export type Access = "open" | "private"

/** Which cap dropped a datagram. `destination` and `table` are counted by the relay. */
export type LimitReason = keyof LimitedBy

export type OperatorPolicy = {
  access: Access
  /** Forwarded bytes per second. 0 removes the cap. */
  bandwidthBps: number
  /** Concurrent session prefixes. 0 removes the cap. */
  maxSessions: number
  /** New peers accepted per minute. 0 removes the cap. */
  peerRatePerMin: number
  /** Forwarded datagrams per second. 0 removes the cap. */
  datagramRatePerSec: number
  allowed: string[]
  blocked: string[]
}

export type PolicyFile = {
  allowed: string[]
  blocked: string[]
  forget: string[]
}

/**
 * A 1-of-1 block costs the relay a 1068-byte tessera, a 50-byte sample, and a
 * 49-byte ACK, about 389 bytes a datagram. 5 mbps is about 1,600 of those a
 * second. The rest is room for NACKs and for ACKs copied to several relays.
 */
export const DEFAULT_DATAGRAM_RATE = 2_000
const SESSION_IDLE_MS = 30_000
const PEER_WINDOW_MS = 60_000

/** First run. A public relay opts out with `--access open` and higher limits. */
export function safePolicy(): OperatorPolicy {
  return {
    access: "private",
    bandwidthBps: 625_000,
    maxSessions: 8,
    peerRatePerMin: 6,
    datagramRatePerSec: DEFAULT_DATAGRAM_RATE,
    allowed: [],
    blocked: [],
  }
}

export function fillPolicy(partial?: Partial<OperatorPolicy>): OperatorPolicy {
  const base = safePolicy()
  const policy = {
    access: partial?.access ?? base.access,
    bandwidthBps: partial?.bandwidthBps ?? base.bandwidthBps,
    maxSessions: partial?.maxSessions ?? base.maxSessions,
    peerRatePerMin: partial?.peerRatePerMin ?? base.peerRatePerMin,
    datagramRatePerSec: partial?.datagramRatePerSec ?? base.datagramRatePerSec,
    allowed: partial?.allowed ?? [],
    blocked: partial?.blocked ?? [],
  }
  if (policy.access !== "open" && policy.access !== "private") throw new Error("access must be open or private")
  for (const [name, value] of [
    ["bandwidth", policy.bandwidthBps],
    ["max sessions", policy.maxSessions],
    ["peer rate", policy.peerRatePerMin],
    ["datagram rate", policy.datagramRatePerSec],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  }
  return policy
}

/** `--bandwidth`. A bare number is megabits per second. `0` removes the cap. */
export function parseBandwidth(value: string): number {
  const match = /^(\d+)(kbps|mbps)?$/.exec(value.trim().toLowerCase())
  if (!match?.[1]) throw new Error("--bandwidth must be 0, 5mbps, or 500kbps")
  const count = Number(match[1])
  if (count === 0) return 0
  const bits = match[2] === "kbps" ? count * 1_000 : count * 1_000_000
  const bytes = Math.floor(bits / 8)
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("--bandwidth is too large")
  return bytes
}

export function parseAccess(value: string): Access {
  if (value === "open" || value === "private") return value
  throw new Error("--access must be open or private")
}

export function canonicalRelayId(value: string): string {
  return formatId(parseId(value))
}

export function emptyPolicyFile(): PolicyFile {
  return { allowed: [], blocked: [], forget: [] }
}

export async function readPolicy(path: string): Promise<PolicyFile> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (err) {
    if (isEnoent(err)) return emptyPolicyFile()
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("policy file is not valid JSON")
  }
  if (!parsed || typeof parsed !== "object") throw new Error("policy file is not an object")
  const body = parsed as { allowed?: unknown; blocked?: unknown; forget?: unknown }
  return {
    allowed: readIds(body.allowed, "allowed"),
    blocked: readIds(body.blocked, "blocked"),
    forget: readIds(body.forget, "forget"),
  }
}

export async function writePolicy(path: string, file: PolicyFile): Promise<void> {
  const body = {
    allowed: file.allowed,
    blocked: file.blocked,
    forget: file.forget,
  }
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

/** Rate and membership checks for one relay process. */
export class PolicyGate {
  private readonly bandwidth: Bucket
  private readonly datagrams: Bucket
  private readonly sessions = new Map<string, number>()
  private joins: number[] = []
  private allowed = new Set<string>()
  private blocked = new Set<string>()

  constructor(private policy: OperatorPolicy) {
    this.bandwidth = new Bucket(policy.bandwidthBps)
    this.datagrams = new Bucket(policy.datagramRatePerSec)
    this.allowed = new Set(policy.allowed)
    this.blocked = new Set(policy.blocked)
  }

  get access(): Access {
    return this.policy.access
  }

  allows(): string[] {
    return [...this.allowed]
  }

  blocks(): string[] {
    return [...this.blocked]
  }

  setLists(allowed: string[], blocked: string[]): void {
    this.allowed = new Set(allowed)
    this.blocked = new Set(blocked)
  }

  isBlocked(id: string): boolean {
    return this.blocked.has(id)
  }

  /**
   * Null admits the datagram. Otherwise the cap that was full. Nothing is
   * spent on a drop, so a datagram refused by one cap does not use up another.
   */
  admitDatagram(bytes: number, session: string | null, now = Date.now()): LimitReason | null {
    if (session && !this.roomForSession(session, now)) return "session"
    if (!this.datagrams.has(1, now)) return "datagram"
    if (!this.bandwidth.has(bytes, now)) return "bandwidth"
    this.datagrams.take(1, now)
    this.bandwidth.take(bytes, now)
    if (session) this.sessions.set(session, now)
    return null
  }

  /** A brand-new peer. A relay we already know does not spend this budget. */
  admitJoin(now = Date.now()): boolean {
    const rate = this.policy.peerRatePerMin
    if (rate <= 0) return true
    const cutoff = now - PEER_WINDOW_MS
    this.joins = this.joins.filter((at) => at >= cutoff)
    if (this.joins.length >= rate) return false
    this.joins.push(now)
    return true
  }

  /** `blocked` wins over the allow list. `private` refuses everyone else. */
  admitIdentity(id: string): "ok" | "blocked" | "access" {
    if (this.blocked.has(id)) return "blocked"
    if (this.policy.access === "private" && !this.allowed.has(id)) return "access"
    return "ok"
  }

  private roomForSession(session: string, now: number): boolean {
    const cap = this.policy.maxSessions
    if (cap <= 0) return true
    const idle = now - SESSION_IDLE_MS
    for (const [prefix, seen] of this.sessions) {
      if (seen < idle) this.sessions.delete(prefix)
    }
    return this.sessions.has(session) || this.sessions.size < cap
  }
}

class Bucket {
  private tokens: number
  private at = Date.now()

  constructor(private readonly perSec: number) {
    this.tokens = perSec
  }

  has(n: number, now: number): boolean {
    if (this.perSec <= 0) return true
    this.refill(now)
    return this.tokens >= n
  }

  take(n: number, now: number): boolean {
    if (!this.has(n, now)) return false
    if (this.perSec > 0) this.tokens -= n
    return true
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.at) / 1000
    this.at = now
    this.tokens = Math.min(this.perSec, this.tokens + elapsed * this.perSec)
  }
}

function readIds(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`policy file ${label} must be a list`)
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error(`policy file has a bad relay id`)
    let id: string
    try {
      id = canonicalRelayId(entry)
    } catch {
      throw new Error(`policy file has a bad relay id`)
    }
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT"
}
