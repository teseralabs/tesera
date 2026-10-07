import { randomBytes } from "node:crypto"
import { type Socket } from "node:dgram"
import { type Server } from "node:http"
import { bindUdp, closeUdp, createUdpSocket, isLoopback, normalizeHost, sendUdp, type Endpoint } from "../carrier/udp.js"
import {
  MAX_FORWARD_DATAGRAM,
  TABLE_NONCE_TTL_MS,
  UNVERIFIED_DEST_BYTES,
  UNVERIFIED_DEST_MAX,
  TABLE_PENDING_MAX,
  TABLE_READY_TTL_MS,
  UNVERIFIED_DEST_TTL_MS,
} from "../constants.js"
import { allowsLog, formatLog, type LogLevel } from "../log.js"
import { emptyLimitedBy, emptyRelayStats, type LimitedBy, type RelayStats } from "../metrics.js"
import {
  decodeProof,
  decodeQuery,
  encodeProof,
  encodeQuery,
  formatId,
  isIdentityPacket,
  startsIdentity,
  verifyProof,
  type Identity,
  type Proof,
} from "../identity/id.js"
import {
  MAX_INTRODUCED,
  decodeLookup,
  decodeResume,
  encodeAgain,
  encodeJoin,
  encodeTable,
  isJoin,
  readRelayTable,
  type IntroducedRelay,
} from "../identity/peers.js"
import {
  decodeSnapshotQuery,
  decodeUsage,
  encodeSnapshot,
  encodeUsage,
  type RelaySnapshot,
} from "../identity/stats.js"
import {
  DEFAULT_RECORD_TTL_SEC,
  officialClaims,
  planRecord,
  readRecordFile,
  recordDocument,
  writeRecordFile,
  encodeRecord,
  isRecordAsk,
  type RecordClaims,
} from "../identity/record.js"
import { decodeEnvelope, startsEnvelope } from "../protocol/envelope.js"
import { peekRelayFrame } from "../protocol/frames.js"
import type { SignedStatement } from "../attach/statement.js"
import { closeRelayApi, listenRelayApi, type ListedRelay, type RelayDirectory, type RelayReport } from "./api.js"
import { readAnalytics, writeAnalytics } from "./analytics.js"
import { readPeers, writePeers, type StoredPeer } from "./peers-file.js"
import { DestBudget } from "./dest-budget.js"
import { destinationAllowed, parseCidr, type Cidr } from "./dest.js"
import type { ForwardResult, LocalDelivery } from "./local.js"
import { fillPolicy, PolicyGate, readPolicy, writePolicy, type LimitReason, type OperatorPolicy } from "./policy.js"
import { isStructuralTesera } from "./structural.js"
import { DEFAULT_PEER_OFFLINE_MS, defaultRelaySettings, type RelaySettings } from "./config.js"
import { CorrelatedGate, fillAdversity, PathSim, type Admit, type Adversity } from "../sim/network.js"
import { sleep } from "../util.js"

type RememberedRelay = IntroducedRelay & { seenAt: number; quiet: boolean }

export type RelayOptions = {
  adversity?: Partial<Adversity>
  seed?: number
  allowRemote?: boolean
  host?: string
  port?: number
  /** Extra pipe every relay shares. Models one uplink in front of the whole set. */
  shared?: PathSim
  /** Same drop decision for every data tessera inside one short window. */
  correlated?: CorrelatedGate
  /** When set, the relay answers a challenge with a signature from this key. */
  identity?: Identity
  /** Live lines for a CLI relay. Bench relays stay quiet. */
  log?: (line: string) => void
  /** Which of those lines to print. Defaults to info, so per-block lines stay quiet. */
  logLevel?: LogLevel
  /** When set, this relay's bytes and transfers are reloaded on the next start. */
  analyticsFile?: string
  /** When set, the relay API is served on this TCP address. */
  api?: { host: string; port: number }
  /** How long a quiet relay stays remembered. Defaults to 30 days. */
  peerTtlMs?: number
  /** How long a relay can stay silent before it leaves the count. Defaults to 15 seconds. */
  peerOfflineMs?: number
  /** When set, remembered relays are reloaded on the next start. */
  peersFile?: string
  /** Caps and who may join. Omitted means no caps and an open relay, for tests. */
  policy?: Partial<OperatorPolicy>
  /** Allowed, blocked, and forget requests. The relay reloads this while it runs. */
  policyFile?: string
  /** CIDRs a public relay may forward into, including ranges it otherwise refuses. */
  allowDest?: string[]
  /** How long an unverified destination keeps its allowance. Defaults to 60 seconds. */
  destTtlMs?: number
  /** Addresses this relay claims in its signed record. */
  advertise?: Endpoint[]
  /** Optional label in the signed record. At most 64 bytes. */
  recordName?: string
  /** How long a signed record stays fresh, in seconds. Defaults to 24 hours. */
  recordTtlSec?: number
  /** Last signed record. A restart reads this so the sequence does not go backward. */
  recordFile?: string
  /** Shortest gap between `event=limited` lines. Defaults to 30 seconds. */
  limitLogMs?: number
  /** Where to deliver packets that belong to a locally attached endpoint rather than a UDP peer. */
  localDelivery?: LocalDelivery
  /** Signed statements of the extra transports this relay serves, for GET /v1/transports. */
  transportStatements?: () => SignedStatement[]
}

/** Shortest gap between two `event=limited` lines. */
const LIMIT_LOG_MS = 30_000
/** How long a relay keeps trying its first join before it gives up. */
export const JOIN_STARTUP_MS = 60_000
const JOIN_RETRY_MAX_MS = 15_000
/** How often a joined relay reads the seed's signed table to see that it is still listed. */
export const MEMBERSHIP_CHECK_MS = 60_000
/** Longest gap between checks while the seed does not answer. */
export const MEMBERSHIP_CHECK_MAX_MS = 300_000

/** The seed to join. `resolve` runs before every join, so a changed address is picked up. */
export type JoinTarget = {
  label: string
  id: string | null
  resolve: () => Promise<Endpoint>
}

export type StayJoinedOptions = {
  startupMs?: number
  attemptMs?: number
  firstRetryMs?: number
  checkMs?: number
  maxCheckMs?: number
}

/** The seed signed its table with a key other than the pinned one. Retrying does not help. */
export class PinnedSeedError extends Error {
  constructor(seed: Endpoint, got: string, pinned: string) {
    super(`seed ${seed.host}:${seed.port} is ${got}, not the pinned ${pinned}`)
  }
}

class JoinError extends Error {
  constructor(seed: Endpoint, readonly why: string) {
    super(`relay did not join ${seed.host}:${seed.port}: ${why}`)
  }
}

export class Relay {
  private readonly opts: RelayOptions
  private socket: Socket | null = null
  private bound: Endpoint | null = null
  private closed = false
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly sim: PathSim
  private readonly identity: Identity | null
  private readonly peers = new Map<string, RememberedRelay>()
  private readonly pending = new Map<string, { challenge: Buffer; at: number }>()
  private readonly usage = new Map<string, { seq: number; bytes: number; transfers: number }>()
  /** Session prefixes that have data, an acknowledgement, or both. A transfer is both. */
  private readonly sent = new Set<string>()
  private readonly acked = new Set<string>()
  private readonly transfers = new Set<string>()
  /** Data tesserae already forwarded, so a repeat counts as repair traffic. */
  private readonly seenTesserae = new Set<string>()
  private dataFrames = 0
  private ackFrames = 0
  private nackFrames = 0
  private duplicateTesserae = 0
  private startedAt = 0
  private usageSeq = 0
  private seedEndpoint: Endpoint | null = null
  private usageTimer: NodeJS.Timeout | null = null
  private peerTimer: NodeJS.Timeout | null = null
  private readonly settings: RelaySettings
  private readonly peerOfflineMs: number
  /** Totals loaded from the analytics file. This process's counters sit on top. */
  private storedBytes = 0
  private storedTransfers = 0
  private analyticsDirty = false
  private analyticsTimer: NodeJS.Timeout | null = null
  private peersDirty = false
  private peersTimer: NodeJS.Timeout | null = null
  private policyTimer: NodeJS.Timeout | null = null
  private readonly gate: PolicyGate | null
  private readonly localDelivery: LocalDelivery | null
  private readonly policyFile: string | null
  private readonly allowDest: Cidr[]
  private readonly dests: DestBudget
  private readonly tableAsked = new Map<string, { nonce: Buffer; at: number }>()
  private readonly tableReady = new Map<string, number>()
  private readonly rejections = new Set<string>()
  private http: Server | null = null
  private httpEndpoint: Endpoint | null = null
  private readonly recordClaims: RecordClaims | null
  private readonly recordFile: string | null
  private recordPacket: Buffer | null = null
  private recordTimer: NodeJS.Timeout | null = null
  private limitTimer: NodeJS.Timeout | null = null
  private joinTarget: JoinTarget | null = null
  private joinCheckMs = MEMBERSHIP_CHECK_MS
  private joinMaxCheckMs = MEMBERSHIP_CHECK_MAX_MS
  private joinAttemptMs = 1500
  private joinBackoffMs = 0
  private membershipTimer: NodeJS.Timeout | null = null
  private limitsLogged: LimitedBy = emptyLimitedBy()
  readonly stats: RelayStats = emptyRelayStats()
  /** Test hook. Called with the inner frame of packets that are actually forwarded. */
  onForward: ((inner: Buffer) => void) | null = null
  private readonly announced = new Set<string>()

  constructor(opts: RelayOptions = {}) {
    this.opts = opts
    this.identity = opts.identity ?? null
    this.sim = PathSim.from(fillAdversity(opts.adversity), opts.seed ?? 1)
    const defaults = defaultRelaySettings()
    const peerTtlMs = opts.peerTtlMs ?? defaults.peerTtlMs
    if (!Number.isSafeInteger(peerTtlMs) || peerTtlMs < 0) throw new Error("peer ttl must be a non-negative integer")
    const peerOfflineMs = opts.peerOfflineMs ?? DEFAULT_PEER_OFFLINE_MS
    if (!Number.isSafeInteger(peerOfflineMs) || peerOfflineMs < 1) {
      throw new Error("peer offline window must be a positive integer")
    }
    this.peerOfflineMs = peerOfflineMs
    this.settings = {
      logLevel: opts.logLevel ?? defaults.logLevel,
      analyticsFile: opts.analyticsFile ?? defaults.analyticsFile,
      api: opts.api ?? defaults.api,
      peerTtlMs,
      peersFile: opts.peersFile ?? defaults.peersFile,
    }
    this.gate = opts.policy ? new PolicyGate(fillPolicy(opts.policy)) : null
    this.localDelivery = opts.localDelivery ?? null
    this.policyFile = opts.policyFile ?? null
    this.allowDest = (opts.allowDest ?? []).map(parseCidr)
    const destTtlMs = opts.destTtlMs ?? UNVERIFIED_DEST_TTL_MS
    if (!Number.isSafeInteger(destTtlMs) || destTtlMs < 1) throw new Error("destination ttl must be a positive integer")
    this.dests = new DestBudget(UNVERIFIED_DEST_BYTES, UNVERIFIED_DEST_MAX, destTtlMs)
    const recordTtlSec = opts.recordTtlSec ?? DEFAULT_RECORD_TTL_SEC
    this.recordFile = opts.recordFile ?? null
    this.recordClaims = this.identity
      ? officialClaims({ addresses: opts.advertise ?? [], name: opts.recordName ?? "", ttlSec: recordTtlSec })
      : null
    if (this.identity && this.recordClaims) {
      // Fail before listen when the name, ttl, or an advertised address cannot be signed.
      encodeRecord(this.identity, this.recordClaims, 1n, 0)
    }
  }

  get endpoint(): Endpoint {
    if (!this.bound) throw new Error("relay has not started")
    return this.bound
  }

  /** The address peers send to: the first advertised one, or the bound one unless that is every interface. */
  get publicEndpoint(): Endpoint | null {
    const advertised = this.opts.advertise?.[0]
    if (advertised) return advertised
    const bound = this.endpoint
    return bound.host === "0.0.0.0" ? null : bound
  }

  /** TCP address of the relay API, after start. Null when the API is off. */
  get apiEndpoint(): Endpoint | null {
    return this.httpEndpoint
  }

  async start(): Promise<Endpoint> {
    const socket = createUdpSocket()
    this.socket = socket
    this.bound = await bindUdp(socket, this.opts.host ?? "127.0.0.1", this.opts.port ?? 0)
    this.startedAt = Date.now()
    socket.on("message", (msg, rinfo) => {
      this.onPacket(Buffer.from(msg), { host: rinfo.address, port: rinfo.port })
    })
    socket.on("error", () => {
      this.stats.droppedInvalid++
      this.emit("error", "error", { reason: "socket" })
    })
    const peerTimer = setInterval(() => this.sweepPeers(), 5000)
    peerTimer.unref()
    this.peerTimer = peerTimer
    const limitTimer = setInterval(() => this.reportLimits(), this.opts.limitLogMs ?? LIMIT_LOG_MS)
    limitTimer.unref()
    this.limitTimer = limitTimer
    try {
      await this.openRecord()
      await this.openAnalytics()
      await this.openPeers()
      await this.openPolicy()
      await this.openApi()
    } catch (err) {
      await this.close()
      throw err
    }
    return this.bound
  }

  /**
   * Prove this relay's key from its listen port and wait until the seed lists it.
   * The seed records the source address of that proof, which is the address
   * other peers will be told to use.
   */
  async join(seed: Endpoint, timeoutMs = 1500, pinned: string | null = null): Promise<string> {
    if (!this.identity || !this.socket || !this.bound) throw new Error("relay has not started")
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("join timeout must be >= 0")
    const started = Date.now()
    let answered = false
    while (Date.now() - started <= timeoutMs) {
      if (this.closed || !this.socket) break
      await sendUdp(this.socket, encodeJoin(), seed)
      const table = await readRelayTable(seed, { timeoutMs: 200, attempts: 1 }).catch(() => null)
      if (table && pinned && table.id !== pinned) throw new PinnedSeedError(seed, table.id, pinned)
      if (table?.peers.some((peer) => peer.id === this.identity?.id)) {
        this.armUsage(seed)
        return table.id
      }
      if (table) answered = true
      await sleep(30)
    }
    throw new JoinError(seed, answered ? "the seed answered but did not list this relay" : "the seed did not answer")
  }

  /**
   * Join at startup, retrying with backoff, then keep checking that the seed
   * still lists this relay. The seed's signed peer table is the check, so a
   * seed that restarted or forgot this relay is joined again. Each new join
   * looks the seed's name up again. Throws only when the startup window ends
   * without a join, or when a pinned seed answers with a different id.
   */
  async stayJoined(target: JoinTarget, opts: StayJoinedOptions = {}): Promise<void> {
    const startupMs = opts.startupMs ?? JOIN_STARTUP_MS
    const attemptMs = opts.attemptMs ?? 1500
    const started = Date.now()
    let delay = opts.firstRetryMs ?? 1000
    let lastError: Error | null = null
    for (let attempt = 1; ; attempt++) {
      try {
        await this.joinOnce(target, attemptMs)
        break
      } catch (err) {
        if (err instanceof PinnedSeedError) throw err
        lastError = err instanceof Error ? err : new Error(String(err))
        this.emit("error", "error", { reason: "join", addr: target.label, attempt })
      }
      if (this.closed) throw new Error("relay closed")
      if (Date.now() - started + delay > startupMs) {
        const seconds = Math.round(startupMs / 1000)
        const why = lastError instanceof JoinError ? lastError.why : lastError.message
        throw new Error(`relay did not join ${target.label} within ${seconds}s: ${why}`)
      }
      await sleep(delay)
      delay = Math.min(delay * 2, JOIN_RETRY_MAX_MS)
    }
    this.joinTarget = target
    this.joinCheckMs = opts.checkMs ?? MEMBERSHIP_CHECK_MS
    this.joinMaxCheckMs = opts.maxCheckMs ?? MEMBERSHIP_CHECK_MAX_MS
    this.joinAttemptMs = attemptMs
    this.scheduleMembership(this.joinCheckMs)
  }

  private async joinOnce(target: JoinTarget, attemptMs: number): Promise<void> {
    const seed = await target.resolve()
    const id = await this.join(seed, attemptMs, target.id)
    this.emit("info", "joined", { addr: `${seed.host}:${seed.port}`, seed: id })
  }

  private scheduleMembership(waitMs: number): void {
    if (this.closed) return
    if (this.membershipTimer) clearTimeout(this.membershipTimer)
    const timer = setTimeout(() => {
      this.membershipTimer = null
      void this.checkMembership().then((next) => this.scheduleMembership(next))
    }, waitMs)
    timer.unref()
    this.membershipTimer = timer
  }

  /** Returns the wait before the next check. A missing seed doubles it, up to the cap. */
  private async checkMembership(): Promise<number> {
    const target = this.joinTarget
    const seed = this.seedEndpoint
    if (!target || !seed || this.closed || !this.identity) return this.joinCheckMs
    const table = await readRelayTable(seed, { timeoutMs: 500, attempts: 3 }).catch(() => null)
    if (this.closed) return this.joinCheckMs
    if (table && target.id && table.id !== target.id) {
      this.emit("error", "error", { reason: "pinned", addr: `${seed.host}:${seed.port}`, seed: table.id })
      return this.backoffCheck()
    }
    if (table?.peers.some((peer) => peer.id === this.identity?.id)) {
      this.joinBackoffMs = 0
      return this.joinCheckMs
    }
    this.emit("info", "rejoin", { addr: target.label, reason: table ? "missing" : "unreachable" })
    try {
      await this.joinOnce(target, this.joinAttemptMs)
      this.joinBackoffMs = 0
      return this.joinCheckMs
    } catch (err) {
      const reason = err instanceof PinnedSeedError ? "pinned" : "join"
      this.emit("error", "error", { reason, addr: target.label })
      return this.backoffCheck()
    }
  }

  private backoffCheck(): number {
    this.joinBackoffMs = Math.min(this.joinMaxCheckMs, Math.max(this.joinCheckMs, this.joinBackoffMs * 2))
    return this.joinBackoffMs
  }

  /** Tell the seed how many bytes this relay has forwarded. */
  async publishUsage(): Promise<void> {
    if (!this.identity || !this.socket || !this.seedEndpoint || this.closed) return
    this.usageSeq += 1
    try {
      await sendUdp(
        this.socket,
        encodeUsage(this.identity, this.usageSeq, this.ownBytes(), this.ownTransfers()),
        this.seedEndpoint,
      )
    } catch {
      // The next report carries a later sequence.
    }
  }

  snapshot(): RelaySnapshot {
    this.sweepPeers()
    let bytes = this.ownBytes()
    let transfers = this.ownTransfers()
    let online = 0
    for (const peer of this.peers.values()) {
      if (this.isBlocked(peer.id)) continue
      if (!peer.quiet) online++
      const reported = this.usage.get(peer.id)
      if (!reported) continue
      bytes += reported.bytes
      transfers += reported.transfers
    }
    return { relays: online + (this.identity ? 1 : 0), bytes, transfers }
  }

  /** Relays this seed knows. Online relays come first, then the most recently heard. */
  directory(): RelayDirectory {
    this.sweepPeers()
    const relays: ListedRelay[] = []
    if (this.identity && this.bound) {
      relays.push({
        id: this.identity.id,
        host: this.bound.host,
        port: this.bound.port,
        online: true,
        seen: Date.now(),
        bytes: this.ownBytes(),
        transfers: this.ownTransfers(),
      })
    }
    for (const peer of this.peers.values()) {
      if (this.isBlocked(peer.id)) continue
      const reported = this.usage.get(peer.id)
      relays.push({
        id: peer.id,
        host: peer.endpoint.host,
        port: peer.endpoint.port,
        online: !peer.quiet,
        seen: peer.seenAt,
        bytes: reported?.bytes ?? 0,
        transfers: reported?.transfers ?? 0,
      })
    }
    relays.sort((a, b) => Number(b.online) - Number(a.online) || b.seen - a.seen)
    return { relays }
  }

  /** Counters for this process. Joined relays and the analytics file stay on `snapshot`. */
  report(): RelayReport {
    return {
      uptimeMs: this.startedAt === 0 ? 0 : Math.max(0, Date.now() - this.startedAt),
      forwarded: this.stats.forwarded,
      bytes: this.stats.forwardedBytes,
      data: this.dataFrames,
      acks: this.ackFrames,
      nacks: this.nackFrames,
      duplicates: this.duplicateTesserae,
      denied: this.stats.droppedDenied,
      invalid: this.stats.droppedInvalid,
      limited: this.stats.droppedLimited,
      limitedBy: { ...this.stats.limitedBy },
    }
  }

  private limit(reason: LimitReason): void {
    this.stats.droppedLimited++
    this.stats.limitedBy[reason]++
  }

  /** One line per interval while a cap is dropping, with the drops since the last line. */
  private reportLimits(): void {
    const now = this.stats.limitedBy
    const last = this.limitsLogged
    const fields: Record<string, number> = {}
    let total = 0
    for (const reason of Object.keys(now) as LimitReason[]) {
      const delta = now[reason] - last[reason]
      fields[reason] = delta
      total += delta
    }
    this.limitsLogged = { ...now }
    if (total > 0) this.emit("info", "limited", fields)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.usageTimer) clearInterval(this.usageTimer)
    this.usageTimer = null
    if (this.peerTimer) clearInterval(this.peerTimer)
    this.peerTimer = null
    if (this.analyticsTimer) clearInterval(this.analyticsTimer)
    this.analyticsTimer = null
    if (this.peersTimer) clearInterval(this.peersTimer)
    this.peersTimer = null
    if (this.policyTimer) clearInterval(this.policyTimer)
    this.policyTimer = null
    if (this.recordTimer) clearInterval(this.recordTimer)
    this.recordTimer = null
    if (this.limitTimer) clearInterval(this.limitTimer)
    this.limitTimer = null
    if (this.membershipTimer) clearTimeout(this.membershipTimer)
    this.membershipTimer = null
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    await this.flushAnalytics()
    await this.flushPeers()
    const http = this.http
    this.http = null
    this.httpEndpoint = null
    if (http) await closeRelayApi(http).catch(() => {})
    const socket = this.socket
    this.socket = null
    if (socket) await closeUdp(socket).catch(() => {})
  }

  private onPacket(msg: Buffer, remote: Endpoint): void {
    if (this.closed || !this.socket) return
    if (isIdentityPacket(msg)) {
      this.noteReturn(remote, msg)
      this.answer(msg, remote)
      return
    }
    if (msg.length > MAX_FORWARD_DATAGRAM) {
      this.stats.droppedInvalid++
      return
    }
    const env = decodeEnvelope(msg)
    if (!env) {
      // A packet that isn't an envelope may still belong to a local endpoint, such as a return frame for an attachment.
      if (this.localDelivery?.deliverReturn(msg, remote)) {
        // A matched return frame proves this source is a real relay we forward to, even though a bare
        // frame is not structural on its own, so reopen its destination budget directly.
        this.markReturningDest(remote)
        return
      }
      this.stats.droppedInvalid++
      return
    }
    // Forwarding an inner envelope would chain relays and hide the frame's session from admission.
    if (startsEnvelope(env.inner)) {
      this.stats.droppedInvalid++
      return
    }
    // A forwarded identity packet would reach the next relay as if this relay sent it, and start handshakes in its name.
    if (startsIdentity(env.inner)) {
      this.stats.droppedInvalid++
      return
    }
    this.noteReturn(remote, msg)
    if (!this.opts.allowRemote && !isLoopback(env.dest.host)) {
      this.stats.droppedDenied++
      return
    }
    if (this.opts.allowRemote && !destinationAllowed(env.dest.host, this.allowDest)) {
      this.stats.droppedDenied++
      return
    }
    if (this.endpointBlocked(remote)) {
      this.stats.droppedDenied++
      return
    }
    if (this.opts.correlated && peekRelayFrame(env.inner)?.kind === "data" && this.opts.correlated.closedNow()) {
      this.stats.droppedLoss++
      return
    }
    const decision = this.admit(msg.length)
    if (decision.action === "drop") {
      if (decision.reason === "blackhole") this.stats.droppedBlackhole++
      else this.stats.droppedLoss++
      return
    }
    const session = peekRelayFrame(env.inner)?.sessionPrefix ?? null
    const limited = this.gate?.admitDatagram(msg.length, session) ?? null
    if (limited) {
      this.limit(limited)
      return
    }
    if (this.opts.allowRemote && !this.dests.spend(env.dest, env.inner.length)) {
      this.limit("destination")
      return
    }
    const socket = this.socket
    const forward = () => {
      if (this.closed) return
      this.announce(env.inner, remote, env.dest)
      this.onForward?.(env.inner)
      socket.send(env.inner, env.dest.port, env.dest.host, (err) => {
        if (err) return
        this.stats.forwarded++
        this.stats.forwardedBytes += env.inner.length
        this.markAnalytics()
        this.noteForwarded(env.inner)
        this.noteTransfer(env.inner)
      })
    }
    if (decision.waitMs <= 0) {
      forward()
      return
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      forward()
    }, decision.waitMs)
    this.timers.add(timer)
  }

  /**
   * Send `packet` to a relay destination `to` for a locally attached endpoint. The same
   * destination policy, datagram size, and limits apply as to a forwarded UDP packet, so an
   * attachment is not a way around them. This is the only path from a local endpoint to UDP,
   * and it is never reached from a packet that arrived over UDP, so there is no second hop.
   *
   * A local endpoint forwards an ordinary tesera envelope, so the same hardening as a UDP
   * forward applies: the packet must be an envelope, and its inner frame must be neither
   * another envelope nor an identity packet, so an attachment cannot chain relays or start a
   * handshake in this relay's name.
   */
  forwardForLocal(packet: Buffer, to: Endpoint): ForwardResult {
    if (!this.socket || this.closed) return "closed"
    if (packet.length > MAX_FORWARD_DATAGRAM) return "too-large"
    if (!this.opts.allowRemote && !isLoopback(to.host)) return "denied"
    if (this.opts.allowRemote && !destinationAllowed(to.host, this.allowDest)) return "denied"
    const env = decodeEnvelope(packet)
    if (!env) return "invalid"
    if (startsEnvelope(env.inner)) return "invalid"
    if (startsIdentity(env.inner)) return "invalid"
    const session = peekRelayFrame(env.inner)?.sessionPrefix ?? null
    if (this.gate?.admitDatagram(packet.length, session)) return "limited"
    if (this.opts.allowRemote && !this.dests.spend(to, packet.length)) return "limited"
    this.socket.send(packet, to.port, to.host)
    return "ok"
  }

  /** Count frames this process forwarded, including a tessera sent through here again. */
  private noteForwarded(inner: Buffer): void {
    const frame = peekRelayFrame(inner)
    if (!frame) return
    if (frame.kind === "data") this.dataFrames++
    else if (frame.kind === "ack") this.ackFrames++
    else this.nackFrames++
    if (frame.kind !== "data") return
    const key = `${frame.sessionPrefix}:${frame.blockId}:${frame.tesseraIndex}`
    if (this.seenTesserae.has(key)) {
      this.duplicateTesserae++
      return
    }
    if (this.seenTesserae.size >= 100_000) return
    this.seenTesserae.add(key)
  }

  /** Count a transfer once this relay has forwarded the data and an acknowledgement. */
  private noteTransfer(inner: Buffer): void {
    if (this.transfers.size >= 100_000) return
    const frame = peekRelayFrame(inner)
    if (!frame || (frame.kind !== "data" && frame.kind !== "ack")) return
    const prefix = frame.sessionPrefix
    if (this.transfers.has(prefix)) return
    const side = frame.kind === "data" ? this.sent : this.acked
    if (!side.has(prefix) && side.size >= 100_000) return
    side.add(prefix)
    if (!this.sent.has(prefix) || !this.acked.has(prefix)) return
    this.transfers.add(prefix)
    this.sent.delete(prefix)
    this.acked.delete(prefix)
  }

  private announce(inner: Buffer, remote: Endpoint, dest: Endpoint): void {
    const frame = peekRelayFrame(inner)
    if (!frame) return
    const token = `${frame.sessionPrefix}:${frame.kind}:${frame.blockId}`
    if (this.announced.has(token)) return
    if (this.announced.size > 8192) this.announced.clear()
    this.announced.add(token)
    const fields = {
      block: frame.blockId,
      from: `${remote.host}:${remote.port}`,
      to: `${dest.host}:${dest.port}`,
    }
    const event = frame.kind === "data" ? "block-in" : `block-${frame.kind}`
    this.emit("debug", event, fields)
  }

  private answer(msg: Buffer, remote: Endpoint): void {
    if (!this.identity || !this.socket) return
    let from: Endpoint
    try {
      from = { host: normalizeHost(remote.host), port: remote.port }
    } catch {
      return
    }
    if (!this.opts.allowRemote && !isLoopback(from.host)) return
    if (isRecordAsk(msg)) {
      if (this.recordPacket) this.sendIdentity(this.recordPacket, from)
      return
    }
    const challenge = decodeQuery(msg)
    if (challenge) {
      this.sendIdentity(encodeProof(this.identity, challenge), from)
      return
    }
    if (isJoin(msg)) {
      this.invite(from)
      return
    }
    const lookup = decodeLookup(msg)
    if (lookup) {
      this.replyLookup(from, lookup, null)
      return
    }
    const resume = decodeResume(msg)
    if (resume) {
      this.replyLookup(from, resume.challenge, resume.nonce)
      return
    }
    const proof = decodeProof(msg)
    if (proof) {
      this.acceptJoin(from, proof)
      return
    }
    const usage = decodeUsage(msg)
    if (usage) {
      this.noteUsage(from, usage)
      return
    }
    const census = decodeSnapshotQuery(msg)
    if (!census || !this.identity) return
    this.sendIdentity(encodeSnapshot(this.identity, census, this.snapshot()), from)
  }

  /** Identity replies share the datagram and bandwidth budgets. The peer table waits for a second packet. */
  private sendIdentity(packet: Buffer, to: Endpoint): boolean {
    if (!this.socket) return false
    const limited = this.gate?.admitDatagram(packet.length, null) ?? null
    if (limited) {
      this.limit(limited)
      return false
    }
    this.socket.send(packet, to.port, to.host)
    return true
  }

  private replyLookup(from: Endpoint, challenge: Buffer, nonce: Buffer | null): void {
    if (!this.identity) return
    const key = `${from.host}:${from.port}`
    const now = Date.now()
    this.sweepTable(now)
    const readyAt = this.tableReady.get(key)
    if (readyAt !== undefined) {
      this.sendTable(from, challenge)
      this.tableReady.set(key, now)
      return
    }
    const pending = this.tableAsked.get(key)
    if (nonce && pending && pending.nonce.equals(nonce)) {
      this.tableAsked.delete(key)
      this.sendTable(from, challenge)
      this.tableReady.set(key, now)
      return
    }
    if (this.tableAsked.size >= TABLE_PENDING_MAX && !this.tableAsked.has(key)) {
      this.limit("table")
      return
    }
    const issued = randomBytes(16)
    this.tableAsked.set(key, { nonce: issued, at: now })
    this.sendIdentity(encodeAgain(challenge, issued), from)
  }

  private sendTable(from: Endpoint, challenge: Buffer): void {
    if (!this.identity) return
    this.sweepPeers()
    const listed = [...this.peers.values()].filter((peer) => !peer.quiet && !this.isBlocked(peer.id))
    this.sendIdentity(encodeTable(this.identity, challenge, listed), from)
  }

  private sweepTable(now: number): void {
    for (const [key, pending] of this.tableAsked) {
      if (now - pending.at >= TABLE_NONCE_TTL_MS) this.tableAsked.delete(key)
    }
    for (const [key, at] of this.tableReady) {
      if (now - at >= TABLE_READY_TTL_MS) this.tableReady.delete(key)
    }
  }

  private noteReturn(remote: Endpoint, msg: Buffer): void {
    if (!this.opts.allowRemote) return
    if (!isStructuralTesera(msg)) return
    this.markReturningDest(remote)
  }

  private markReturningDest(remote: Endpoint): void {
    if (!this.opts.allowRemote) return
    let from: Endpoint
    try {
      from = { host: normalizeHost(remote.host), port: remote.port }
    } catch {
      return
    }
    this.dests.markReachable(from)
  }

  private armUsage(seed: Endpoint): void {
    this.seedEndpoint = seed
    if (this.usageTimer) clearInterval(this.usageTimer)
    const timer = setInterval(() => {
      void this.publishUsage()
    }, 5000)
    timer.unref()
    this.usageTimer = timer
    void this.publishUsage()
  }

  private invite(from: Endpoint): void {
    if (!this.socket || from.port < 1) return
    const key = `${from.host}:${from.port}`
    const now = Date.now()
    let pending = this.pending.get(key)
    if (!pending || now - pending.at >= 2000) {
      pending = { challenge: randomBytes(16), at: now }
      this.pending.set(key, pending)
    }
    if (this.pending.size > 64) {
      for (const [addr, entry] of this.pending) {
        if (now - entry.at >= 2000) this.pending.delete(addr)
      }
    }
    this.sendIdentity(encodeQuery(pending.challenge), from)
  }

  private acceptJoin(from: Endpoint, proof: Proof): void {
    if (!this.identity || from.port < 1) return
    const key = `${from.host}:${from.port}`
    const pending = this.pending.get(key)
    if (!pending || !proof.challenge.equals(pending.challenge) || !verifyProof(proof)) return
    this.pending.delete(key)
    let id: string
    try {
      id = formatId(proof.publicKey)
    } catch {
      return
    }
    if (id === this.identity.id) return
    const decision = this.gate?.admitIdentity(id) ?? "ok"
    if (decision !== "ok") {
      this.reject(id, decision, `${from.host}:${from.port}`)
      return
    }
    if (!this.peers.has(id) && this.gate && !this.gate.admitJoin()) {
      this.reject(id, "rate", `${from.host}:${from.port}`)
      return
    }
    if (!this.makeRoom(id)) return
    const previous = this.peers.get(id)
    const peer = { id, endpoint: from, seenAt: Date.now(), quiet: false }
    this.peers.set(id, peer)
    this.markPeers()
    const addr = `${from.host}:${from.port}`
    if (previous?.quiet && previous.endpoint.host === from.host && previous.endpoint.port === from.port) {
      this.emit("info", "online", { id, addr })
      return
    }
    if (previous && previous.endpoint.host === from.host && previous.endpoint.port === from.port) return
    this.emit("info", "join", { id, addr })
  }

  /** A remembered relay's usage report puts it back in the count at the address the report came from. */
  private noteUsage(from: Endpoint, usage: { id: string; seq: number; bytes: number; transfers: number }): void {
    const peer = this.peers.get(usage.id)
    if (!peer || peer.id === this.identity?.id || this.isBlocked(usage.id)) return
    const previous = this.usage.get(usage.id)
    const restarted = previous !== undefined && usage.seq < previous.seq && previous.seq - usage.seq > 1
    if (!previous || usage.seq > previous.seq || restarted) {
      this.usage.set(usage.id, { seq: usage.seq, bytes: usage.bytes, transfers: usage.transfers })
    }
    const moved = peer.endpoint.host !== from.host || peer.endpoint.port !== from.port
    peer.endpoint = from
    peer.seenAt = Date.now()
    this.markPeers()
    const addr = `${from.host}:${from.port}`
    if (peer.quiet) {
      peer.quiet = false
      this.emit("info", "online", { id: usage.id, addr })
      return
    }
    if (moved) this.emit("info", "join", { id: usage.id, addr })
  }

  /** Drop the longest-quiet relay when a new one needs a slot. */
  private makeRoom(id: string): boolean {
    if (this.peers.has(id) || this.peers.size < MAX_INTRODUCED) return true
    let oldest: RememberedRelay | null = null
    for (const peer of this.peers.values()) {
      if (!peer.quiet) continue
      if (!oldest || peer.seenAt < oldest.seenAt) oldest = peer
    }
    if (!oldest) return false
    this.peers.delete(oldest.id)
    this.usage.delete(oldest.id)
    this.markPeers()
    this.emit("info", "forget", { id: oldest.id, addr: `${oldest.endpoint.host}:${oldest.endpoint.port}` })
    return true
  }

  /** Hide a relay that stopped reporting, and forget it once the keep window ends. */
  private sweepPeers(now = Date.now()): void {
    const hideAfter = this.peerOfflineMs
    const forgetAfter = this.peerOfflineMs + this.settings.peerTtlMs
    for (const peer of this.peers.values()) {
      const age = now - peer.seenAt
      if (age >= forgetAfter) {
        this.peers.delete(peer.id)
        this.usage.delete(peer.id)
        this.markPeers()
        this.emit("info", "forget", { id: peer.id, addr: `${peer.endpoint.host}:${peer.endpoint.port}` })
        continue
      }
      if (age >= hideAfter && !peer.quiet) {
        peer.quiet = true
        this.markPeers()
        this.emit("info", "offline", { id: peer.id, addr: `${peer.endpoint.host}:${peer.endpoint.port}` })
      }
    }
  }

  private ownBytes(): number {
    return this.storedBytes + this.stats.forwardedBytes
  }

  private ownTransfers(): number {
    return this.storedTransfers + this.transfers.size
  }

  private emit(level: LogLevel, event: string, fields: Record<string, string | number>): void {
    const log = this.opts.log
    if (!log || !allowsLog(this.settings.logLevel, level)) return
    log(formatLog("relay", event, fields))
  }

  private async openAnalytics(): Promise<void> {
    const path = this.settings.analyticsFile
    if (!path) return
    const totals = await readAnalytics(path)
    this.storedBytes = totals.bytes
    this.storedTransfers = totals.transfers
    await writeAnalytics(path, totals)
    const timer = setInterval(() => {
      void this.flushAnalytics()
    }, 1000)
    timer.unref()
    this.analyticsTimer = timer
  }

  private markAnalytics(): void {
    if (this.settings.analyticsFile) this.analyticsDirty = true
  }

  private async flushAnalytics(): Promise<void> {
    const path = this.settings.analyticsFile
    if (!path || !this.analyticsDirty) return
    const totals = { bytes: this.ownBytes(), transfers: this.ownTransfers() }
    this.analyticsDirty = false
    try {
      await writeAnalytics(path, totals)
    } catch {
      this.analyticsDirty = true
      this.emit("error", "error", { reason: "metrics" })
    }
  }

  private async openPeers(): Promise<void> {
    const path = this.settings.peersFile
    if (!path) return
    const stored = await readPeers(path)
    for (const peer of stored) {
      this.peers.set(peer.id, {
        id: peer.id,
        endpoint: { host: peer.host, port: peer.port },
        seenAt: peer.seenAt,
        quiet: false,
      })
      if (peer.seq > 0 || peer.bytes > 0 || peer.transfers > 0) {
        this.usage.set(peer.id, { seq: peer.seq, bytes: peer.bytes, transfers: peer.transfers })
      }
    }
    this.sweepPeers()
    await writePeers(path, this.peerRecords())
    this.peersDirty = false
    const timer = setInterval(() => {
      void this.flushPeers()
    }, 1000)
    timer.unref()
    this.peersTimer = timer
  }

  private markPeers(): void {
    if (this.settings.peersFile) this.peersDirty = true
  }

  private peerRecords(): StoredPeer[] {
    return [...this.peers.values()].map((peer) => {
      const reported = this.usage.get(peer.id)
      return {
        id: peer.id,
        host: peer.endpoint.host,
        port: peer.endpoint.port,
        seenAt: peer.seenAt,
        seq: reported?.seq ?? 0,
        bytes: reported?.bytes ?? 0,
        transfers: reported?.transfers ?? 0,
      }
    })
  }

  private async flushPeers(): Promise<void> {
    const path = this.settings.peersFile
    if (!path || !this.peersDirty) return
    const peers = this.peerRecords()
    this.peersDirty = false
    try {
      await writePeers(path, peers)
    } catch {
      this.peersDirty = true
      this.emit("error", "error", { reason: "peers" })
    }
  }

  private async openApi(): Promise<void> {
    const api = this.settings.api
    if (!api) return
    const listened = await listenRelayApi(api.host, api.port, {
      stats: () => this.snapshot(),
      relay: () => this.report(),
      peers: () => this.directory(),
      record: () => (this.recordPacket ? recordDocument(this.recordPacket) : null),
      transports: () => ({ statements: this.opts.transportStatements?.() ?? [] }),
    })
    this.http = listened.server
    this.httpEndpoint = listened.endpoint
    this.emit("info", "api", { addr: `${listened.endpoint.host}:${listened.endpoint.port}` })
  }

  private nowSec(): number {
    return Math.floor(Date.now() / 1000)
  }

  private async openRecord(): Promise<void> {
    if (!this.identity || !this.recordClaims) return
    let stored: Buffer | null = null
    if (this.recordFile) {
      try {
        stored = await readRecordFile(this.recordFile)
      } catch {
        this.emit("error", "error", { reason: "record" })
        return
      }
    }
    try {
      await this.adoptRecord(stored)
    } catch {
      this.emit("error", "error", { reason: "record" })
      return
    }
    const timer = setInterval(() => {
      void this.refreshRecord()
    }, 60_000)
    timer.unref()
    this.recordTimer = timer
  }

  private async refreshRecord(): Promise<void> {
    if (!this.identity || !this.recordClaims || !this.recordPacket || this.closed) return
    try {
      const planned = planRecord({
        identity: this.identity,
        claims: this.recordClaims,
        stored: this.recordPacket,
        nowSec: this.nowSec(),
      })
      if (planned.reused) return
      if (this.recordFile) await writeRecordFile(this.recordFile, planned.packet)
      this.recordPacket = planned.packet
      this.emit("info", "record", { seq: planned.seq.toString() })
    } catch {
      this.emit("error", "error", { reason: "record" })
    }
  }

  private async adoptRecord(stored: Buffer | null): Promise<void> {
    if (!this.identity || !this.recordClaims) return
    const planned = planRecord({
      identity: this.identity,
      claims: this.recordClaims,
      stored,
      nowSec: this.nowSec(),
    })
    if (!planned.reused && this.recordFile) await writeRecordFile(this.recordFile, planned.packet)
    this.recordPacket = planned.packet
    this.emit("info", "record", { seq: planned.seq.toString() })
  }

  private admit(bytes: number): Admit {
    const local = this.sim.admit(bytes)
    if (local.action === "drop" || !this.opts.shared) return local
    const extra = this.opts.shared.admit(bytes)
    if (extra.action === "drop") return extra
    return { action: "forward", waitMs: local.waitMs + extra.waitMs }
  }

  private isBlocked(id: string): boolean {
    return this.gate?.isBlocked(id) ?? false
  }

  private endpointBlocked(from: Endpoint): boolean {
    if (!this.gate) return false
    for (const peer of this.peers.values()) {
      if (!this.gate.isBlocked(peer.id)) continue
      if (peer.endpoint.host === from.host && peer.endpoint.port === from.port) return true
    }
    return false
  }

  private reject(id: string, reason: string, addr: string): void {
    const key = `${id}:${reason}`
    if (this.rejections.has(key)) return
    this.rejections.add(key)
    this.emit("info", "reject", { id, reason, addr })
  }

  private async openPolicy(): Promise<void> {
    if (!this.gate || !this.policyFile) return
    const file = await readPolicy(this.policyFile)
    const allowed = uniqueIds([...file.allowed, ...this.gate.allows()])
    const blocked = uniqueIds([...file.blocked, ...this.gate.blocks()])
    this.gate.setLists(allowed, blocked)
    for (const id of file.forget) this.forgetPeer(id)
    const latest = await readPolicy(this.policyFile)
    const done = new Set(file.forget)
    await writePolicy(this.policyFile, {
      allowed,
      blocked,
      forget: latest.forget.filter((id) => !done.has(id)),
    })
    const timer = setInterval(() => {
      void this.refreshPolicy()
    }, 1000)
    timer.unref()
    this.policyTimer = timer
  }

  private async refreshPolicy(): Promise<void> {
    if (!this.gate || !this.policyFile) return
    let file
    try {
      file = await readPolicy(this.policyFile)
    } catch {
      this.emit("error", "error", { reason: "policy" })
      return
    }
    this.gate.setLists(file.allowed, file.blocked)
    if (file.forget.length === 0) return
    for (const id of file.forget) this.forgetPeer(id)
    try {
      const latest = await readPolicy(this.policyFile)
      const done = new Set(file.forget)
      await writePolicy(this.policyFile, {
        allowed: latest.allowed,
        blocked: latest.blocked,
        forget: latest.forget.filter((id) => !done.has(id)),
      })
    } catch {
      this.emit("error", "error", { reason: "policy" })
    }
  }

  private forgetPeer(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    this.peers.delete(id)
    this.usage.delete(id)
    this.markPeers()
    this.emit("info", "forget", { id, addr: `${peer.endpoint.host}:${peer.endpoint.port}`, reason: "operator" })
  }
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)]
}
