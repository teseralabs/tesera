import type { Endpoint } from "../carrier/transport.js"
import { allowsLog, formatLog, type LogLevel } from "../log.js"
import type { LocalDelivery } from "../relay/local.js"
import type { Relay } from "../relay/relay.js"
import { sleep } from "../util.js"
import type { WebTransportCert } from "./cert.js"
import {
  Attachments,
  innerOf,
  type Attachment,
  type AttachmentLimits,
  type ClaimResult,
} from "./attachments.js"
import {
  ATTACH_PATH,
  CLAIM,
  CLAIM_FULL,
  CLAIM_OK,
  CLAIM_TAKEN,
  decodeControl,
  decodeFrame,
  encodeAddress,
  encodeControl,
  encodeFrame,
  HELLO,
} from "./framing.js"

/** Direction of a captured datagram, for a diagnostics or leak-check tap. */
export type CaptureDir = "wt-in" | "wt-out"

export type WebTransportListenerOptions = {
  /** Bind host for the HTTP/3 listener. */
  host: string
  /** UDP port for HTTP/3, separate from the relay's tesera UDP port. 0 picks a free port. */
  port: number
  /** Certificate and key for the listener, with the hash a browser pins. */
  cert: WebTransportCert
  /** Attachment and claim caps. Defaults in `DEFAULT_ATTACHMENT_LIMITS`. */
  limits?: Partial<AttachmentLimits>
  /** How often idle attachments and claims are swept. Defaults to a third of the idle window. */
  sweepMs?: number
  log?: (line: string) => void
  logLevel?: LogLevel
  /** Diagnostics tap for every WebTransport datagram in and out. Off in production. */
  capture?: (dir: CaptureDir, bytes: Uint8Array) => void
}

export type AttachStats = {
  attachments: number
  framesIn: number
  bytesIn: number
  framesOut: number
  bytesOut: number
  forwarded: number
  droppedMalformed: number
  droppedForward: Record<string, number>
  returnUnmatched: number
  claims: Record<string, number>
  rejectedFull: number
}

/** A minimal structural type for the library's WebTransport session, to avoid a type dependency. */
type WtSession = {
  ready: Promise<void>
  closed: Promise<unknown>
  close(info?: { closeCode?: number; reason?: string }): void
  peerAddress?: string
  datagrams: {
    maxDatagramSize: number
    readable: ReadableStream<Uint8Array>
    writable?: WritableStream<Uint8Array>
    createWritable?: () => WritableStream<Uint8Array>
  }
  incomingBidirectionalStreams: ReadableStream<WtStream>
}

type WtStream = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }

type Http3Server = {
  startServer(): void
  stopServer(): Promise<void> | void
  ready: Promise<void>
  address(): { port: number } | null
  sessionStream(path: string): Promise<ReadableStream<WtSession>>
}

type Http3Lib = {
  Http3Server: new (o: { host: string; port: number; secret: string; cert: string; privKey: string }) => Http3Server
}

const READY_MS = 10_000
const TRANSPORT_PACKAGE = "@fails-components/webtransport-transport-http3-quiche"

/**
 * Loads the WebTransport library and its native HTTP/3 transport. The library only logs a transport
 * that fails to load, and its server then never becomes ready, so the transport is loaded here first.
 */
async function loadWebTransport(): Promise<Http3Lib> {
  const failed = (name: string, err: unknown) => {
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number)
    const old = major < 20 || (major === 20 && minor < 17)
    return new Error(
      `--webtransport needs the optional ${name} package, which failed to load: ${err instanceof Error ? err.message : String(err)}. ` +
        (old
          ? `this is Node.js ${process.versions.node}, and npm skips that package without an error before Node.js 20.17. use Node.js 22 and run npm ci again`
          : "it is an optional dependency, so npm can skip it without an error. reinstall with npm ci and check its output"),
    )
  }
  try {
    await import(TRANSPORT_PACKAGE)
  } catch (err) {
    throw failed(TRANSPORT_PACKAGE, err)
  }
  try {
    return (await import("@fails-components/webtransport")) as unknown as Http3Lib
  } catch (err) {
    throw failed("@fails-components/webtransport", err)
  }
}

/**
 * The WebTransport attachment capability of a relay: a WebTransport listener that uses the relay's generic
 * local-delivery hook. One process, one identity. A client attaches, gets the relay's own UDP address
 * as its return address, and either learns its session from its outbound frames (a sender) or claims a
 * session id over a control stream (a receiver). Bare frames arriving at the relay's UDP address are
 * matched by session id and sent to the owning attachment. The listener never decrypts anything and never
 * forwards a UDP-arrived packet onward, so there is only ever the one compatibility hop.
 */
export class WebTransportListener {
  readonly attachments: Attachments
  private readonly opts: WebTransportListenerOptions
  private server: Http3Server | null = null
  private lib: Http3Lib | null = null
  private cert: WebTransportCert
  private bound: Endpoint | null = null
  private relay: Relay | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private closed = false
  private readonly sessions = new Set<WtSession>()
  private readonly wtByAttachment = new Map<Attachment, WtSession>()
  readonly stats: AttachStats = {
    attachments: 0,
    framesIn: 0,
    bytesIn: 0,
    framesOut: 0,
    bytesOut: 0,
    forwarded: 0,
    droppedMalformed: 0,
    droppedForward: {},
    returnUnmatched: 0,
    claims: {},
    rejectedFull: 0,
  }

  constructor(opts: WebTransportListenerOptions) {
    this.opts = opts
    this.cert = opts.cert
    this.attachments = new Attachments(opts.limits)
  }

  /** The hook the relay delivers return frames through. Pass this to `new Relay({ localDelivery })`. */
  get localDelivery(): LocalDelivery {
    return {
      deliverReturn: (packet, from) => {
        if (this.attachments.deliverReturn(packet, from)) return true
        this.stats.returnUnmatched++
        return false
      },
    }
  }

  get endpoint(): Endpoint {
    if (!this.bound) throw new Error("WebTransport listener has not started")
    return this.bound
  }

  /** Whether clients can attach now. A relay publishes its transport statement only while this is true. */
  get listening(): boolean {
    return this.bound !== null && this.server !== null && !this.closed
  }

  get certHash(): Buffer {
    return this.cert.hash
  }

  /** The certificate the listener presents now. */
  get certificate(): WebTransportCert {
    return this.cert
  }

  /** Load the WebTransport library, so a relay that can't serve WebTransport fails before it binds anything. */
  async load(): Promise<void> {
    this.lib ??= await loadWebTransport()
  }

  /** Start the HTTP/3 listener for `relay`. The library loads here if `load` wasn't called. */
  async start(relay: Relay): Promise<Endpoint> {
    if (!relay.publicEndpoint) {
      throw new Error("--webtransport on a relay listening on every interface needs --advertise HOST:PORT, the address peers send to")
    }
    this.relay = relay
    await this.load()
    this.bound = { host: this.opts.host, port: await this.listen(this.opts.port) }
    const sweepMs = this.opts.sweepMs ?? Math.max(1_000, Math.floor(this.attachments.idleMs / 3))
    const timer = setInterval(() => this.runSweep(), sweepMs)
    timer.unref()
    this.sweepTimer = timer
    this.emit("info", "webtransport-listen", { addr: `${this.bound.host}:${this.bound.port}`, hash: this.certHash.toString("hex") })
    return this.bound
  }

  /**
   * Present a new certificate. The HTTP/3 server can't swap one in place, so it restarts on the same
   * port, and every attachment open at that moment closes. The relay itself keeps running.
   */
  async useCert(cert: WebTransportCert): Promise<void> {
    if (!this.bound || this.closed) throw new Error("WebTransport listener has not started")
    this.cert = cert
    await this.stopServer("certificate changed")
    await this.listen(this.bound.port)
    this.emit("info", "webtransport-cert", { hash: cert.hash.toString("hex") })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    await this.stopServer()
  }

  private async listen(port: number): Promise<number> {
    const { randomBytes } = await import("node:crypto")
    const server = new this.lib!.Http3Server({
      host: this.opts.host,
      port,
      secret: randomBytes(16).toString("hex"),
      cert: this.cert.cert,
      privKey: this.cert.privKey,
    })
    server.startServer()
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the HTTP/3 listener was not ready after ${READY_MS / 1000} s`)), READY_MS)
    })
    try {
      await Promise.race([server.ready, late])
    } catch (err) {
      await Promise.resolve(server.stopServer()).catch(() => {})
      throw err
    } finally {
      clearTimeout(timer)
    }
    this.server = server
    const bound = server.address()?.port
    if (!bound) throw new Error("the HTTP/3 listener did not report a port")
    void this.accept()
    return bound
  }

  private async stopServer(reason = "relay is closing"): Promise<void> {
    const closing = [...this.sessions].map((session) => {
      session.close({ closeCode: 3, reason })
      return session.closed.catch(() => {})
    })
    this.sessions.clear()
    // Let the close frames leave before the socket goes, or a client waits out its idle timeout.
    await Promise.race([Promise.all(closing), sleep(500)])
    const server = this.server
    this.server = null
    if (server) await Promise.resolve(server.stopServer()).catch(() => {})
  }

  private runSweep(): void {
    for (const attachment of this.attachments.sweep()) {
      const session = this.wtByAttachment.get(attachment)
      if (session) session.close({ closeCode: 2, reason: "idle" })
    }
  }

  private async accept(): Promise<void> {
    const server = this.server
    if (!server) return
    const reader = (await server.sessionStream(ATTACH_PATH)).getReader()
    for (;;) {
      const { value: session, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
      if (done || !session) return
      void this.attachSession(session).catch(() => session.close())
    }
  }

  private async attachSession(session: WtSession): Promise<void> {
    await session.ready
    if (this.closed) {
      session.close()
      return
    }
    const ip = peerIp(session.peerAddress)
    const writer = (session.datagrams.createWritable ? session.datagrams.createWritable() : session.datagrams.writable!).getWriter()
    // The registry calls this to deliver a return frame; wrap it with the address it came from.
    const send: Attachment["send"] = (packet, from) => {
      const frame = encodeFrame(from, packet)
      this.stats.framesOut++
      this.stats.bytesOut += frame.length
      this.opts.capture?.("wt-out", frame)
      writer.write(frame).catch(() => {})
    }
    const attachment = this.attachments.add(ip, send)
    if (!attachment) {
      this.stats.rejectedFull++
      session.close({ closeCode: 1, reason: "relay is full" })
      return
    }
    this.stats.attachments++
    this.sessions.add(session)
    this.wtByAttachment.set(attachment, session)
    session.closed.catch(() => {}).finally(() => {
      this.sessions.delete(session)
      this.wtByAttachment.delete(attachment)
      this.attachments.close(attachment)
    })
    void this.serveControl(session, attachment)

    const reader = session.datagrams.readable.getReader()
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
      if (done || !value) return
      this.stats.framesIn++
      this.stats.bytesIn += value.length
      this.opts.capture?.("wt-in", value)
      this.attachments.touch(attachment)
      const frame = decodeFrame(value)
      if (!frame) {
        this.stats.droppedMalformed++
        continue
      }
      // Learn the session end from the endpoint's own outbound frame, so returns can find this
      // attachment. A frame from an end another attachment holds, or that isn't a tesera frame, is not forwarded.
      const learned = this.attachments.learn(innerOf(frame.packet), attachment)
      if (learned !== "ok") {
        this.stats.droppedForward[learned] = (this.stats.droppedForward[learned] ?? 0) + 1
        continue
      }
      const result = this.relay!.forwardForLocal(Buffer.from(frame.packet), frame.address)
      this.stats.droppedForward[result] = (this.stats.droppedForward[result] ?? 0) + 1
      if (result === "ok") this.stats.forwarded++
    }
  }

  private async serveControl(session: WtSession, attachment: Attachment): Promise<void> {
    const streams = session.incomingBidirectionalStreams.getReader()
    for (;;) {
      const { value: stream, done } = await streams.read().catch(() => ({ value: undefined, done: true }))
      if (done || !stream) return
      void this.handleControl(stream, attachment).catch(() => {})
    }
  }

  private async handleControl(stream: WtStream, attachment: Attachment): Promise<void> {
    const bytes = await readAll(stream.readable)
    const req = decodeControl(bytes)
    const writer = stream.writable.getWriter()
    try {
      if (req?.kind === HELLO) {
        // A repeated hello keeps an attachment that is waiting to send from going idle.
        this.attachments.touch(attachment)
        // The return address is the relay's own public UDP address, shared by every attachment and told apart by session id.
        await writer.write(encodeControl(HELLO, encodeAddress(this.relay!.publicEndpoint!)))
      } else if (req?.kind === CLAIM) {
        this.attachments.touch(attachment)
        const sessionHex = req.body.length === 16 ? Buffer.from(req.body).toString("hex") : null
        const status = sessionHex ? this.attachments.claim(sessionHex, attachment) : "ignored"
        this.stats.claims[status] = (this.stats.claims[status] ?? 0) + 1
        await writer.write(encodeControl(CLAIM, new Uint8Array([claimByte(status)])))
      }
      // An unknown control kind or a wrong version gets no reply, and the stream just closes.
    } finally {
      await writer.close().catch(() => {})
    }
  }

  private emit(level: LogLevel, event: string, fields: Record<string, string | number>): void {
    const log = this.opts.log
    if (!log || !allowsLog(this.opts.logLevel ?? "info", level)) return
    log(formatLog("relay", event, fields))
  }
}

function claimByte(status: ClaimResult): number {
  if (status === "ok") return CLAIM_OK
  if (status === "full") return CLAIM_FULL
  return CLAIM_TAKEN
}

/** The IP of a `host:port` peer address, or a single bucket when the library gives none. */
function peerIp(peerAddress: string | undefined): string {
  if (!peerAddress) return "unknown"
  const at = peerAddress.lastIndexOf(":")
  return at > 0 ? peerAddress.slice(0, at) : peerAddress
}

async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader()
  const parts: Buffer[] = []
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
    if (done || !value) break
    parts.push(Buffer.from(value))
  }
  return Buffer.concat(parts)
}
