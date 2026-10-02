import { randomBytes } from "node:crypto"
import { type Socket } from "node:dgram"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, type Endpoint } from "../carrier/udp.js"
import { encodeShards, splitCiphertext } from "../coding/reedsolomon.js"
import {
  assertCode,
  assertShardSize,
  DEFAULT_MAX_SENDS,
  DEFAULT_RETX_AFTER_MS,
  DEFAULT_SHARD,
  DEFAULT_TICK_MS,
  DEFAULT_WINDOW,
  fullBlockBodySize,
} from "../constants.js"
import { assertSession, blockAad, deriveKeys, seal, sealedLength } from "../crypto/session.js"
import { emptySenderStats, type SenderStats } from "../metrics.js"
import { encodeEnvelope } from "../protocol/envelope.js"
import { decodeFrame, encodeData } from "../protocol/frames.js"
import { asError, Signal } from "../util.js"
import { PathScheduler } from "./scheduler.js"

/** How long arrivals may stop, on an unstretched retransmit timer, before a silent block is sent again. */
const SAMPLE_STALL_MS = 40

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
  acked: boolean
}

export type SenderOptions = {
  session: Buffer
  receiver: Endpoint
  relays: Endpoint[]
  bindHost?: string
  bindPort?: number
  k?: number
  n?: number
  shardSize?: number
  window?: number
  maxSends?: number
  retxAfterMs?: number
  deadlineMs?: number
  tickMs?: number
}

export class TeseraSender {
  readonly stats: SenderStats = emptySenderStats()
  onPeerFail: ((err: Error) => void) | null = null

  private readonly aeadKey: Buffer
  private readonly macKey: Buffer
  private readonly receiver: Endpoint
  private readonly relays: Endpoint[]
  private readonly k: number
  private readonly n: number
  private readonly bodySize: number
  private readonly window: number
  private readonly maxSends: number
  private readonly retxAfterMs: number
  private readonly deadlineMs: number
  private readonly tickMs: number
  private readonly bindHost: string
  private readonly bindPort: number
  private readonly sessionId = randomBytes(16)
  private readonly scheduler: PathScheduler
  private readonly inflight = new Map<number, BlockState>()
  private readonly awaitingSample = new Map<
    string,
    { relay: number; sentAt: number; inflight: boolean; cohort: number; lossToken: number }
  >()
  /** Tesserae the block no longer needs. A missing sample after the retx interval counts as loss. */
  private readonly lossWatch = new Map<string, number>()
  private readonly wake = new Signal()

  private socket: Socket | null = null
  private bound: Endpoint | null = null
  private pending: Uint8Array = Buffer.alloc(0)
  private nextBlockId = 0
  private finished = false
  private stopped = false
  private closed = false
  private error: Error | null = null
  private timer: NodeJS.Timeout | null = null
  private deadlineAt = 0
  /** Set once a block ACK arrives, so a missing path sample cannot hold the window at one. */
  private opened = false
  /** performance.now() of the last send or reply. The first send starts the stall clock. */
  private lastProgressAt = 0

  constructor(opts: SenderOptions) {
    assertSession(opts.session)
    const keys = deriveKeys(opts.session, this.sessionId)
    this.aeadKey = keys.aeadKey
    this.macKey = keys.macKey
    if (opts.relays.length < 1) throw new Error("sender needs at least one relay")
    this.relays = opts.relays
    this.receiver = opts.receiver
    this.k = opts.k ?? 2
    this.n = opts.n ?? 3
    assertCode(this.k, this.n)
    const shardSize = opts.shardSize ?? DEFAULT_SHARD
    assertShardSize(shardSize)
    this.bodySize = fullBlockBodySize(this.k, shardSize)
    this.window = opts.window ?? DEFAULT_WINDOW
    if (!Number.isInteger(this.window) || this.window < 1) throw new Error("window must be >= 1")
    this.maxSends = opts.maxSends ?? DEFAULT_MAX_SENDS
    this.retxAfterMs = opts.retxAfterMs ?? DEFAULT_RETX_AFTER_MS
    this.deadlineMs = opts.deadlineMs ?? 60_000
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.bindHost = opts.bindHost ?? "127.0.0.1"
    this.bindPort = opts.bindPort ?? 0
    this.scheduler = new PathScheduler(this.relays.length, this.k, this.n)
  }

  get endpoint(): Endpoint {
    if (!this.bound) throw new Error("sender has not started")
    return this.bound
  }

  async start(): Promise<Endpoint> {
    const socket = createUdpSocket()
    this.socket = socket
    this.bound = await bindUdp(socket, this.bindHost, this.bindPort)
    socket.on("message", (msg) => {
      void this.onMessage(Buffer.from(msg)).catch((err) => this.fail(err))
    })
    socket.on("error", (err) => this.fail(err))
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
    const socket = this.socket
    this.socket = null
    if (socket) await closeUdp(socket).catch(() => {})
  }

  private async sendBody(body: Uint8Array, fin: boolean): Promise<void> {
    const owned = Uint8Array.from(body)
    await this.waitForSlot()
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
        sessionId: this.sessionId,
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
    const frames = shards.map((shard, index) =>
      encodeData({
        kind: "data",
        sessionId: this.sessionId,
        blockId,
        tesseraIndex: index,
        k: this.k,
        n: this.n,
        cipherLen: cipher.length,
        payload: Buffer.from(shard),
      }),
    )
    const plan = this.scheduler.plan()
    const block: BlockState = {
      id: blockId,
      frames,
      placements: frames.map(() => null),
      sends: 1,
      nextRetxAt: Date.now() + this.retxAfterMs,
      acked: false,
    }
    this.inflight.set(blockId, block)
    this.stats.blocks++
    this.stats.inputBytes += owned.length
    for (let index = 0; index < frames.length; index++) {
      const relay = plan[index]
      if (relay === null || relay === undefined) continue
      await this.transmit(block, index, relay, false)
    }
  }

  private async waitForSlot(): Promise<void> {
    while (this.inflight.size >= this.openWindow() && !this.error && !this.stopped) {
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
    const frame = decodeFrame(msg, this.macKey)
    if (!frame || frame.kind === "data") return
    if (!frame.sessionId.equals(this.sessionId)) return
    if (frame.kind === "sample") {
      this.markProgress()
      this.noteSample(frame.blockId, frame.tesseraIndex)
      return
    }
    const block = this.inflight.get(frame.blockId)
    if (!block) return
    if (frame.kind === "ack") {
      this.markProgress()
      this.settleQuiet(block)
      block.acked = true
      this.opened = true
      this.inflight.delete(frame.blockId)
      this.wake.notify()
      return
    }
    this.markProgress()
    const wanted = [...new Set(frame.missing)].filter((index) => index >= 0 && index < block.frames.length)
    const ripe = wanted.filter((index) => !this.placementHeld(block, index, performance.now()))
    if (ripe.length === 0) return
    await this.retransmit(block, ripe)
  }

  private async repairTick(): Promise<void> {
    if (this.stopped) return
    if (this.deadlineAt !== 0 && Date.now() > this.deadlineAt) {
      this.fail(new Error("transfer timed out"))
      return
    }
    const now = Date.now()
    const perfNow = performance.now()
    const stalled = this.stalled(perfNow)
    this.expireLossWatches(now)
    for (const block of [...this.inflight.values()]) {
      if (this.stopped) return
      if (block.acked) continue
      const due = now >= block.nextRetxAt
      if (!due && !(stalled && block.sends === 1 && this.unansweredFor(block, perfNow))) continue
      if (this.heldInQueue(block, perfNow)) continue
      const indices = this.repairIndices(block)
      if (indices.length === 0) continue
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

  private placementHeld(block: BlockState, index: number, now: number): boolean {
    const place = block.placements[index]
    if (!place || place.settled) return false
    const hold = Math.min(this.retxAfterMs * 4, this.scheduler.repairHoldMs(place.relay))
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
    block.nextRetxAt = Date.now() + this.retxAfterMs
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
    const socket = this.socket
    const frame = block.frames[index]
    if (!socket || !frame || block.acked || this.stopped) return
    const relay = this.relays[relayIndex]
    if (!relay) throw new Error("missing relay")
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
    const packet = encodeEnvelope(this.receiver, frame)
    this.stats.dataWireBytes += packet.length
    this.stats.tesseraSends++
    if (retransmission) this.stats.tesseraRetransmissions++
    try {
      await sendUdp(socket, packet, relay)
    } catch (err) {
      this.fail(err)
      throw this.error ?? asError(err)
    }
  }

  private openWindow(): number {
    return this.opened ? this.window : 1
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
