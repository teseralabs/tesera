import { randomBytes } from "../crypto/primitives.js"
import { transportOrUdp, type Endpoint, type OpenTransport, type PacketTransport } from "../carrier/transport.js"
import { encodeShards, splitCiphertext } from "../coding/reedsolomon.js"
import {
  assertCode,
  assertShardSize,
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_SENDS,
  DEFAULT_RETX_AFTER_MS,
  DEFAULT_SHARD,
  DEFAULT_TICK_MS,
  DEFAULT_WINDOW,
  DATAGRAM_OVERHEAD,
  fullBlockBodySize,
  INITIAL_WINDOW,
  LEGACY_AHEAD,
  MAX_RETX_BACKOFF_MS,
  MIN_WINDOW,
  shardForPacketSize,
} from "../constants.js"
import { assertSession, blockAad, deriveKeys, seal, sealedLength } from "../crypto/session.js"
import { emptySenderStats, type SenderStats } from "../metrics.js"
import { encodeEnvelope } from "../protocol/envelope.js"
import { decodeFrame, encodeData } from "../protocol/frames.js"
import { asError, Signal } from "../util.js"
import { addressPerRelay, type PeerAddress } from "./address.js"
import type { Probe } from "./probe.js"
import { PathScheduler } from "./scheduler.js"

/** How long arrivals may stop, on an unstretched retransmit timer, before a silent block is sent again. */
const SAMPLE_STALL_MS = 40
/** CUBIC's window after a loss, as a share of the window before it. */
const CUBIC_BETA = 0.7
/** CUBIC's growth constant, in blocks per second cubed. */
const CUBIC_C = 0.4

type Placement = {
  relay: number
  sentAt: number
  settled: boolean
}

type BlockState = {
  id: number
  frames: Buffer[]
  placements: Array<Placement | null>
  sends: number
  nextRetxAt: number
  /** Wait before the next timed resend. Doubles after each resend. */
  backoffMs: number
  /** performance.now() of the last resend, 0 before one. */
  resentAt: number
  acked: boolean
}

/** The congestion state from before a cut, kept until the cut proves real or spurious. */
type Undo = {
  blockId: number
  congestion: number
  slowStartUntil: number
  lossWindow: number
  growthFrom: number
  growthPeakSec: number
  recoverFrom: number
}

export type SenderOptions = {
  session: Buffer
  /** The receiver's address in each envelope: one for every relay, or one per relay in relay order. May be set later with `setReceiver`. */
  receiver?: PeerAddress
  relays: Endpoint[]
  /** The largest packet the receiver can accept, when it is known to be smaller than this sender's own transport. */
  peerMaxPacketSize?: number
  /** How far past its next block to deliver the receiver accepts blocks. Defaults to what every release accepts. */
  peerAhead?: number
  /** How packets travel. Omitted means a UDP socket on `bindHost:bindPort`. */
  transport?: OpenTransport
  bindHost?: string
  bindPort?: number
  k?: number
  n?: number
  shardSize?: number
  window?: number
  maxSends?: number
  retxAfterMs?: number
  /** Total time allowed from the first block. Omitted means no total limit. */
  deadlineMs?: number
  /** Time allowed without a block acknowledgement while blocks are in flight. */
  idleMs?: number
  tickMs?: number
  /** Timing notes for diagnostics. */
  probe?: Probe
}

export class TeseraSender {
  readonly stats: SenderStats = emptySenderStats()
  onPeerFail: ((err: Error) => void) | null = null

  private readonly aeadKey: Buffer
  private readonly macKey: Buffer
  /** By relay index. Set from the receiver address when the sender starts. */
  private receivers: Endpoint[] = []
  private receiverAddr: PeerAddress | null
  private peerMaxPacketSize: number
  private peerAhead: number
  private readonly relays: Endpoint[]
  private readonly k: number
  private readonly n: number
  private readonly requestedShard: number
  private shardSize = 0
  private bodySize = 0
  private readonly window: number
  private readonly maxSends: number
  private readonly retxAfterMs: number
  private readonly deadlineMs: number
  private readonly idleMs: number
  private readonly maxBackoffMs: number
  private readonly tickMs: number
  private readonly openTransport: OpenTransport
  private readonly id = randomBytes(16)
  private readonly scheduler: PathScheduler
  private readonly probe: Probe | null
  private readonly inflight = new Map<number, BlockState>()
  private readonly awaitingSample = new Map<
    string,
    { relay: number; sentAt: number; inflight: boolean; cohort: number; lossToken: number }
  >()
  /** Tesserae the block no longer needs. A missing sample after the retx interval counts as loss. */
  private readonly lossWatch = new Map<string, number>()
  private readonly wake = new Signal()

  private transport: PacketTransport | null = null
  private bound: Endpoint | null = null
  private pending: Uint8Array = Buffer.alloc(0)
  private nextBlockId = 0
  private finished = false
  private stopped = false
  private closed = false
  private error: Error | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private deadlineAt = 0
  /** Set once a block ACK arrives, so a missing path sample cannot hold the window at one. */
  private opened = false
  /** performance.now() of the last send or reply. The first send starts the stall clock. */
  private lastProgressAt = 0
  /**
   * Blocks allowed in flight. Slow start adds one per ACK until the first loss. After that, CUBIC:
   * each loss cuts it to CUBIC_BETA of itself, once per window, and it grows back toward the
   * window before the loss along a cubic curve in time, so a long path recovers in seconds.
   */
  private congestion = 0
  private slowStartUntil = Infinity
  /** The window before the last loss, and when CUBIC's growth from that loss started. */
  private lossWindow = 0
  private growthFrom = 0
  private growthPeakSec = 0
  private smoothedRttMs = 0
  private rttVarMs = 0
  private minRttMs = Infinity
  /** performance.now() send time of the newest tessera that has been answered. */
  private newestAnsweredAt = 0
  private undo: Undo | null = null
  /** Loss on a block below this id was already answered by the last cut. */
  private recoverFrom = 0
  /** Date.now() of the last block ACK, or of the send that started a busy period. */
  private lastAckAt = 0

  constructor(opts: SenderOptions) {
    assertSession(opts.session)
    const keys = deriveKeys(opts.session, this.id)
    this.aeadKey = keys.aeadKey
    this.macKey = keys.macKey
    if (opts.relays.length < 1) throw new Error("sender needs at least one relay")
    this.relays = opts.relays
    this.receiverAddr = opts.receiver ?? null
    if (this.receiverAddr) addressPerRelay(this.receiverAddr, this.relays)
    this.peerMaxPacketSize = opts.peerMaxPacketSize ?? Infinity
    this.peerAhead = opts.peerAhead ?? LEGACY_AHEAD
    if (!Number.isInteger(this.peerAhead) || this.peerAhead < 1) throw new Error("peerAhead must be >= 1")
    this.k = opts.k ?? 2
    this.n = opts.n ?? 3
    assertCode(this.k, this.n)
    this.requestedShard = opts.shardSize ?? DEFAULT_SHARD
    assertShardSize(this.requestedShard)
    this.window = opts.window ?? DEFAULT_WINDOW
    if (!Number.isInteger(this.window) || this.window < 1) throw new Error("window must be >= 1")
    this.maxSends = opts.maxSends ?? DEFAULT_MAX_SENDS
    this.retxAfterMs = opts.retxAfterMs ?? DEFAULT_RETX_AFTER_MS
    this.deadlineMs = opts.deadlineMs ?? Infinity
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    if (!(this.idleMs > 0)) throw new Error("idle timeout must be > 0")
    this.maxBackoffMs = Math.max(MAX_RETX_BACKOFF_MS, this.retxAfterMs)
    this.congestion = Math.min(this.window, INITIAL_WINDOW)
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.openTransport = transportOrUdp(opts)
    this.scheduler = new PathScheduler(this.relays.length, this.k, this.n)
    this.probe = opts.probe ?? null
  }

  get endpoint(): Endpoint {
    if (!this.bound) throw new Error("sender has not started")
    return this.bound
  }

  /** The random id in every frame of this transfer. Known before start, so it can be shared ahead of the first packet. */
  get sessionId(): Buffer {
    return Buffer.from(this.id)
  }

  /** The size of a full data datagram, known after start. A caller can check it fits its transport. */
  get datagramSize(): number {
    if (!this.transport) throw new Error("sender has not started")
    return this.shardSize + DATAGRAM_OVERHEAD
  }

  /**
   * Set or replace the receiver's address, and optionally the largest packet it can accept and how
   * far ahead it accepts blocks. Must be called before `start`.
   */
  setReceiver(receiver: PeerAddress, peerMaxPacketSize?: number, peerAhead?: number): void {
    if (this.transport) throw new Error("sender already started")
    addressPerRelay(receiver, this.relays)
    this.receiverAddr = receiver
    if (peerMaxPacketSize !== undefined) this.peerMaxPacketSize = peerMaxPacketSize
    if (peerAhead !== undefined) {
      if (!Number.isInteger(peerAhead) || peerAhead < 1) throw new Error("peerAhead must be >= 1")
      this.peerAhead = peerAhead
    }
  }

  async start(): Promise<Endpoint> {
    if (!this.receiverAddr) throw new Error("sender needs a receiver address")
    this.receivers = addressPerRelay(this.receiverAddr, this.relays)
    const transport = await this.openTransport({
      packet: (packet) => {
        void this.onMessage(Buffer.from(packet)).catch((err) => this.fail(err))
      },
      error: (err) => this.fail(err),
    })
    this.transport = transport
    this.bound = transport.endpoint
    // Fit the shard to whichever is smaller: this transport, or the packet the receiver can accept.
    const limit = Math.min(transport.maxPacketSize, this.peerMaxPacketSize)
    this.shardSize = Math.min(this.requestedShard, shardForPacketSize(limit))
    this.bodySize = fullBlockBodySize(this.k, this.shardSize)
    this.arm()
    return this.bound
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.finished) throw new Error("write after end")
    if (this.error) throw this.error
    let incoming: Uint8Array = data
    if (this.pending.length > 0) {
      const merged = Buffer.alloc(this.pending.length + data.length)
      merged.set(this.pending, 0)
      merged.set(data, this.pending.length)
      incoming = merged
      this.pending = Buffer.alloc(0)
    }
    let offset = 0
    while (offset + this.bodySize <= incoming.length) {
      await this.sendBody(incoming.subarray(offset, offset + this.bodySize), false)
      offset += this.bodySize
    }
    if (offset < incoming.length) this.pending = Buffer.from(incoming.subarray(offset))
  }

  async end(): Promise<void> {
    if (this.finished) throw new Error("end called twice")
    this.finished = true
    await this.sendBody(this.pending, true)
    this.pending = Buffer.alloc(0)
    await this.waitIdle()
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  fail(err: unknown): void {
    if (this.error || this.closed) return
    this.error = asError(err)
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.wake.notify()
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
    if (!this.error && this.inflight.size > 0) {
      this.error = new Error("sender closed before completion")
    }
    this.wake.notify()
    const transport = this.transport
    this.transport = null
    if (transport) await transport.close().catch(() => {})
  }

  private async sendBody(body: Uint8Array, fin: boolean): Promise<void> {
    const owned = Uint8Array.from(body)
    const probe = this.probe
    const waitFrom = probe ? performance.now() : 0
    await this.waitForSlot()
    if (probe) probe.note("sender.slot-wait", performance.now() - waitFrom)
    if (this.error) throw this.error
    if (this.deadlineAt === 0) this.deadlineAt = Date.now() + this.deadlineMs
    const blockId = this.nextBlockId++
    const t0 = performance.now()
    const cipherLen = sealedLength(owned.length)
    const shardLen = Math.ceil(cipherLen / this.k)
    const cipher = seal(
      this.aeadKey,
      blockId,
      fin,
      owned,
      Date.now(),
      blockAad({
        sessionId: this.id,
        blockId,
        k: this.k,
        n: this.n,
        cipherLen,
        shardLen,
      }),
    )
    if (cipher.length !== cipherLen) throw new Error("sealed block length changed")
    this.stats.encryptMs += performance.now() - t0
    const t1 = performance.now()
    const shards = encodeShards(splitCiphertext(cipher, this.k), this.k, this.n)
    this.stats.encodeMs += performance.now() - t1
    if (probe) {
      probe.note("sender.seal", t1 - t0)
      probe.note("sender.encode", performance.now() - t1)
    }
    const t2 = probe ? performance.now() : 0
    const frames = shards.map((shard, index) =>
      encodeData({
        kind: "data",
        sessionId: this.id,
        blockId,
        tesseraIndex: index,
        k: this.k,
        n: this.n,
        cipherLen: cipher.length,
        payload: Buffer.from(shard),
      }),
    )
    const plan = this.scheduler.plan()
    if (probe) {
      probe.note("sender.frame", performance.now() - t2)
      probe.note("sender.tesserae-planned", plan.filter((relay) => relay !== null).length)
      probe.note("sender.inflight", this.inflight.size)
      probe.note("sender.open-window", this.openWindow())
      probe.step(blockId, "open", t0)
    }
    const firstWait = this.firstRetxWait(plan)
    const block: BlockState = {
      id: blockId,
      frames,
      placements: frames.map(() => null),
      sends: 1,
      nextRetxAt: Date.now() + firstWait,
      backoffMs: firstWait,
      resentAt: 0,
      acked: false,
    }
    if (this.inflight.size === 0) this.lastAckAt = Date.now()
    this.inflight.set(blockId, block)
    this.stats.blocks++
    this.stats.inputBytes += owned.length
    for (let index = 0; index < frames.length; index++) {
      const relay = plan[index]
      if (relay === null || relay === undefined) continue
      await this.transmit(block, index, relay, false)
    }
    if (probe) probe.step(blockId, "sent", performance.now())
  }

  private async waitForSlot(): Promise<void> {
    while ((this.inflight.size >= this.openWindow() || this.pastPeerAhead()) && !this.error && !this.stopped) {
      await this.wake.wait()
    }
    if (this.error) throw this.error
    if (this.stopped) throw new Error("sender closed")
  }

  private async waitIdle(): Promise<void> {
    while (this.inflight.size > 0 && !this.error && !this.stopped) {
      await this.wake.wait()
    }
    if (this.error) throw this.error
    if (this.inflight.size > 0) throw new Error("sender closed before completion")
  }

  private async onMessage(msg: Buffer): Promise<void> {
    if (this.closed) return
    const probe = this.probe
    const t0 = probe ? performance.now() : 0
    const frame = decodeFrame(msg, this.macKey)
    if (probe) probe.note("sender.control-decode", performance.now() - t0)
    if (!frame || frame.kind === "data") return
    if (!frame.sessionId.equals(this.id)) return
    if (frame.kind === "sample") {
      this.markProgress()
      this.noteSample(frame.blockId, frame.tesseraIndex)
      return
    }
    const block = this.inflight.get(frame.blockId)
    if (!block) return
    if (frame.kind === "ack") {
      if (probe) probe.step(frame.blockId, "acked", t0)
      this.markProgress()
      this.noteAnswered(block)
      this.settleQuiet(block)
      block.acked = true
      this.opened = true
      this.lastAckAt = Date.now()
      this.undoSpuriousCut(block)
      this.grow()
      this.stats.windowSum += this.openWindow()
      this.stats.windowCount++
      this.inflight.delete(frame.blockId)
      this.wake.notify()
      return
    }
    this.markProgress()
    // A NACK may speed up the first repair. Later resends wait out the block's backoff.
    if (block.sends > 1 && Date.now() < block.nextRetxAt) return
    const wanted = [...new Set(frame.missing)].filter((index) => index >= 0 && index < block.frames.length)
    const ripe = wanted.filter((index) => !this.placementHeld(block, index, performance.now()))
    if (ripe.length === 0) return
    probe?.note("sender.retx-nack", ripe.length)
    await this.retransmit(block, ripe)
  }

  private async repairTick(): Promise<void> {
    if (this.stopped) return
    if (this.deadlineAt !== 0 && Date.now() > this.deadlineAt) {
      this.fail(new Error("transfer timed out"))
      return
    }
    const now = Date.now()
    if (this.inflight.size > 0 && this.lastAckAt !== 0 && now - this.lastAckAt > this.idleMs) {
      this.fail(new Error(`no block was acknowledged for ${Math.round(this.idleMs / 1000)}s`))
      return
    }
    const perfNow = performance.now()
    const stalled = this.stalled(perfNow)
    this.expireLossWatches(now)
    for (const block of [...this.inflight.values()]) {
      if (this.stopped) return
      if (block.acked) continue
      const due = now >= block.nextRetxAt
      if (!due && !(stalled && block.sends === 1 && this.unansweredFor(block, perfNow))) continue
      if (this.heldInQueue(block, perfNow) || !this.lossEvident(block, perfNow)) continue
      const indices = this.repairIndices(block)
      if (indices.length === 0) continue
      this.probe?.note(due ? "sender.retx-timer" : "sender.retx-stall", indices.length)
      await this.retransmit(block, indices)
    }
  }

  /**
   * A measured round trip can outgrow the timer that was fixed at startup.
   * Leave the tessera alone while it is still inside that newer wait.
   */
  private heldInQueue(block: BlockState, now: number): boolean {
    for (const place of block.placements) {
      if (!place || place.settled) continue
      if (this.placementHeld(block, block.placements.indexOf(place), now)) return true
    }
    return false
  }

  /**
   * A block counts as lost once something sent after it has been answered. While nothing is answered
   * at all, the path is stalled rather than losing this block, and a full timeout from the last
   * reply passes before anything is resent, so a delay spike doesn't resend the whole window.
   */
  private lossEvident(block: BlockState, now: number): boolean {
    let lastSent = 0
    for (const place of block.placements) if (place && place.sentAt > lastSent) lastSent = place.sentAt
    return this.newestAnsweredAt > lastSent || now - this.lastProgressAt >= this.timeoutMs()
  }

  private noteAnswered(block: BlockState): void {
    for (const place of block.placements) {
      if (place && place.sentAt > this.newestAnsweredAt) this.newestAnsweredAt = place.sentAt
    }
  }

  private placementHeld(block: BlockState, index: number, now: number): boolean {
    const place = block.placements[index]
    if (!place || place.settled) return false
    const hold = Math.max(Math.min(this.retxAfterMs * 4, this.scheduler.repairHoldMs(place.relay)), this.timeoutMs())
    return hold > 0 && now - place.sentAt < hold
  }

  /**
   * Arrivals have stopped on a link whose retransmit timer was not stretched
   * for queueing or delay. Silent blocks from the first send are repaired
   * now, so a burst that hits every path is scored before the normal timer.
   */
  private stalled(now: number): boolean {
    if (this.lastProgressAt === 0 || this.retxAfterMs > DEFAULT_RETX_AFTER_MS) return false
    return now - this.lastProgressAt >= Math.min(this.retxAfterMs, SAMPLE_STALL_MS)
  }

  private unansweredFor(block: BlockState, now: number): boolean {
    const limit = Math.min(this.retxAfterMs, SAMPLE_STALL_MS)
    for (const place of block.placements) {
      if (!place || place.settled) continue
      if (now - place.sentAt >= limit) return true
    }
    return false
  }

  private markProgress(): void {
    this.lastProgressAt = performance.now()
  }

  private async retransmit(block: BlockState, indices: number[]): Promise<void> {
    if (this.stopped || block.acked) return
    if (block.sends >= this.maxSends) {
      this.fail(new Error(`block ${block.id} exceeded ${this.maxSends} transmissions`))
      return
    }
    block.sends++
    block.resentAt = performance.now()
    block.backoffMs = Math.min(this.maxBackoffMs, block.backoffMs * 2)
    block.nextRetxAt = Date.now() + block.backoffMs
    this.noteLoss(block.id)
    for (const index of indices) {
      if (this.stopped || block.acked) return
      const place = block.placements[index]
      if (place && !place.settled) {
        place.settled = true
        const pending = this.awaitingSample.get(this.sampleKey(block.id, index))
        this.scheduler.miss(place.relay, pending?.cohort ?? -1)
        if (pending) pending.inflight = false
      }
      await this.transmit(block, index, this.scheduler.best(), true)
    }
  }

  private async transmit(
    block: BlockState,
    index: number,
    relayIndex: number,
    retransmission: boolean,
  ): Promise<void> {
    const transport = this.transport
    const frame = block.frames[index]
    if (!transport || !frame || block.acked || this.stopped) return
    const relay = this.relays[relayIndex]
    const receiver = this.receivers[relayIndex]
    if (!relay || !receiver) throw new Error("missing relay")
    const sentAt = performance.now()
    if (this.lastProgressAt === 0) this.lastProgressAt = sentAt
    block.placements[index] = { relay: relayIndex, sentAt, settled: false }
    const cohort = this.scheduler.noteSend(relayIndex, !retransmission)
    this.awaitingSample.set(this.sampleKey(block.id, index), {
      relay: relayIndex,
      sentAt,
      inflight: true,
      cohort,
      lossToken: 0,
    })
    const packet = encodeEnvelope(receiver, frame)
    this.stats.dataWireBytes += packet.length
    this.stats.tesseraSends++
    if (retransmission) this.stats.tesseraRetransmissions++
    try {
      await transport.send(packet, relay)
      if (this.probe) this.probe.note("sender.send", performance.now() - sentAt)
    } catch (err) {
      this.fail(err)
      throw this.error ?? asError(err)
    }
  }

  /**
   * A block's sample arrives a round trip after its send, and its ACK just after that. A timer
   * shorter than the path would resend blocks that were already delivered, and cut the window.
   */
  private firstRetxWait(plan: Array<number | null>): number {
    let slowest = 0
    for (const relay of plan) {
      if (relay !== null) slowest = Math.max(slowest, this.scheduler.rttMs(relay))
    }
    return Math.min(this.maxBackoffMs, Math.max(this.retxAfterMs, slowest * 2, this.timeoutMs()))
  }

  /** RFC 6298's retransmission timeout from every sample: a queue that grows or swings stretches it. 0 before a sample. */
  private timeoutMs(): number {
    return this.smoothedRttMs === 0 ? 0 : this.smoothedRttMs + 4 * this.rttVarMs
  }

  private openWindow(): number {
    return this.opened ? Math.max(1, Math.floor(this.congestion)) : 1
  }

  /** The next block would land past what the receiver accepts while the oldest unacknowledged one is missing. */
  private pastPeerAhead(): boolean {
    const oldest = this.inflight.keys().next()
    return !oldest.done && this.nextBlockId >= oldest.value + this.peerAhead
  }

  private grow(): void {
    if (this.congestion < this.slowStartUntil) {
      this.congestion = Math.min(this.window, this.congestion + 1)
      return
    }
    const t = (performance.now() - this.growthFrom) / 1000
    const cubic = CUBIC_C * (t - this.growthPeakSec) ** 3 + this.lossWindow
    // Never slower than Reno would grow from the same loss, so short paths keep up with TCP.
    const rttSec = Math.max(0.001, (this.smoothedRttMs || DEFAULT_RETX_AFTER_MS) / 1000)
    const reno = this.lossWindow * CUBIC_BETA + ((3 * (1 - CUBIC_BETA)) / (1 + CUBIC_BETA)) * (t / rttSec)
    const target = Math.min(this.congestion * 1.5, Math.max(cubic, reno))
    const step = target > this.congestion ? (target - this.congestion) / this.congestion : 0.01 / this.congestion
    this.congestion = Math.min(this.window, this.congestion + step)
  }

  /**
   * A resend means a tessera, a sample, or an ACK went missing. That may be a
   * full queue or an operator limit, or it may be random loss. Cut once per
   * window, so one burst counts once, and never below MIN_WINDOW, so random
   * loss cannot starve the transfer.
   */
  private noteLoss(blockId: number): void {
    // Before any round trip is measured, a resend is a guess about the path, not a sign of a full queue.
    if (!this.scheduler.hasObservation) return
    if (blockId < this.recoverFrom) return
    const recoverFrom = this.recoverFrom
    this.recoverFrom = this.nextBlockId
    const floor = Math.min(this.window, MIN_WINDOW)
    this.undo = {
      blockId,
      congestion: this.congestion,
      slowStartUntil: this.slowStartUntil,
      lossWindow: this.lossWindow,
      growthFrom: this.growthFrom,
      growthPeakSec: this.growthPeakSec,
      recoverFrom,
    }
    // A loss before the window regained its last peak means less room now, so aim lower.
    this.lossWindow = this.congestion < this.lossWindow ? (this.congestion * (1 + CUBIC_BETA)) / 2 : this.congestion
    this.congestion = Math.max(floor, this.congestion * CUBIC_BETA)
    this.slowStartUntil = this.congestion
    this.growthFrom = performance.now()
    this.growthPeakSec = Math.cbrt((this.lossWindow * (1 - CUBIC_BETA)) / CUBIC_C)
    this.stats.windowCuts++
    this.probe?.note("sender.window-cut", this.congestion)
  }

  /**
   * The block whose resend cut the window was acknowledged sooner than the resend could have made a
   * round trip, so the original got through and the cut answered a late reply, not a full queue.
   */
  private undoSpuriousCut(block: BlockState): void {
    const undo = this.undo
    if (!undo || undo.blockId !== block.id || block.resentAt === 0) return
    this.undo = null
    if (performance.now() - block.resentAt >= this.minRttMs / 2) return
    this.congestion = undo.congestion
    this.slowStartUntil = undo.slowStartUntil
    this.lossWindow = undo.lossWindow
    this.growthFrom = undo.growthFrom
    this.growthPeakSec = undo.growthPeakSec
    this.recoverFrom = undo.recoverFrom
    this.stats.windowCutsUndone++
  }

  private sampleKey(blockId: number, index: number): string {
    return `${blockId}:${index}`
  }

  private noteSample(blockId: number, index: number): void {
    const key = this.sampleKey(blockId, index)
    this.lossWatch.delete(key)
    const pending = this.awaitingSample.get(key)
    if (!pending) return
    this.awaitingSample.delete(key)
    const rtt = performance.now() - pending.sentAt
    if (pending.sentAt > this.newestAnsweredAt) this.newestAnsweredAt = pending.sentAt
    this.probe?.note("sender.sample-rtt", rtt)
    this.stats.sampleRttSumMs += rtt
    if (rtt < this.minRttMs) this.minRttMs = rtt
    if (this.smoothedRttMs === 0) {
      this.smoothedRttMs = rtt
      this.rttVarMs = rtt / 2
    } else {
      this.rttVarMs = this.rttVarMs * 0.75 + Math.abs(this.smoothedRttMs - rtt) * 0.25
      this.smoothedRttMs = this.smoothedRttMs * 0.875 + rtt * 0.125
    }
    this.stats.sampleRttCount++
    if (pending.inflight) this.scheduler.observe(pending.relay, rtt, pending.cohort)
    else this.scheduler.noteRtt(pending.relay, rtt, pending.cohort, pending.lossToken)
    const place = this.inflight.get(blockId)?.placements[index]
    if (place) place.settled = true
    this.wake.notify()
  }

  /** A block ACK covers tesserae whose path sample has not come back. */
  private settleQuiet(block: BlockState): void {
    for (let index = 0; index < block.placements.length; index++) {
      const place = block.placements[index]
      if (!place || place.settled) continue
      place.settled = true
      this.scheduler.release(place.relay)
      const pending = this.awaitingSample.get(this.sampleKey(block.id, index))
      if (!pending) continue
      const cohort = pending.cohort
      pending.cohort = -1
      pending.inflight = false
      this.scheduler.dismiss(cohort)
      pending.lossToken = this.scheduler.noteUnanswered(place.relay)
      const paced = this.scheduler.lossWaitMs(place.relay)
      const wait = Math.max(this.retxAfterMs / 2, Math.min(this.retxAfterMs, paced))
      this.lossWatch.set(this.sampleKey(block.id, index), Date.now() + wait)
    }
  }

  /** Drop the sample slot once a covered tessera has had time to arrive. The loss itself was already recorded. */
  private expireLossWatches(now: number): void {
    for (const [key, due] of this.lossWatch) {
      if (now < due) continue
      this.lossWatch.delete(key)
      const pending = this.awaitingSample.get(key)
      this.awaitingSample.delete(key)
      if (pending && pending.lossToken > 0) this.scheduler.confirmLost(pending.lossToken)
    }
  }

  private repairIndices(block: BlockState): number[] {
    const unsettled: number[] = []
    const sent: number[] = []
    for (let index = 0; index < block.frames.length; index++) {
      const place = block.placements[index]
      if (!place) continue
      sent.push(index)
      if (!place.settled) unsettled.push(index)
    }
    return unsettled.length > 0 ? unsettled : sent
  }

  private arm(): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.stopped) return
      void this.repairTick()
        .catch((err) => this.fail(err))
        .finally(() => this.arm())
    }, this.tickMs)
  }
}
