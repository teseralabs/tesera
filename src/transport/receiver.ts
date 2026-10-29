import { transportOrUdp, type Endpoint, type OpenTransport, type PacketTransport } from "../carrier/transport.js"
import { decodeShards, joinShards } from "../coding/reedsolomon.js"
import {
  assertCode,
  CLOSE_NOTICE_MS,
  DEFAULT_ACK_GRACE_MS,
  DEFAULT_NACK_AFTER_MS,
  DEFAULT_TICK_MS,
  MAX_AHEAD,
  MAX_RETX_BACKOFF_MS,
} from "../constants.js"
import { crc32 } from "../protocol/crc32.js"
import { assertSession, blockAad, deriveKeys, open } from "../crypto/session.js"
import { emptyReceiverStats, type ReceiverStats } from "../metrics.js"
import { encodeEnvelope } from "../protocol/envelope.js"
import { decodeClose, decodeFrame, encodeAck, encodeClose, encodeNack, encodeSample, type CloseFrame, type CloseReason, type DataFrame } from "../protocol/frames.js"
import { asError, Signal, sleep, waitAtMost } from "../util.js"
import { addressPerRelay, type PeerAddress } from "./address.js"
import type { Probe } from "./probe.js"

/**
 * Parameter sets remembered for one block. A new set may replace one that can no longer open,
 * or one with strictly fewer shards. Equal sets stay, so a fresh length cannot displace a set
 * that is just as far along. Two different lengths can still fill both slots before the honest
 * length is seen; telling those apart takes an authenticated header, which this protocol does not have.
 */
const MAX_GROUPS = 2
/**
 * Open attempts for one parameter set. A code with one spare tessera has at most n combinations,
 * and n never exceeds 32, so those transfers try every combination. Denser codes stop here.
 */
const MAX_BLOCK_DECODES = 32

type HeldShard = {
  payload: Buffer
  /** Relay that delivered this copy. The ACK goes back through one of the relays that opened the block. */
  via: number
  /** A suspect index accepts one different payload. Further different copies are ignored. */
  replaced: boolean
  /** This same payload arrived again after its index was part of a failed open. */
  confirmed: boolean
}

type ShardGroup = {
  k: number
  n: number
  cipherLen: number
  shardLen: number
  shards: Map<number, HeldShard>
  /** Combinations already opened, keyed by index and payload checksum, so a replacement can be tried. */
  rejected: Set<string>
  suspect: Set<number>
  decodes: number
  born: number
}

type PartialBlock = {
  groups: ShardGroup[]
  firstSeen: number
  lastError: string
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
  /**
   * k and n taken from the offer. A frame that claims another code is dropped.
   * Omitted means the first block that opens authenticates them.
   */
  coding?: { k: number; n: number }
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
  private groupSeq = 0
  private nextDeliver = 0
  private highestSeen = -1
  private gapsFrom = 0
  private streamEnded = false
  private stopped = false
  private closed = false
  /** One shutdown, including the close notice. A second close waits for it. */
  private closing: Promise<void> | null = null
  /** A verified close from the sender is already the error. Don't answer it with another close. */
  private remoteClose = false
  /** The one close this receiver will send. */
  private closeSent = false
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
    if (opts.coding) {
      assertCode(opts.coding.k, opts.coding.n)
      this.k = opts.coding.k
      this.n = opts.coding.n
    }
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

  /**
   * Stop, and when the stream has not finished, send one close notice first.
   * A finished stream sends nothing, so a notice cannot race the last block.
   */
  async close(reason?: CloseReason): Promise<void> {
    if (this.closing) return this.closing
    let done: () => void = () => {}
    this.closing = new Promise<void>((resolve) => {
      done = resolve
    })
    void this.shutdown(reason).finally(done)
    return this.closing
  }

  private async shutdown(reason?: CloseReason): Promise<void> {
    this.closed = true
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const complete = this.streamEnded && !this.error
    if (!complete && !this.remoteClose) await this.leave(reason ?? "end")
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
    const close = decodeClose(msg, this.macKeyFor(msg))
    if (close) {
      this.takeClose(close)
      return
    }
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
    this.acceptTessera(frame, via, remote)
  }

  /**
   * Keep the frame when it can still help this block. A bad checksum never arrives here.
   * A different k or n is dropped once one block has opened, or stored as its own set until then.
   * Returns false when the frame was ignored or the block has just failed its integrity check.
   */
  private acceptTessera(frame: DataFrame, via: number, remote: Endpoint): boolean {
    if (this.k !== 0 && (frame.k !== this.k || frame.n !== this.n)) return false
    let partial = this.partials.get(frame.blockId)
    if (!partial) {
      partial = { groups: [], firstSeen: Date.now(), lastError: "" }
      this.partials.set(frame.blockId, partial)
      this.missingSince.delete(frame.blockId)
      this.probe?.step(frame.blockId, "first", performance.now())
    }
    const group = this.place(partial, frame)
    if (!group) {
      if (partial.groups.length === 0) this.partials.delete(frame.blockId)
      return false
    }
    if (!this.hold(group, frame, via)) return false
    // The sample has to leave before the ACK. The sender learns the round trip from it, and only
    // then stretches the resend timer. An ACK that arrives first opens the window on the old timer.
    const first = this.noteArrival(frame.blockId, frame.tesseraIndex)
    if (first) void this.sendSample(frame.blockId, frame.tesseraIndex, remote).catch(() => {})
    if (frame.blockId > this.highestSeen) this.highestSeen = frame.blockId
    this.noteGaps()
    this.noteBuffer()
    if (group.shards.size >= group.k) {
      this.probe?.step(frame.blockId, "k", performance.now())
      this.recover(frame.blockId, partial, via)
    }
    return this.error === null
  }

  private place(partial: PartialBlock, frame: DataFrame): ShardGroup | null {
    for (const group of partial.groups) {
      if (
        group.k === frame.k &&
        group.n === frame.n &&
        group.cipherLen === frame.cipherLen &&
        group.shardLen === frame.payload.length
      ) {
        return group
      }
    }
    const created = this.newGroup(frame)
    if (partial.groups.length < MAX_GROUPS) {
      partial.groups.push(created)
      return created
    }
    const victim = this.evictionVictim(partial.groups)
    if (!victim) return null
    const at = partial.groups.indexOf(victim)
    if (at < 0) return null
    partial.groups[at] = created
    return created
  }

  private newGroup(frame: DataFrame): ShardGroup {
    return {
      k: frame.k,
      n: frame.n,
      cipherLen: frame.cipherLen,
      shardLen: frame.payload.length,
      shards: new Map(),
      rejected: new Set(),
      suspect: new Set(),
      decodes: 0,
      born: this.groupSeq++,
    }
  }

  /**
   * The first copy of an index stays until an open that used it fails. One different copy may
   * then replace it. A repeat of a suspect copy confirms that those bytes are not a stand-in.
   */
  private hold(group: ShardGroup, frame: DataFrame, via: number): boolean {
    const existing = group.shards.get(frame.tesseraIndex)
    if (!existing) {
      group.shards.set(frame.tesseraIndex, {
        payload: Buffer.from(frame.payload),
        via,
        replaced: false,
        confirmed: false,
      })
      return true
    }
    if (existing.payload.equals(frame.payload)) {
      if (group.suspect.has(frame.tesseraIndex)) existing.confirmed = true
      return true
    }
    if (!group.suspect.has(frame.tesseraIndex) || existing.replaced) return false
    existing.payload = Buffer.from(frame.payload)
    existing.via = via
    existing.replaced = true
    existing.confirmed = false
    group.suspect.delete(frame.tesseraIndex)
    return true
  }

  /**
   * A set that has failed every open can be replaced. Otherwise only a strictly smaller set can,
   * and the one with the most shards stays. A tie drops the new length instead of evicting either set.
   */
  private evictionVictim(groups: ShardGroup[]): ShardGroup | null {
    const stuck = groups.filter((group) => !this.groupWaiting(group))
    if (stuck.length > 0) return this.smallest(stuck)
    let largest = 0
    for (const group of groups) if (group.shards.size > largest) largest = group.shards.size
    return this.smallest(groups.filter((group) => group.shards.size < largest))
  }

  private smallest(groups: ShardGroup[]): ShardGroup | null {
    let victim: ShardGroup | null = null
    for (const group of groups) {
      if (!victim || group.shards.size < victim.shards.size || (group.shards.size === victim.shards.size && group.born < victim.born)) {
        victim = group
      }
    }
    return victim
  }

  private recover(blockId: number, partial: PartialBlock, via: number): void {
    if (this.done.has(blockId) || this.error) return
    for (const group of partial.groups) {
      if (group.shards.size < group.k) continue
      if (this.tryGroup(blockId, partial, group, via)) return
    }
    if (partial.groups.length === 0 || partial.groups.some((group) => this.groupWaiting(group))) return
    const why = partial.lastError || "no consistent tesserae"
    this.fail(new Error(`block ${blockId} failed integrity check: ${why}`))
  }

  /**
   * Still collecting, still holding an untried combination, or still waiting for one replacement
   * or a repeat of a suspect tessera. A full set whose every combination failed, and whose suspect
   * tesserae were either replaced or seen again, is not waiting.
   */
  private groupWaiting(group: ShardGroup): boolean {
    if (group.decodes >= MAX_BLOCK_DECODES) return false
    if (group.shards.size < group.k) return true
    if (this.untriedCombo(group)) return true
    if (group.shards.size < group.n) return true
    for (const [index, shard] of group.shards) {
      if (group.suspect.has(index) && !shard.replaced && !shard.confirmed) return true
    }
    return false
  }

  private tryGroup(blockId: number, partial: PartialBlock, group: ShardGroup, via: number): boolean {
    while (group.decodes < MAX_BLOCK_DECODES) {
      const combo = this.untriedCombo(group)
      if (!combo) return false
      if (this.openCombo(blockId, partial, group, combo, via)) return true
    }
    return false
  }

  /**
   * Exactly these k shards. Passing the whole set would keep a corrupt systematic shard and
   * ignore a good spare, because the decoder returns indices 0..k-1 whenever it has them.
   */
  private openCombo(
    blockId: number,
    partial: PartialBlock,
    group: ShardGroup,
    combo: readonly number[],
    via: number,
  ): boolean {
    const key = this.comboKey(group, combo)
    group.rejected.add(key)
    group.decodes++
    const parts: Array<{ index: number; data: Buffer }> = []
    for (const index of combo) {
      const shard = group.shards.get(index)
      if (!shard) return false
      parts.push({ index, data: shard.payload })
    }
    let opened: { fin: boolean; body: Buffer; sentAtMs: number }
    const t0 = performance.now()
    try {
      const dataShards = decodeShards(parts, group.k, group.n)
      const cipher = joinShards(dataShards, group.cipherLen)
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
          k: group.k,
          n: group.n,
          cipherLen: group.cipherLen,
          shardLen: group.shardLen,
        }),
      )
      this.stats.decryptMs += performance.now() - t1
      if (this.probe) {
        this.probe.note("receiver.reconstruct", t1 - t0)
        this.probe.note("receiver.open", performance.now() - t1)
        this.probe.note("receiver.resident", this.partials.size + this.ready.size)
      }
    } catch (err) {
      if (asError(err).message === "missing traffic keys") throw err
      partial.lastError = asError(err).message
      for (const index of combo) group.suspect.add(index)
      return false
    }
    this.pinFrom(group.k, group.n)
    this.partials.delete(blockId)
    this.done.add(blockId)
    this.decoded.add(blockId)
    this.missingSince.delete(blockId)
    this.stats.blocksDecoded++
    const latencyMs = Math.max(0, Date.now() - opened.sentAtMs)
    this.ready.set(blockId, { body: opened.body, fin: opened.fin, latencyMs })
    this.drain()
    void this.ackOrHold(blockId, this.ackVia(group, combo, via)).catch((err) => this.fail(err))
    return true
  }

  private ackVia(group: ShardGroup, combo: readonly number[], fallback: number): number {
    for (const index of combo) {
      const shard = group.shards.get(index)
      if (shard) return shard.via
    }
    return fallback
  }

  /**
   * The opened block authenticated k and n. Later frames that claim another code are dropped.
   * Once pinned, no set with another code is ever stored, so only the first pin has anything to prune.
   */
  private pinFrom(k: number, n: number): void {
    if (this.k !== 0) return
    this.k = k
    this.n = n
    for (const [id, partial] of [...this.partials]) {
      partial.groups = partial.groups.filter((group) => group.k === this.k && group.n === this.n)
      if (partial.groups.length === 0) this.partials.delete(id)
    }
  }

  /** Non-suspect indices first, so the next attempt leaves out a tessera that already failed. */
  private orderedIndices(group: ShardGroup): number[] {
    return [...group.shards.keys()].sort((a, b) => {
      const aSuspect = group.suspect.has(a) ? 1 : 0
      const bSuspect = group.suspect.has(b) ? 1 : 0
      if (aSuspect !== bSuspect) return aSuspect - bSuspect
      return a - b
    })
  }

  private untriedCombo(group: ShardGroup): number[] | null {
    const universe = this.orderedIndices(group)
    if (universe.length < group.k) return null
    let combo = universe.slice(0, group.k)
    for (let step = 0; step < MAX_BLOCK_DECODES; step++) {
      if (!group.rejected.has(this.comboKey(group, combo))) return combo
      const next = this.nextCombo(combo, universe)
      if (!next) return null
      combo = next
    }
    return null
  }

  private nextCombo(combo: readonly number[], universe: readonly number[]): number[] | null {
    const k = combo.length
    const next = combo.slice()
    for (let i = k - 1; i >= 0; i--) {
      const current = next[i]
      if (current === undefined) return null
      const pos = universe.indexOf(current)
      if (pos < 0) return null
      if (pos < universe.length - k + i) {
        for (let j = i; j < k; j++) {
          const value = universe[pos + 1 + (j - i)]
          if (value === undefined) return null
          next[j] = value
        }
        return next
      }
    }
    return null
  }

  private comboKey(group: ShardGroup, combo: readonly number[]): string {
    const ordered = [...combo].sort((a, b) => a - b)
    let key = ""
    for (const index of ordered) {
      const shard = group.shards.get(index)
      key += `${index}:${shard ? crc32(shard.payload) : 0},`
    }
    return key
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

  private knownN(): number {
    if (this.n > 0) return this.n
    for (const partial of this.partials.values()) {
      const group = partial.groups[0]
      if (group) return group.n
    }
    return 0
  }

  /** The parameter set with the most shards is the one a repair can still finish. */
  private focusGroup(partial: PartialBlock): ShardGroup | null {
    let best: ShardGroup | null = null
    for (const group of partial.groups) {
      if (this.k !== 0 && (group.k !== this.k || group.n !== this.n)) continue
      if (!best || group.shards.size > best.shards.size) best = group
    }
    return best ?? partial.groups[0] ?? null
  }

  /** Indices the sender should send again: ones we lack, and suspect ones not yet confirmed. */
  private wanted(group: ShardGroup): number[] {
    const missing: number[] = []
    for (let index = 0; index < group.n; index++) {
      const shard = group.shards.get(index)
      if (!shard || (group.suspect.has(index) && !shard.confirmed)) missing.push(index)
    }
    return missing
  }

  private async nackTick(): Promise<void> {
    const n = this.knownN()
    if (this.stopped || !this.senders || n === 0) return
    const now = Date.now()
    for (const id of this.nackPace.keys()) {
      if (!this.partials.has(id) && !this.missingSince.has(id)) this.nackPace.delete(id)
    }
    for (const [id, partial] of this.partials) {
      if (now - partial.firstSeen < this.nackAfterMs || !this.nackDue(id, now)) continue
      const group = this.focusGroup(partial)
      if (!group) continue
      const missing = this.wanted(group)
      if (missing.length > 0) await this.sendNack(id, missing)
    }
    for (const [id, since] of [...this.missingSince.entries()]) {
      if (id < this.nextDeliver || this.partials.has(id) || this.done.has(id) || this.ready.has(id)) {
        this.missingSince.delete(id)
        continue
      }
      if (now - since < this.nackAfterMs || !this.nackDue(id, now)) continue
      const missing: number[] = []
      for (let index = 0; index < n; index++) missing.push(index)
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

  /** A sender's close. A receiver's own notice, another session, or a notice after the stream ends does nothing. */
  private takeClose(close: CloseFrame): void {
    if (close.from !== "sender") return
    if (this.sessionId && !this.sessionId.equals(close.sessionId)) return
    if (this.streamEnded) return
    if (!this.sessionId && !this.adopt(close.sessionId)) return
    this.remoteClose = true
    const message = close.reason === "cancel" ? "the sender cancelled the transfer" : "the other person ended the transfer"
    this.fail(new Error(message))
  }

  /** The adopted control key, or the key for the session id in an early notice. */
  private macKeyFor(msg: Buffer): Uint8Array | null {
    if (this.macKey) return this.macKey
    if (msg.length < 2 + 16) return null
    try {
      return deriveKeys(this.secret, msg.subarray(2, 2 + 16)).macKey
    } catch {
      return null
    }
  }

  /**
   * One notice to every relay, then stop. A lost notice leaves the idle timeout as the fallback.
   * A send that can't be handed off within CLOSE_NOTICE_MS is abandoned, so close still finishes.
   */
  private async leave(reason: CloseReason): Promise<void> {
    if (this.closeSent || !this.sessionId || !this.macKey) return
    this.closeSent = true
    const transport = this.transport
    const senders = this.senders
    if (!transport || !senders) return
    const frame = encodeClose("receiver", this.sessionId, reason, this.macKey)
    const sends = Promise.all(
      this.relays.map(async (relay, index) => {
        const sender = senders[index]
        if (!sender) return
        try {
          await transport.send(encodeEnvelope(sender, frame), relay)
        } catch {
          // Best effort. The peer's idle timeout still ends a transfer whose notice never left.
        }
      }),
    )
    await waitAtMost(sends, CLOSE_NOTICE_MS)
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
