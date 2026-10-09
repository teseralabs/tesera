import {
  ATTACH_PATH,
  ATTACH_VERSION,
  CLAIM,
  CLAIM_FULL,
  CLAIM_OK,
  CLAIM_TAKEN,
  decodeAddress,
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  FRAME_HEADER_LEN,
  HELLO,
} from "../core.js"
import { TeseraError } from "../errors.js"
import type { ClientTransport, Endpoint, TransportConnection, TransportEvents } from "../transport.js"

/** How to reach one relay's WebTransport attachment listener, the relay started with `--webtransport`. */
export type WebTransportRelay = {
  /** The listener's origin, such as `https://203.0.113.5:4433`. The client adds the attach path. */
  url: string
  /**
   * SHA-256 of the relay's certificate, as 64 hex characters, which a relay with a self-signed
   * certificate prints at startup. Several are accepted, such as a relay's current and next
   * certificate during a rotation. Omit it for a certificate a browser already trusts.
   */
  certificateHash?: string | string[]
}

export type WebTransportOptions = WebTransportRelay & {
  /** Time allowed to connect and receive the relay's attach hello. Defaults to 10 s. */
  connectTimeoutMs?: number
  /** How long a connection may send nothing before it says hello to stay attached. Defaults to 15 s, under a relay's 60 s idle limit. */
  keepaliveMs?: number
  /** A WebTransport implementation for runtimes without a global one. Defaults to `globalThis.WebTransport`. */
  WebTransport?: WebTransportConstructor
}

export type WebTransportConstructor = new (url: string, options?: WebTransportOptionsInit) => WebTransportLike

type WebTransportOptionsInit = {
  serverCertificateHashes?: Array<{ algorithm: string; value: Uint8Array }>
  congestionControl?: string
}

/** The part of WebTransport this transport uses, so another implementation can stand in. */
export interface WebTransportLike {
  readonly ready: Promise<unknown>
  readonly closed: Promise<unknown>
  readonly datagrams: {
    readonly maxDatagramSize?: number
    readonly readable: ReadableStream<Uint8Array>
    readonly writable?: WritableStream<Uint8Array>
    createWritable?: () => WritableStream<Uint8Array>
  }
  createBidirectionalStream(): Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>
  close(info?: { closeCode?: number; reason?: string }): void
}

/** Used when a runtime does not report its datagram limit. Every QUIC path carries at least this much. */
const FALLBACK_DATAGRAM = 1024
/** A control reply is a few bytes. Anything longer is not a relay speaking this version. */
const MAX_CONTROL_REPLY = 64
/**
 * A relay closes an attachment that has been quiet for a minute. One waiting for its peer, a
 * sender before the answer or a receiver before the first block, says hello this often.
 */
const KEEPALIVE_MS = 15_000
/**
 * Incoming datagrams a browser may hold for this page, about a megabyte. Chrome holds one by
 * default and drops the rest of a burst that arrives while the page is busy, which a transfer
 * reads as loss. The outgoing limit stays as it is: past it, a write waits for QUIC's congestion
 * window, where a longer queue would only drop datagrams inside the browser.
 */
const INCOMING_QUEUE = 1024

/** True when this runtime has a global WebTransport. */
export function webTransportSupported(scope: { WebTransport?: unknown } = globalThis as { WebTransport?: unknown }): boolean {
  return typeof scope.WebTransport === "function"
}

/**
 * The WebTransport client transport. Each connection attaches to one relay: the relay gives it an
 * address, carries its tesera datagrams one hop to the UDP relays of a transfer, and delivers the
 * replies back. The attach framing stays inside this transport; the client above sees only datagrams.
 */
export function webTransport(opts: WebTransportOptions): ClientTransport {
  const url = attachUrl(opts.url)
  const given = opts.certificateHash
  const hashes = (given === undefined ? [] : Array.isArray(given) ? given : [given]).map(certificateHash)
  const timeoutMs = opts.connectTimeoutMs ?? 10_000
  const keepaliveMs = opts.keepaliveMs ?? KEEPALIVE_MS
  return {
    name: "webtransport",
    connect: async (events, signal) => {
      const Impl = opts.WebTransport ?? (globalThis as { WebTransport?: WebTransportConstructor }).WebTransport
      if (typeof Impl !== "function") throw new TeseraError("unsupported", "this runtime has no WebTransport")
      return attach(Impl, url, hashes, timeoutMs, keepaliveMs, events, signal)
    },
  }
}

async function attach(
  Impl: WebTransportConstructor,
  url: string,
  hashes: Uint8Array[],
  timeoutMs: number,
  keepaliveMs: number,
  events: TransportEvents,
  signal: AbortSignal | undefined,
): Promise<TransportConnection> {
  if (signal?.aborted) throw new TeseraError("cancelled", "cancelled before connecting")
  let wt: WebTransportLike
  try {
    wt = new Impl(url, {
      ...(hashes.length > 0 ? { serverCertificateHashes: hashes.map((value) => ({ algorithm: "sha-256", value })) } : {}),
      congestionControl: "throughput",
    })
  } catch (err) {
    throw new TeseraError("connection", `could not open WebTransport to ${url}`, { cause: err })
  }
  let closing = false
  const abandon = () => {
    closing = true
    try {
      wt.close()
    } catch {
      // already closed
    }
  }
  wt.closed.catch(() => {})
  const opening = (async () => {
    try {
      await wt.ready
    } catch (err) {
      throw new TeseraError("connection", `could not connect to ${url}`, { cause: err })
    }
    const reply = await control(wt, encodeControl(HELLO))
    const hello = decodeControl(reply)
    if (!hello || hello.kind !== HELLO) {
      throw new TeseraError("incompatible", `the relay at ${url} did not answer attach version ${ATTACH_VERSION}`)
    }
    const endpoint = decodeAddress(hello.body)
    if (!endpoint) throw new TeseraError("incompatible", `the relay at ${url} sent an attach hello without an address`)
    return endpoint
  })()
  let endpoint: Endpoint
  try {
    endpoint = await within(opening, timeoutMs, signal, url)
  } catch (err) {
    abandon()
    throw err
  }

  widenIncoming(wt.datagrams)
  const maxDatagram = typeof wt.datagrams.maxDatagramSize === "number" ? wt.datagrams.maxDatagramSize : FALLBACK_DATAGRAM
  const writable = wt.datagrams.createWritable ? wt.datagrams.createWritable() : wt.datagrams.writable
  if (!writable) {
    abandon()
    throw new TeseraError("unsupported", "this WebTransport has no datagram writer")
  }
  const writer = writable.getWriter()
  const reader = wt.datagrams.readable.getReader()
  let lastSent = Date.now()
  const keepalive = setInterval(() => {
    if (closing || Date.now() - lastSent < keepaliveMs) return
    lastSent = Date.now()
    void control(wt, encodeControl(HELLO)).catch(() => {})
  }, keepaliveMs / 3)
  ;(keepalive as { unref?: () => void }).unref?.()
  void wt.closed.finally(() => clearInterval(keepalive)).catch(() => {})

  void (async () => {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await reader.read()
      } catch {
        return
      }
      if (next.done) return
      const frame = decodeFrame(next.value)
      if (frame) events.packet(frame.packet, frame.address)
    }
  })()
  wt.closed.then(
    () => {
      if (!closing) events.error(new TeseraError("connection", "the relay closed the attachment"))
    },
    (err) => {
      if (!closing) events.error(new TeseraError("connection", "the attachment to the relay failed", { cause: err }))
    },
  )

  return {
    endpoint,
    maxPacketSize: maxDatagram - FRAME_HEADER_LEN,
    async send(packet, to) {
      if (closing) throw new TeseraError("connection", "the attachment is closed")
      if (FRAME_HEADER_LEN + packet.length > maxDatagram) {
        throw new TeseraError("transfer", `a ${packet.length}-byte datagram does not fit this attachment's ${maxDatagram - FRAME_HEADER_LEN}`)
      }
      let frame: Uint8Array
      try {
        frame = encodeFrame(to, packet)
      } catch (err) {
        throw new TeseraError("path", `relay ${to.host}:${to.port} cannot be reached through an attachment, which carries IPv4 only`, { cause: err })
      }
      lastSent = Date.now()
      await writer.ready
      await writer.write(frame)
    },
    async claimSession(sessionId) {
      if (closing) throw new TeseraError("connection", "the attachment is closed")
      const reply = decodeControl(await within(control(wt, encodeControl(CLAIM, sessionId)), timeoutMs, undefined, url))
      const status = reply?.kind === CLAIM ? reply.body[0] : undefined
      if (status === CLAIM_OK) return
      if (status === CLAIM_TAKEN) throw new TeseraError("claim", "another connection at this relay already holds the session")
      if (status === CLAIM_FULL) throw new TeseraError("claim", "the relay cannot hold another session for this connection")
      throw new TeseraError("incompatible", `the relay at ${url} sent an unknown claim reply`)
    },
    async close() {
      if (closing) return
      clearInterval(keepalive)
      // Closing the session ends its datagram streams. Cancelling the reader first races datagrams
      // still arriving, which some implementations throw on.
      abandon()
      await wt.closed.catch(() => {})
    },
  }
}

/** One request and its reply, on a fresh bidirectional stream. */
async function control(wt: WebTransportLike, request: Uint8Array): Promise<Uint8Array> {
  let stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }
  try {
    stream = await wt.createBidirectionalStream()
    const writer = stream.writable.getWriter()
    await writer.write(request)
    await writer.close()
  } catch (err) {
    throw new TeseraError("connection", "the attach control stream failed", { cause: err })
  }
  const reader = stream.readable.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>
    try {
      next = await reader.read()
    } catch (err) {
      throw new TeseraError("connection", "the attach control stream failed", { cause: err })
    }
    if (next.done) break
    total += next.value.length
    if (total > MAX_CONTROL_REPLY) {
      await reader.cancel().catch(() => {})
      throw new TeseraError("incompatible", "the relay sent an oversized attach reply")
    }
    parts.push(next.value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.length
  }
  return bytes
}

function within<T>(work: Promise<T>, ms: number, signal: AbortSignal | undefined, url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => finish(() => reject(new TeseraError("cancelled", "cancelled while connecting")))
    const timer = setTimeout(() => finish(() => reject(new TeseraError("connection", `no attach hello from ${url} within ${ms} ms`))), ms)
    signal?.addEventListener("abort", onAbort, { once: true })
    let settled = false
    function finish(done: () => void) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      done()
    }
    work.then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    )
  })
}

function attachUrl(origin: string): string {
  let url: URL
  try {
    url = new URL(origin)
  } catch (err) {
    throw new TeseraError("invalid", `not a URL: ${origin}`, { cause: err })
  }
  if (url.protocol !== "https:") throw new TeseraError("invalid", `a WebTransport relay URL must be https, not ${url.protocol}`)
  return new URL(ATTACH_PATH, url).toString()
}

/** Raise whichever incoming datagram limit this implementation has. Older Chrome names it a high water mark. */
function widenIncoming(datagrams: object): void {
  for (const name of ["incomingMaxBufferedDatagrams", "incomingHighWaterMark"]) {
    if (!(name in datagrams)) continue
    try {
      ;(datagrams as Record<string, unknown>)[name] = INCOMING_QUEUE
    } catch {
      // A read-only limit stays as the implementation set it.
    }
  }
}

function certificateHash(hex: string): Uint8Array {
  const clean = hex.replace(/[:\s]/g, "").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new TeseraError("invalid", "certificateHash must be a SHA-256 digest in hex")
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
