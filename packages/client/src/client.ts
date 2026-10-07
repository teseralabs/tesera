import { randomBytes, TeseraReceiver, TeseraSender, type OpenTransport, type TransportEvents as CoreEvents } from "./core.js"
import type { Probe } from "./probe.js"
import { asTeseraError, TeseraError } from "./errors.js"
import { streamHash } from "./hash.js"
import {
  code,
  endpoint,
  OFFER_VERSION,
  parseAnswer,
  parseOffer,
  parseSecret,
  secretHex,
  toHex,
  type TransferAnswer,
  type TransferOffer,
} from "./offer.js"
import { writeSink, type Sink } from "./sink.js"
import { readSource, type ChunkReader, type Source } from "./source.js"
import type { ClientTransport, ConnectHints, Endpoint, TransportConnection, TransportEvents } from "./transport.js"

/** Application bytes, never coding or retransmission overhead. */
export type Progress = {
  /** Bytes read from the source (sending) or written to the sink (receiving). */
  bytes: number
  /** Total bytes, when known. */
  total: number | undefined
  /** True once, at the end: every block was acknowledged (sending) or the sink was closed (receiving). */
  done: boolean
}

export type TransferResult = {
  bytes: number
  /** SHA-256 of the stream as hex, when `hash` was set. An application check, separate from tesera's per-block integrity. */
  sha256?: string
}

export type ClientOptions = {
  transport: ClientTransport
  /** Timing notes for diagnostics and benchmarks. Unstable. */
  probe?: Probe
}

export type SendOptions = {
  /** The UDP relays that carry the transfer. Each is one path. */
  relays: Endpoint[]
  /** Advanced: any k of n tesserae rebuild a block. Defaults to n = relays and k = n - 1, so one path may fail. */
  coding?: { k: number; n: number }
  /** Total bytes, for progress, when the source can't tell. A Blob or Uint8Array already does. */
  size?: number
  hash?: boolean
  signal?: AbortSignal
  onProgress?: (progress: Progress) => void
}

export type ReceiveOptions = {
  offer: TransferOffer
  /** The session secret from the sender, which must reach this end without passing through the relays. */
  secret: string
  sink: Sink
  hash?: boolean
  signal?: AbortSignal
  onProgress?: (progress: Progress) => void
  /** Reconstructed bytes allowed to wait for a slow sink before acknowledgements are held. Defaults to 2 MiB. Up to as much again, at most 256 KiB, gathers for one sink write. */
  maxBufferedBytes?: number
  /** After the first byte, how long the transfer may make no progress before it fails. Defaults to 60 s. */
  idleMs?: number
  /**
   * Attach somewhere other than the sender's entry point, failing with a `path` error if the
   * transport has nowhere else. Off by default: both ends may share one entry point.
   */
  avoidSenderEntry?: boolean
}

const DEFAULT_MAX_BUFFERED = 2 * 1024 * 1024
const DEFAULT_IDLE_MS = 60_000
const PROGRESS_EVERY_MS = 50
// A block body is about 2 KB, and a file sink pays per write: one OPFS write crosses to
// the browser process. Writes gather up to this many bytes, or for this long.
const SINK_BATCH_BYTES = 256 * 1024
const SINK_BATCH_MS = 25
const WAITED = Symbol("waited")
const transports = new WeakMap<TeseraClient, ClientTransport>()

/** The transport a client was made with, for helpers in this package. */
export function transportOf(client: TeseraClient): ClientTransport {
  const transport = transports.get(client)
  if (!transport) throw new TeseraError("invalid", "not a TeseraClient")
  return transport
}

/**
 * The tesera client. It sends and receives end-to-end encrypted transfers over tesera relays,
 * through one client transport. The relays and the attachment carry ciphertext only: the session
 * secret and the plaintext stay in this process.
 *
 * A transfer is set up in two messages the application carries for now:
 * the sender's `offer` and `secret` go to the receiver, and the receiver's `answer` comes back.
 */
export class TeseraClient {
  private readonly transport: ClientTransport
  private readonly probe: Probe | undefined

  constructor(opts: ClientOptions) {
    if (!opts?.transport || typeof opts.transport.connect !== "function") {
      throw new TeseraError("invalid", "TeseraClient needs a transport")
    }
    this.transport = opts.transport
    transports.set(this, opts.transport)
    this.probe = opts.probe
  }

  /** Connects, and returns a transfer whose `offer` and `secret` the receiver needs. Nothing is read or sent until `start`. */
  async send(source: Source, opts: SendOptions): Promise<OutgoingTransfer> {
    if (!Array.isArray(opts?.relays) || opts.relays.length < 1) throw new TeseraError("invalid", "send needs at least one relay")
    const relays = opts.relays.map((relay, i) => endpoint(relay, `relay ${i}`))
    const n = opts.coding?.n ?? relays.length
    const k = opts.coding?.k ?? Math.max(1, n - 1)
    code(k, n)
    let reader: ChunkReader
    try {
      reader = readSource(source)
    } catch (err) {
      throw new TeseraError("invalid", (err as Error).message)
    }
    const wire = new Wire()
    const connection = await connect(this.transport, wire, opts.signal).catch(async (err) => {
      await reader.cancel()
      throw err
    })
    const secret = randomBytes(32)
    const sender = new TeseraSender({ session: secret, relays, k, n, transport: wire.open(connection), ...(this.probe ? { probe: this.probe } : {}) })
    const size = opts.size ?? reader.size
    const offer: TransferOffer = {
      v: OFFER_VERSION,
      sessionId: toHex(sender.sessionId),
      sender: { ...connection.endpoint },
      relays,
      k,
      n,
      ...(size === undefined ? {} : { size }),
    }
    return new OutgoingTransfer(offer, secretHex(secret), sender, connection, wire, reader, opts, this.probe)
  }

  /** Connects, reserves the offer's session at the relay, and starts receiving. Send the `answer` back to the sender. */
  async receive(opts: ReceiveOptions): Promise<IncomingTransfer> {
    const offer = parseOffer(opts?.offer)
    const secret = parseSecret(opts.secret)
    const maxBuffered = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED
    if (!(maxBuffered > 0)) throw new TeseraError("invalid", "maxBufferedBytes must be > 0")
    const sink = writeSink(opts.sink)
    const sessionId = Buffer.from(offer.sessionId, "hex")
    const wire = new Wire()
    const separate = opts.avoidSenderEntry === true
    const connection = await connect(this.transport, wire, opts.signal, separate ? { avoid: [offer.sender] } : {})
    let receiver: TeseraReceiver
    try {
      if (separate && sameEndpoint(connection.endpoint, offer.sender)) {
        throw new TeseraError("path", "the receiver was asked to avoid the sender's entry point, and the transport has no other")
      }
      await connection.claimSession(sessionId)
      receiver = new TeseraReceiver({
        session: secret,
        sessionId,
        relays: offer.relays,
        sender: offer.sender,
        transport: wire.open(connection),
        maxUnreadBytes: maxBuffered,
        ...(this.probe ? { probe: this.probe } : {}),
      })
      await receiver.start()
    } catch (err) {
      await connection.close().catch(() => {})
      throw asTeseraError(err, "connection")
    }
    const answer: TransferAnswer = {
      v: OFFER_VERSION,
      sessionId: offer.sessionId,
      receiver: { ...connection.endpoint },
      maxPacketSize: connection.maxPacketSize,
    }
    return new IncomingTransfer(answer, offer, receiver, connection, sink, opts, this.probe)
  }
}

/** A transfer being sent. Call `start` with the receiver's answer. */
export class OutgoingTransfer {
  /** Everything the receiver needs except the secret. It holds no key material. */
  readonly offer: TransferOffer
  /** The session secret, as hex. Share it only with the receiver, never through the relays. */
  readonly secret: string
  /** Settles when the transfer completes, fails, or is cancelled. */
  readonly done: Promise<TransferResult>

  private readonly sender: TeseraSender
  private readonly connection: TransportConnection
  private readonly reader: ChunkReader
  private readonly hash: ReturnType<typeof streamHash> | null
  private readonly progress: Reporter
  private readonly signal: AbortSignal | undefined
  private settle!: { resolve: (r: TransferResult) => void; reject: (e: TeseraError) => void }
  private started = false
  private finished = false
  private cancelled = false
  private bytes = 0
  private datagramSize = 0
  private readonly probe: Probe | undefined

  /** @internal */
  constructor(
    offer: TransferOffer,
    secret: string,
    sender: TeseraSender,
    connection: TransportConnection,
    wire: Wire,
    reader: ChunkReader,
    opts: SendOptions,
    probe?: Probe,
  ) {
    this.probe = probe
    this.offer = offer
    this.secret = secret
    this.sender = sender
    this.connection = connection
    this.reader = reader
    this.hash = opts.hash ? streamHash() : null
    this.progress = new Reporter(opts.onProgress, offer.size)
    this.done = new Promise((resolve, reject) => {
      this.settle = { resolve, reject }
    })
    this.done.catch(() => {})
    this.signal = opts.signal
    this.signal?.addEventListener("abort", this.onAbort)
    wire.onFailure = (err) => {
      if (!this.started) this.finish(err)
    }
  }

  /** Begin sending to the receiver that answered. Resolves like `done`. */
  start(answer: TransferAnswer): Promise<TransferResult> {
    if (this.started || this.finished) return this.done
    this.started = true
    void this.run(answer).then(
      (result) => this.finish(null, result),
      (err) => this.finish(this.cancelled ? cancelledError() : err),
    )
    return this.done
  }

  /** Stop reading, stop sending, and close the connection. `done` rejects with a `cancelled` error. */
  cancel(): void {
    if (this.finished || this.cancelled) return
    this.cancelled = true
    void this.reader.cancel()
    void this.sender.close()
    if (!this.started) this.finish(cancelledError())
  }

  /** Unstable numbers for diagnostics and tests. */
  diagnostics(): Record<string, number> {
    return {
      ...this.sender.stats,
      maxPacketSize: this.connection.maxPacketSize,
      ...(this.datagramSize ? { datagramSize: this.datagramSize } : {}),
    }
  }

  private readonly onAbort = () => this.cancel()

  private async run(answer: TransferAnswer): Promise<TransferResult> {
    const parsed = parseAnswer(answer)
    if (parsed.sessionId !== this.offer.sessionId) throw new TeseraError("invalid", "the answer is for another transfer")
    this.sender.setReceiver(parsed.receiver, parsed.maxPacketSize)
    await this.sender.start().catch((err) => {
      throw asTeseraError(err, "connection")
    })
    this.datagramSize = this.sender.datagramSize
    for (;;) {
      let chunk: Uint8Array | null
      const t0 = this.probe ? performance.now() : 0
      try {
        chunk = await this.reader.next()
      } catch (err) {
        throw asTeseraError(err, "source")
      }
      if (this.probe) this.probe.note("client.source-read", performance.now() - t0)
      if (chunk === null || this.cancelled) break
      this.hash?.update(chunk)
      const t1 = this.probe ? performance.now() : 0
      await this.sender.write(chunk).catch((err) => {
        throw asTeseraError(err, "transfer")
      })
      if (this.probe) this.probe.note("client.sender-write", performance.now() - t1)
      this.bytes += chunk.length
      this.progress.report(this.bytes, false)
    }
    if (this.cancelled) throw cancelledError()
    await this.sender.end().catch((err) => {
      throw asTeseraError(err, "transfer")
    })
    this.progress.report(this.bytes, true)
    return { bytes: this.bytes, ...(this.hash ? { sha256: this.hash.hex() } : {}) }
  }

  private finish(err: TeseraError | null, result?: TransferResult): void {
    if (this.finished) return
    this.finished = true
    this.signal?.removeEventListener("abort", this.onAbort)
    if (err) void this.reader.cancel()
    void this.sender.close().finally(() => this.connection.close().catch(() => {}))
    if (err) this.settle.reject(err)
    else if (result) this.settle.resolve(result)
  }
}

/** A transfer being received into a sink. It started when `receive` resolved. */
export class IncomingTransfer {
  /** Send this back to the sender. It holds no key material. */
  readonly answer: TransferAnswer
  /** Settles when the sink is closed with the whole stream, or the transfer fails or is cancelled. */
  readonly done: Promise<TransferResult>

  private readonly receiver: TeseraReceiver
  private readonly connection: TransportConnection
  private readonly sink: ReturnType<typeof writeSink>
  private readonly hash: ReturnType<typeof streamHash> | null
  private readonly progress: Reporter
  private readonly signal: AbortSignal | undefined
  private readonly idleMs: number
  private readonly batchBytes: number
  private finished = false
  private cancelled = false
  private bytes = 0
  private readonly probe: Probe | undefined
  private watchdog: ReturnType<typeof setInterval> | null = null

  /** @internal */
  constructor(
    answer: TransferAnswer,
    offer: TransferOffer,
    receiver: TeseraReceiver,
    connection: TransportConnection,
    sink: ReturnType<typeof writeSink>,
    opts: ReceiveOptions,
    probe?: Probe,
  ) {
    this.probe = probe
    this.answer = answer
    this.receiver = receiver
    this.connection = connection
    this.sink = sink
    this.hash = opts.hash ? streamHash() : null
    this.progress = new Reporter(opts.onProgress, offer.size)
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    this.batchBytes = Math.min(SINK_BATCH_BYTES, opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED)
    this.signal = opts.signal
    this.signal?.addEventListener("abort", this.onAbort)
    this.done = this.run().then(
      (result) => {
        this.cleanup(false)
        return result
      },
      (err) => {
        this.cleanup(true)
        throw this.cancelled ? cancelledError() : asTeseraError(err, "transfer")
      },
    )
    this.done.catch(() => {})
  }

  /** Stop receiving, abort the sink, and close the connection, which releases the session at the relay. */
  cancel(): void {
    if (this.finished || this.cancelled) return
    this.cancelled = true
    void this.receiver.close()
  }

  /** Unstable numbers for diagnostics and tests. */
  diagnostics(): Record<string, number> {
    return { ...this.receiver.stats, maxPacketSize: this.connection.maxPacketSize }
  }

  private readonly onAbort = () => this.cancel()

  private async run(): Promise<TransferResult> {
    this.watch()
    const parts: Uint8Array[] = []
    let size = 0
    let deadline: Promise<typeof WAITED> | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let reading: Promise<Uint8Array | null> | null = null
    const flush = async () => {
      clearTimeout(timer)
      deadline = null
      if (size === 0) return
      const batch = parts.length === 1 ? parts[0]! : joinParts(parts, size)
      const bytes = size
      parts.length = 0
      size = 0
      const t1 = this.probe ? performance.now() : 0
      try {
        await this.sink.write(batch)
      } catch (err) {
        throw asTeseraError(err, "sink")
      }
      if (this.probe) this.probe.note("client.sink-write", performance.now() - t1)
      this.bytes += bytes
      this.progress.report(this.bytes, false)
    }
    try {
      for (;;) {
        const t0 = this.probe ? performance.now() : 0
        reading ??= this.receiver.read()
        const chunk = deadline ? await Promise.race([reading, deadline]) : await reading
        if (this.probe) this.probe.note("client.read-wait", performance.now() - t0)
        if (this.cancelled) throw cancelledError()
        if (chunk === WAITED) {
          await flush()
          continue
        }
        reading = null
        if (chunk === null) break
        this.hash?.update(chunk)
        parts.push(chunk)
        size += chunk.length
        if (size >= this.batchBytes) await flush()
        else if (!deadline) deadline = new Promise((resolve) => (timer = setTimeout(resolve, SINK_BATCH_MS, WAITED)))
      }
      await flush()
    } finally {
      clearTimeout(timer)
    }
    if (this.cancelled) throw cancelledError()
    try {
      await this.sink.close()
    } catch (err) {
      throw asTeseraError(err, "sink")
    }
    if (this.cancelled) throw cancelledError()
    this.progress.report(this.bytes, true)
    return { bytes: this.bytes, ...(this.hash ? { sha256: this.hash.hex() } : {}) }
  }

  /** The receiver has no deadline of its own. After the first byte, a stalled transfer fails here. */
  private watch(): void {
    let seen = 0
    let at = Date.now()
    this.watchdog = setInterval(() => {
      const now = this.receiver.stats.outputBytes + this.bytes
      if (now !== seen) {
        seen = now
        at = Date.now()
      } else if (seen > 0 && Date.now() - at > this.idleMs) {
        this.receiver.fail(new TeseraError("transfer", `no progress for ${Math.round(this.idleMs / 1000)} s`))
      }
    }, Math.min(1000, this.idleMs))
  }

  private cleanup(failed: boolean): void {
    if (this.finished) return
    this.finished = true
    this.signal?.removeEventListener("abort", this.onAbort)
    if (this.watchdog) clearInterval(this.watchdog)
    if (failed) {
      void this.sink.abort(this.cancelled ? cancelledError() : new TeseraError("transfer", "the transfer failed")).catch(() => {})
      void this.receiver.close().finally(() => this.connection.close().catch(() => {}))
      return
    }
    // Keep answering briefly: the sender may still be waiting for an acknowledgement that was lost.
    void this.receiver
      .linger()
      .finally(() => this.receiver.close())
      .finally(() => this.connection.close().catch(() => {}))
  }
}

/**
 * Connects a core sender or receiver to a client connection. The connection opens first, so the
 * transfer can learn its address and packet limit before the core starts; the core binds here later.
 */
class Wire {
  onFailure: ((err: TeseraError) => void) | null = null
  private bound: CoreEvents | null = null
  private failure: TeseraError | null = null

  readonly events: TransportEvents = {
    packet: (packet, from) => this.bound?.packet(packet, from),
    error: (err) => {
      const failure = asTeseraError(err, "connection")
      this.failure ??= failure
      this.bound?.error(failure)
      this.onFailure?.(failure)
    },
  }

  open(connection: TransportConnection): OpenTransport {
    return async (events) => {
      if (this.failure) throw this.failure
      this.bound = events
      return {
        endpoint: connection.endpoint,
        maxPacketSize: connection.maxPacketSize,
        send: (packet, to) => connection.send(packet, to),
        close: () => connection.close(),
      }
    }
  }
}

class Reporter {
  private lastAt = 0

  constructor(
    private readonly onProgress: ((progress: Progress) => void) | undefined,
    private readonly total: number | undefined,
  ) {}

  report(bytes: number, done: boolean): void {
    if (!this.onProgress) return
    const now = Date.now()
    if (!done && now - this.lastAt < PROGRESS_EVERY_MS) return
    this.lastAt = now
    try {
      this.onProgress({ bytes, total: this.total, done })
    } catch {
      // an application's progress handler cannot fail the transfer
    }
  }
}

async function connect(transport: ClientTransport, wire: Wire, signal: AbortSignal | undefined, hints?: ConnectHints): Promise<TransportConnection> {
  if (signal?.aborted) throw cancelledError()
  try {
    return await transport.connect(wire.events, signal, hints)
  } catch (err) {
    throw asTeseraError(err, "connection")
  }
}

export function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.host === b.host && a.port === b.port
}

function cancelledError(): TeseraError {
  return new TeseraError("cancelled", "the transfer was cancelled")
}

function joinParts(parts: Uint8Array[], size: number): Uint8Array {
  const joined = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }
  return joined
}
