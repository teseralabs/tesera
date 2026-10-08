import { transportOrUdp, type Endpoint, type OpenTransport, type PacketTransport } from "../carrier/transport.js"
import { decodeShards, joinShards } from "../coding/reedsolomon.js"
import {
  DEFAULT_ACK_GRACE_MS,
  DEFAULT_NACK_AFTER_MS,
  DEFAULT_TICK_MS,
  MAX_AHEAD,
  MAX_RETX_BACKOFF_MS,
} from "../constants.js"
import { assertSession, blockAad, deriveKeys, open } from "../crypto/session.js"
import { emptyReceiverStats, type ReceiverStats } from "../metrics.js"
import { encodeEnvelope } from "../protocol/envelope.js"
import { decodeFrame, encodeAck, encodeNack, encodeSample, type DataFrame } from "../protocol/frames.js"
import { asError, Signal, sleep } from "../util.js"
import { addressPerRelay, type PeerAddress } from "./address.js"
import type { Probe } from "./probe.js"

type PartialBlock = {
  k: number
  n: number
  cipherLen: number
  shardLen: number
  shards: Map<number, Buffer>
  firstSeen: number
}

type ReadyBlock = {
  body: Buffer
  fin: boolean
  latencyMs: number
}

export type ReceiverOptions = {
  session: Buffer
  relays: Endpoint[]
  /** The sender's address in each envelope: one for every relay, or one per relay in relay order. */
  sender?: PeerAddress
  /** The sender's session id, when known ahead. Omitted means the first valid data frame picks it. */
  sessionId?: Uint8Array
  /** How packets travel. Omitted means a UDP socket on `bindHost:bindPort`. */
  transport?: OpenTransport
  bindHost?: string
  bindPort?: number
  nackAfterMs?: number
  tickMs?: number
  maxAhead?: number
  /**
   * Delivered bytes that `read` has not taken yet, past which new blocks wait for their ACK.
   * A slow reader then holds the sender's window instead of growing this queue. Omitted means no limit.
   */
  maxUnreadBytes?: number
  /** Timing notes for diagnostics. */
  probe?: Probe
}

export class TeseraReceiver {
  readonly stats: ReceiverStats = emptyReceiverStats()
  onPeerFail: ((err: Error) => void) | null = null

  private readonly secret: Buffer
  private aeadKey: Buffer | null = null
  private macKey: Buffer | null = null
  private readonly relays: Endpoint[]
  private readonly nackAfterMs: number
  private readonly tickMs: number
  private readonly maxAhead: number
  private readonly openTransport: OpenTransport
  private readonly probe: Probe | null
  private readonly partials = new Map<number, PartialBlock>()
  private readonly ready = new Map<number, ReadyBlock>()
  private readonly done = new Set<number>()
  private readonly missingSince = new Map<number, number>()
  private readonly arrived = new Map<number, Set<number>>()
  private readonly decoded = new Set<number>()
  /** Delivered block ids that may still be acknowledged. Bounded by the receive window. */
  private readonly ackable = new Set<number>()
  /** When each incomplete block may be NACKed again. */
  private readonly nackPace = new Map<number, { nextAt: number; waitMs: number }>()
  private settledMissing = 0
  private settledPartial = 0
  private readonly chunks: Buffer[] = []
  private unreadBytes = 0
  private readonly maxUnreadBytes: number
  /** Blocks held unacknowledged until `read` brings the unread bytes back under the limit. */
  private readonly heldAcks = new Map<number, number>()
  private readonly readWake = new Signal()

  private transport: PacketTransport | null = null
  private bound: Endpoint | null = null
  /** By relay index. */
  private senders: Endpoint[] | null
  private sessionId: Buffer | null = null
  private k = 0
  private n = 0
  private nextDeliver = 0
  private highestSeen = -1
  private gapsFrom = 0
  private streamEnded = false
  private stopped = false
  private closed = false
  private error: Error | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: ReceiverOptions) {
    assertSession(opts.session)
    this.secret = opts.session
    if (opts.relays.length < 1) throw new Error("receiver needs at least one relay")
    this.relays = opts.relays
    this.senders = opts.sender ? addressPerRelay(opts.sender, opts.relays) : null
    this.nackAfterMs = opts.nackAfterMs ?? DEFAULT_NACK_AFTER_MS
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.maxAhead = opts.maxAhead ?? MAX_AHEAD
    this.maxUnreadBytes = opts.maxUnreadBytes ?? Infinity
    if (!(this.maxUnreadBytes > 0)) throw new Error("maxUnreadBytes must be > 0")
    this.openTransport = transportOrUdp(opts)
    this.probe = opts.probe ?? null
    if (opts.sessionId) this.adopt(Buffer.from(opts.sessionId))
  }

  get endpoint(): Endpoint {
    if (!this.bound) throw new Error("receiver has not started")
    return this.bound
  }

  /** How far past the next block to deliver this receiver accepts blocks. A sender must stay inside it. */
  get ahead(): number {
    return this.maxAhead
  }

  setSender(sender: PeerAddress): void {
    this.senders = addressPerRelay(sender, this.relays)
  }

  async start(): Promise<Endpoint> {
    const transport = await this.openTransport({
      packet: (packet, from) => {
        void this.onMessage(Buffer.from(packet), from).catch((err) => this.fail(err))
      },
      error: (err) => this.fail(err),
    })
    this.transport = transport
    this.bound = transport.endpoint
    this.arm()
    return this.bound
  }

  async read(): Promise<Uint8Array | null> {
    for (;;) {
      const next = this.chunks.shift()
      if (next) {
        this.unreadBytes -= next.length
        this.releaseAcks()
        return next
      }
      if (this.error) throw this.error
      if (this.streamEnded && this.ready.size === 0) return null
      await this.readWake.wait()
    }
  }

  /**
   * Keep answering after the last block. The sender may still be waiting for
   * an ACK that was lost, and only a repeat from it can tell us so.
   */
  async linger(graceMs = DEFAULT_ACK_GRACE_MS): Promise<void> {
    if (!this.streamEnded || this.error || this.closed) return
    await sleep(graceMs)
  }

  fail(err: unknown): void {
    if (this.error || this.closed) return
    this.error = asError(err)
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.readWake.notify()
    this.onPeerFail?.(this.error)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.error && !this.streamEnded) this.error = new Error("receiver closed before completion")
    this.readWake.notify()
    const transport = this.transport
    this.transport = null
    if (transport) await transport.close().catch(() => {})
  }

  /** The first session id selects the keys. A different id is not stored. */
  private adopt(sessionId: Buffer): boolean {
    if (this.sessionId && this.aeadKey && this.macKey) return this.sessionId.equals(sessionId)
    const keys = deriveKeys(this.secret, sessionId)
    this.sessionId = Buffer.from(sessionId)
    this.aeadKey = keys.aeadKey
    this.macKey = keys.macKey
    return true
  }

  private async onMessage(msg: Buffer, remote: Endpoint): Promise<void> {
    if (this.closed || this.error) return
    // A data frame has no MAC and the first one picks the session id, so only relays may deliver.
    const via = this.relayIndex(remote)
    if (via < 0) return
    const probe = this.probe
    const t0 = probe ? performance.now() : 0
    const frame = decodeFrame(msg, this.macKey)
    if (probe) probe.note("receiver.data-decode", performance.now() - t0)
    if (!frame || frame.kind !== "data") return
    if (this.sessionId && !this.sessionId.equals(frame.sessionId)) return
    if (frame.blockId < this.nextDeliver) {
      probe?.note("receiver.late-tessera", 1)
      if (this.ackable.has(frame.blockId)) await this.ackOrHold(frame.blockId, via)
      return
    }
    if (frame.blockId > this.nextDeliver + this.maxAhead) return
    if (!this.adopt(frame.sessionId)) return
    if (this.done.has(frame.blockId)) {
      probe?.note("receiver.late-tessera", 1)
      await this.ackOrHold(frame.blockId, via)
      return
    }
    const first = this.noteArrival(frame.blockId, frame.tesseraIndex)
    if (first) void this.sendSample(frame.blockId, frame.tesseraIndex, remote).catch(() => {})
    this.acceptTessera(frame, via)
  }

  private acceptTessera(frame: DataFrame, via: number): void {
    if (this.k === 0) {
      this.k = frame.k
      this.n = frame.n
    } else if (frame.k !== this.k || frame.n !== this.n) {
      this.fail(new Error("tesserae disagree on k and n"))
      return
    }
    let partial = this.partials.get(frame.blockId)
    if (!partial) {
      partial = {
        k: frame.k,
        n: frame.n,
        cipherLen: frame.cipherLen,
        shardLen: frame.payload.length,
        shards: new Map(),
        firstSeen: Date.now(),
      }
      this.partials.set(frame.blockId, partial)
      this.missingSince.delete(frame.blockId)
      this.probe?.step(frame.blockId, "first", performance.now())
    } else if (partial.cipherLen !== frame.cipherLen || partial.shardLen !== frame.payload.length) {
      this.fail(new Error(`block ${frame.blockId} tesserae disagree on length`))
      return
    }
    if (!partial.shards.has(frame.tesseraIndex)) partial.shards.set(frame.tesseraIndex, frame.payload)
    if (frame.blockId > this.highestSeen) this.highestSeen = frame.blockId
    this.noteGaps()
    this.noteBuffer()
    if (partial.shards.size >= partial.k) {
      this.probe?.step(frame.blockId, "k", performance.now())
      this.reconstruct(frame.blockId, partial, via)
    }
  }

  private reconstruct(blockId: number, partial: PartialBlock, via: number): void {
    if (this.done.has(blockId)) return
    const parts = [...partial.shards.entries()].map(([index, data]) => ({ index, data }))
    let opened: { fin: boolean; body: Buffer; sentAtMs: number }
    try {
      const t0 = performance.now()
      const dataShards = decodeShards(parts, partial.k, partial.n)
      const cipher = joinShards(dataShards, partial.cipherLen)
      this.stats.decodeMs += performance.now() - t0
      const t1 = performance.now()
      if (!this.aeadKey || !this.sessionId) throw new Error("missing traffic keys")
      opened = open(
        this.aeadKey,
        blockId,
        cipher,
        blockAad({
          sessionId: this.sessionId,
          blockId,
          k: partial.k,
          n: partial.n,
          cipherLen: partial.cipherLen,
          shardLen: partial.shardLen,
        }),
      )
      this.stats.decryptMs += performance.now() - t1
      if (this.probe) {
        this.probe.note("receiver.reconstruct", t1 - t0)
        this.probe.note("receiver.open", performance.now() - t1)
        this.probe.note("receiver.resident", this.partials.size + this.ready.size)
      }
    } catch (err) {
      this.fail(new Error(`block ${blockId} failed integrity check: ${asError(err).message}`))
      return
    }
    this.partials.delete(blockId)
    this.done.add(blockId)
    this.decoded.add(blockId)
    this.missingSince.delete(blockId)
    this.stats.blocksDecoded++
    const latencyMs = Math.max(0, Date.now() - opened.sentAtMs)
    this.ready.set(blockId, { body: opened.body, fin: opened.fin, latencyMs })
    this.drain()
    void this.ackOrHold(blockId, via).catch((err) => this.fail(err))
  }

  /** `via` is the relay that brought the tessera being answered. Its path just worked, so the ACK goes back on it. */
  private async ackOrHold(blockId: number, via: number): Promise<void> {
    if (this.unreadBytes >= this.maxUnreadBytes) {
      if (!this.heldAcks.has(blockId)) this.probe?.note("receiver.ack-held", 1)
      this.heldAcks.set(blockId, via)
      return
    }
    await this.sendAck(blockId, via)
  }

  private releaseAcks(): void {
    if (this.heldAcks.size === 0 || this.unreadBytes >= this.maxUnreadBytes || this.stopped) return
    const held = [...this.heldAcks]
    this.heldAcks.clear()
    for (const [id, via] of held) void this.sendAck(id, via).catch((err) => this.fail(err))
  }

  private drain(): void {
    for (;;) {
      const blockId = this.nextDeliver
      const item = this.ready.get(blockId)
      if (!item) break
      this.ready.delete(blockId)
      this.settle(blockId)
      this.ackable.add(blockId)
      this.nextDeliver++
      this.pruneAckable()
      if (item.body.length > 0) {
        this.chunks.push(item.body)
        this.unreadBytes += item.body.length
        if (this.unreadBytes > this.stats.maxUnreadBytes) this.stats.maxUnreadBytes = this.unreadBytes
        this.stats.outputBytes += item.body.length
      }
      this.probe?.step(blockId, "delivered", performance.now())
      this.stats.latencySumMs += item.latencyMs
      this.stats.latencyCount++
      if (item.latencyMs > this.stats.maxBlockLatencyMs) this.stats.maxBlockLatencyMs = item.latencyMs
      if (item.fin) this.streamEnded = true
    }
    this.noteBuffer()
    this.readWake.notify()
  }

  /**
   * Count blocks that stayed incomplete after late tesserae had a chance to
   * arrive. Decoding itself happens at k tesserae, which is often before the
   * rest of the block shows up.
   */
  recoveryCounts(): { blocksMissingSystematic: number; blocksWithoutAllTesserae: number } {
    let blocksMissingSystematic = this.settledMissing
    let blocksWithoutAllTesserae = this.settledPartial
    for (const id of this.decoded) {
      const set = this.arrived.get(id)
      if (!set || this.k === 0) continue
      let missingSystematic = false
      for (let index = 0; index < this.k; index++) {
        if (!set.has(index)) missingSystematic = true
      }
      if (missingSystematic) blocksMissingSystematic++
      if (set.size < this.n) blocksWithoutAllTesserae++
    }
    return { blocksMissingSystematic, blocksWithoutAllTesserae }
  }

  /** Fold a delivered block into the recovery counters and drop its maps. */
  private settle(blockId: number): void {
    const set = this.arrived.get(blockId)
    if (set && this.k > 0 && this.decoded.has(blockId)) {
      let missingSystematic = false
      for (let index = 0; index < this.k; index++) {
        if (!set.has(index)) missingSystematic = true
      }
      if (missingSystematic) this.settledMissing++
      if (set.size < this.n) this.settledPartial++
    }
    this.arrived.delete(blockId)
    this.decoded.delete(blockId)
    this.done.delete(blockId)
    this.missingSince.delete(blockId)
    this.partials.delete(blockId)
  }

  private pruneAckable(): void {
    const oldest = this.nextDeliver - this.maxAhead
    // Ids go in as they are delivered, so the set iterates oldest first.
    for (const id of this.ackable) {
      if (id >= oldest) break
      this.ackable.delete(id)
    }
  }

  private noteArrival(blockId: number, index: number): boolean {
    let set = this.arrived.get(blockId)
    if (!set) {
      set = new Set()
      this.arrived.set(blockId, set)
    }
    if (set.has(index)) return false
    set.add(index)
    return true
  }

  /** Ids below `gapsFrom` were looked at once already. One that was missing then is in `missingSince`. */
  private noteGaps(): void {
    const from = Math.max(this.nextDeliver, this.gapsFrom)
    this.gapsFrom = Math.max(this.gapsFrom, this.highestSeen)
    for (let id = from; id < this.highestSeen; id++) {
      if (this.done.has(id) || this.partials.has(id) || this.ready.has(id) || this.missingSince.has(id)) continue
      this.missingSince.set(id, Date.now())
    }
  }

  private noteBuffer(): void {
    const size = this.ready.size + this.partials.size
    if (size > this.stats.maxBufferedBlocks) this.stats.maxBufferedBlocks = size
  }

  private async nackTick(): Promise<void> {
    if (this.stopped || !this.senders || this.n === 0) return
    const now = Date.now()
    for (const id of this.nackPace.keys()) {
      if (!this.partials.has(id) && !this.missingSince.has(id)) this.nackPace.delete(id)
    }
    for (const [id, partial] of this.partials) {
      if (now - partial.firstSeen < this.nackAfterMs || !this.nackDue(id, now)) continue
      const missing: number[] = []
      for (let index = 0; index < partial.n; index++) {
        if (!partial.shards.has(index)) missing.push(index)
      }
      if (missing.length > 0) await this.sendNack(id, missing)
    }
    for (const [id, since] of [...this.missingSince.entries()]) {
      if (id < this.nextDeliver || this.partials.has(id) || this.done.has(id) || this.ready.has(id)) {
        this.missingSince.delete(id)
        continue
      }
      if (now - since < this.nackAfterMs || this.n === 0 || !this.nackDue(id, now)) continue
      const missing: number[] = []
      for (let index = 0; index < this.n; index++) missing.push(index)
      await this.sendNack(id, missing)
    }
  }

  /**
   * One block's NACKs back off like the sender's resends. A NACK goes through
   * every relay, so repeating it on every tick would spend the relays' caps on
   * requests instead of the tesserae being asked for.
   */
  private nackDue(id: number, now: number): boolean {
    const pace = this.nackPace.get(id)
    if (pace && now < pace.nextAt) return false
    const waitMs = pace ? Math.min(MAX_RETX_BACKOFF_MS, pace.waitMs * 2) : this.nackAfterMs
    this.nackPace.set(id, { nextAt: now + waitMs, waitMs })
    return true
  }

  private async sendSample(blockId: number, tesseraIndex: number, remote: Endpoint): Promise<void> {
    const index = this.relayIndex(remote)
    const relay = this.relays[index]
    const sender = this.senders?.[index]
    const transport = this.transport
    if (!relay || !sender || !transport || !this.sessionId || !this.macKey) return
    const frame = encodeSample(
      { kind: "sample", sessionId: this.sessionId, blockId, tesseraIndex },
      this.macKey,
    )
    const packet = encodeEnvelope(sender, frame)
    this.stats.controlWireBytes += packet.length
    await transport.send(packet, relay)
  }

  private relayIndex(remote: Endpoint): number {
    return this.relays.findIndex((relay) => relay.port === remote.port && relay.host === remote.host)
  }

  /**
   * One ACK, on one relay. A lost ACK costs a resend, and the resend arrives as a late tessera that
   * is answered again on the path it came by.
   */
  private async sendAck(blockId: number, via: number): Promise<void> {
    if (!this.sessionId) return
    if (!this.macKey) return
    const relay = this.relays[via]
    const sender = this.senders?.[via]
    const transport = this.transport
    if (!relay || !sender || !transport) throw new Error("receiver has no return path")
    const probe = this.probe
    const t0 = probe ? performance.now() : 0
    const frame = encodeAck({ kind: "ack", sessionId: this.sessionId, blockId }, this.macKey)
    this.stats.acksSent++
    if (probe) probe.step(blockId, "ack", t0)
    const packet = encodeEnvelope(sender, frame)
    this.stats.controlWireBytes += packet.length
    await transport.send(packet, relay)
    if (probe) probe.note("receiver.ack-send", performance.now() - t0)
  }

  private async sendNack(blockId: number, missing: number[]): Promise<void> {
    if (!this.sessionId) return
    if (!this.macKey) return
    const frame = encodeNack({ kind: "nack", sessionId: this.sessionId, blockId, missing }, this.macKey)
    this.stats.nacksSent++
    this.probe?.note("receiver.nack", missing.length)
    await this.fanout(frame)
  }

  private async fanout(frame: Buffer): Promise<void> {
    const senders = this.senders
    const transport = this.transport
    if (!senders || !transport) throw new Error("receiver has no return path")
    await Promise.all(
      this.relays.map(async (relay, index) => {
        const sender = senders[index]
        if (!sender) return
        const packet = encodeEnvelope(sender, frame)
        this.stats.controlWireBytes += packet.length
        await transport.send(packet, relay)
      }),
    )
  }

  private arm(): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.stopped) return
      void this.nackTick()
        .catch((err) => this.fail(err))
        .finally(() => this.arm())
    }, this.tickMs)
  }
}
