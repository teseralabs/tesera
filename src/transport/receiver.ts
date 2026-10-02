import { type Socket } from "node:dgram"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, type Endpoint } from "../carrier/udp.js"
import { decodeShards, joinShards } from "../coding/reedsolomon.js"
import { DEFAULT_NACK_AFTER_MS, DEFAULT_TICK_MS, MAX_AHEAD } from "../constants.js"
import { assertSession, blockAad, deriveKeys, open } from "../crypto/session.js"
import { emptyReceiverStats, type ReceiverStats } from "../metrics.js"
import { encodeEnvelope } from "../protocol/envelope.js"
import { decodeFrame, encodeAck, encodeNack, encodeSample, type DataFrame } from "../protocol/frames.js"
import { asError, Signal } from "../util.js"

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
  sender?: Endpoint
  bindHost?: string
  bindPort?: number
  nackAfterMs?: number
  tickMs?: number
  maxAhead?: number
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
  private readonly bindHost: string
  private readonly bindPort: number
  private readonly partials = new Map<number, PartialBlock>()
  private readonly ready = new Map<number, ReadyBlock>()
  private readonly done = new Set<number>()
  private readonly missingSince = new Map<number, number>()
  private readonly arrived = new Map<number, Set<number>>()
  private readonly decoded = new Set<number>()
  /** Delivered block ids that may still be acknowledged. Bounded by the receive window. */
  private readonly ackable = new Set<number>()
  private settledMissing = 0
  private settledPartial = 0
  private readonly chunks: Buffer[] = []
  private readonly readWake = new Signal()

  private socket: Socket | null = null
  private bound: Endpoint | null = null
  private sender: Endpoint | null
  private sessionId: Buffer | null = null
  private k = 0
  private n = 0
  private nextDeliver = 0
  private highestSeen = -1
  private streamEnded = false
  private stopped = false
  private closed = false
  private error: Error | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(opts: ReceiverOptions) {
    assertSession(opts.session)
    this.secret = opts.session
    if (opts.relays.length < 1) throw new Error("receiver needs at least one relay")
    this.relays = opts.relays
    this.sender = opts.sender ?? null
    this.nackAfterMs = opts.nackAfterMs ?? DEFAULT_NACK_AFTER_MS
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.maxAhead = opts.maxAhead ?? MAX_AHEAD
    this.bindHost = opts.bindHost ?? "127.0.0.1"
    this.bindPort = opts.bindPort ?? 0
  }

  get endpoint(): Endpoint {
    if (!this.bound) throw new Error("receiver has not started")
    return this.bound
  }

  setSender(endpoint: Endpoint): void {
    this.sender = endpoint
  }

  async start(): Promise<Endpoint> {
    const socket = createUdpSocket()
    this.socket = socket
    this.bound = await bindUdp(socket, this.bindHost, this.bindPort)
    socket.on("message", (msg, rinfo) => {
      void this.onMessage(Buffer.from(msg), { host: rinfo.address, port: rinfo.port }).catch((err) =>
        this.fail(err),
      )
    })
    socket.on("error", (err) => this.fail(err))
    this.arm()
    return this.bound
  }

  async read(): Promise<Uint8Array | null> {
    for (;;) {
      const next = this.chunks.shift()
      if (next) return next
      if (this.error) throw this.error
      if (this.streamEnded && this.ready.size === 0) return null
      await this.readWake.wait()
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
    const socket = this.socket
    this.socket = null
    if (socket) await closeUdp(socket).catch(() => {})
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
    const frame = decodeFrame(msg, this.macKey)
    if (!frame || frame.kind !== "data") return
    if (this.sessionId && !this.sessionId.equals(frame.sessionId)) return
    if (frame.blockId < this.nextDeliver) {
      if (this.ackable.has(frame.blockId)) await this.sendAck(frame.blockId)
      return
    }
    if (frame.blockId > this.nextDeliver + this.maxAhead) return
    if (!this.adopt(frame.sessionId)) return
    if (this.done.has(frame.blockId)) {
      await this.sendAck(frame.blockId)
      return
    }
    const first = this.noteArrival(frame.blockId, frame.tesseraIndex)
    if (first) void this.sendSample(frame.blockId, frame.tesseraIndex, remote).catch(() => {})
    this.acceptTessera(frame)
  }

  private acceptTessera(frame: DataFrame): void {
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
    } else if (partial.cipherLen !== frame.cipherLen || partial.shardLen !== frame.payload.length) {
      this.fail(new Error(`block ${frame.blockId} tesserae disagree on length`))
      return
    }
    if (!partial.shards.has(frame.tesseraIndex)) partial.shards.set(frame.tesseraIndex, frame.payload)
    if (frame.blockId > this.highestSeen) this.highestSeen = frame.blockId
    this.noteGaps()
    this.noteBuffer()
    if (partial.shards.size >= partial.k) this.reconstruct(frame.blockId, partial)
  }

  private reconstruct(blockId: number, partial: PartialBlock): void {
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
    void this.sendAck(blockId).catch((err) => this.fail(err))
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
        this.stats.outputBytes += item.body.length
      }
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
    for (const id of this.ackable) {
      if (id < oldest) this.ackable.delete(id)
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

  private noteGaps(): void {
    for (let id = this.nextDeliver; id < this.highestSeen; id++) {
      if (this.done.has(id) || this.partials.has(id) || this.ready.has(id) || this.missingSince.has(id)) continue
      this.missingSince.set(id, Date.now())
    }
  }

  private noteBuffer(): void {
    const size = this.ready.size + this.partials.size
    if (size > this.stats.maxBufferedBlocks) this.stats.maxBufferedBlocks = size
  }

  private async nackTick(): Promise<void> {
    if (this.stopped || !this.sender || this.n === 0) return
    const now = Date.now()
    for (const [id, partial] of this.partials) {
      if (now - partial.firstSeen < this.nackAfterMs) continue
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
      if (now - since < this.nackAfterMs || this.n === 0) continue
      const missing: number[] = []
      for (let index = 0; index < this.n; index++) missing.push(index)
      await this.sendNack(id, missing)
    }
  }

  private async sendSample(blockId: number, tesseraIndex: number, remote: Endpoint): Promise<void> {
    const relay = this.relayFor(remote)
    const sender = this.sender
    const socket = this.socket
    if (!relay || !sender || !socket || !this.sessionId || !this.macKey) return
    const frame = encodeSample(
      { kind: "sample", sessionId: this.sessionId, blockId, tesseraIndex },
      this.macKey,
    )
    const packet = encodeEnvelope(sender, frame)
    this.stats.controlWireBytes += packet.length
    await sendUdp(socket, packet, relay)
  }

  private relayFor(remote: Endpoint): Endpoint | null {
    for (const relay of this.relays) {
      if (relay.port === remote.port && relay.host === remote.host) return relay
    }
    return null
  }

  private async sendAck(blockId: number): Promise<void> {
    if (!this.sessionId) return
    if (!this.macKey) return
    const frame = encodeAck({ kind: "ack", sessionId: this.sessionId, blockId }, this.macKey)
    this.stats.acksSent++
    await this.fanout(frame)
  }

  private async sendNack(blockId: number, missing: number[]): Promise<void> {
    if (!this.sessionId) return
    if (!this.macKey) return
    const frame = encodeNack({ kind: "nack", sessionId: this.sessionId, blockId, missing }, this.macKey)
    this.stats.nacksSent++
    await this.fanout(frame)
  }

  private async fanout(frame: Buffer): Promise<void> {
    const sender = this.sender
    const socket = this.socket
    if (!sender || !socket) throw new Error("receiver has no return path")
    await Promise.all(
      this.relays.map(async (relay) => {
        const packet = encodeEnvelope(sender, frame)
        this.stats.controlWireBytes += packet.length
        await sendUdp(socket, packet, relay)
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
