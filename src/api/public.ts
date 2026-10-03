// HTTP send and receive. Two calls that share a session are the two ends.
// This process opens both UDP sockets, then runs the bytes through the relays.
// The session secret and the payload never go in a log line.

import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { PortPool, startOnPort, type PortRange } from "../carrier/ports.js"
import { resolveRelayRef } from "../carrier/resolve.js"
import { isLoopback, normalizeHost, type Endpoint } from "../carrier/udp.js"
import {
  DEFAULT_MAX_SENDS,
  DEFAULT_NACK_AFTER_MS,
  DEFAULT_RETX_AFTER_MS,
  DEFAULT_SHARD,
  DEFAULT_WINDOW,
  MAX_AHEAD,
  MAX_SHARD,
  PROTOCOL_VERSION,
  assertCode,
  assertShardSize,
} from "../constants.js"
import { parseSession } from "../crypto/session.js"
import { confirmRelay } from "../identity/confirm.js"
import { discoverRelays, preferJoined } from "../identity/peers.js"
import { ApiLimiter, DEFAULT_API_LIMITS, clientAddress, trustedProxies, type ApiLimitConfig, type LimitResult } from "./limit.js"
import { SOFTWARE_VERSION, fetchRelayRecord, recordDocument } from "../identity/record.js"
import { readRelaySnapshot } from "../identity/stats.js"
import type { LogFields } from "../log.js"
import { TeseraReceiver } from "../transport/receiver.js"
import { TeseraSender } from "../transport/sender.js"
import { asError, concatBytes } from "../util.js"

export const MAX_API_BYTES = 25 * 1024 * 1024
export const MAX_API_PAIRS = 32
export const MAX_API_DEADLINE_MS = 180_000
/** Time allowed to receive request headers. Separate from x-tesera-deadline-ms. */
export const API_HEADERS_TIMEOUT_MS = 10_000
/** Time allowed to receive a complete request, including a slow body. */
export const API_REQUEST_TIMEOUT_MS = 60_000
export const API_KEEPALIVE_TIMEOUT_MS = 5_000
export const API_MAX_HEADER_BYTES = 16 * 1024
const DEFAULT_DEADLINE_MS = 60_000
const DOCS_URL = "https://tesera.net/api.html"
/** How long the default seed's confirmed relays are reused when `preferJoined` is on. */
const SEED_RELAYS_MS = 30_000
/** A retry through the seed alone needs at least this much of the deadline left. */
const MIN_RETRY_MS = 1_000

export class ApiError extends Error {
  logged = false

  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSec?: number,
  ) {
    super(code)
  }
}

export type PublicApiOptions = {
  /** Seed used when a call names neither relays nor a discover host. */
  discover: Endpoint
  /** That seed's relay id, when the operator pinned it. */
  discoverId?: string | null
  /** Address relays can send back to. Loopback binds there. Any other address binds all interfaces. */
  advertise: string
  /** UDP ports for transfer sockets. Unset binds a random port. */
  ports?: PortRange | null
  /**
   * Calls on the default seed use the relays joined to it and keep the seed
   * for one retry. For a seed on this machine, which would otherwise carry every block.
   */
  preferJoined?: boolean
  maxBytes?: number
  maxPairs?: number
  /** Socket addresses allowed to supply the client through X-Forwarded-For. */
  trustProxy?: readonly string[]
  limits?: Partial<ApiLimitConfig>
  log?: (event: string, fields: LogFields) => void
}

export type PublicApi = {
  endpoint: Endpoint
  close: () => Promise<void>
}

type Coding = {
  k: number
  n: number
  shardSize: number
  window: number
  maxSends: number
  retxAfterMs: number
  nackAfterMs: number
}

type Arrival = {
  side: "send" | "receive"
  session: Buffer
  relays: Endpoint[]
  relayKey: string
  /** The call named no relays and no seed, so it used the default seed. */
  seedDefault: boolean
  payload: Buffer | null
  deadlineAt: number
  coding: Coding
  abort: AbortSignal
}

type Outcome = {
  bytes: Buffer
  relays: number
  tesserae: number
  retransmits: number
  acks: number
}

type Slot = {
  key: string
  first: Arrival
  second: Arrival | null
  running: boolean
  settled: boolean
  timer: NodeJS.Timeout
  result: Promise<Outcome>
  finish: (value: Outcome) => void
  fail: (err: ApiError) => void
  cancel: () => void
}

const ALLOW_HEADERS = [
  "content-type",
  "x-tesera-session",
  "x-tesera-relays",
  "x-tesera-discover",
  "x-tesera-k",
  "x-tesera-n",
  "x-tesera-shard",
  "x-tesera-window",
  "x-tesera-max-sends",
  "x-tesera-retx-after-ms",
  "x-tesera-nack-after-ms",
  "x-tesera-deadline-ms",
].join(", ")

const EXPOSE_HEADERS = "x-tesera-bytes, x-tesera-relays, x-tesera-tesserae, x-tesera-retransmits, x-tesera-acks"

export async function listenPublicApi(host: string, port: number, opts: PublicApiOptions): Promise<PublicApi> {
  const advertise = normalizeHost(opts.advertise)
  const maxBytes = opts.maxBytes ?? MAX_API_BYTES
  const maxPairs = opts.maxPairs ?? MAX_API_PAIRS
  const slots = new Map<string, Slot>()
  const log = opts.log ?? (() => {})
  const pool = opts.ports ? new PortPool(opts.ports) : null
  let seedCache: { at: number; relays: Endpoint[] } | null = null

  const trusted = trustedProxies(opts.trustProxy ?? [])
  const limiter = new ApiLimiter({ ...DEFAULT_API_LIMITS, ...opts.limits })
  const server = createServer(
    {
      maxHeaderSize: API_MAX_HEADER_BYTES,
      headersTimeout: API_HEADERS_TIMEOUT_MS,
      requestTimeout: API_REQUEST_TIMEOUT_MS,
      keepAliveTimeout: API_KEEPALIVE_TIMEOUT_MS,
    },
    (req, res) => {
      void handle(req, res).catch((err) => {
        if (res.writableEnded || res.destroyed) return
        const api = err instanceof ApiError ? err : new ApiError(500, "unavailable")
        if (api.code === "closed") return
        note(log, api)
        try {
          sendJson(res, api.status, { error: api.code }, retryHeader(api))
        } catch {
          // The caller already went away.
        }
        if (api.code === "size" || api.code === "rate_limit") req.destroy()
      })
    },
  )
  server.timeout = 0

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening)
      reject(err)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("api did not bind")
  const endpoint = { host: address.address, port: address.port }
  log("listen", { addr: `${endpoint.host}:${endpoint.port}` })

  return {
    endpoint,
    async close() {
      for (const slot of slots.values()) slot.fail(new ApiError(503, "unavailable"))
      slots.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url?.split("?")[0]
    if (req.method === "OPTIONS") {
      writeCors(res, 204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": ALLOW_HEADERS,
        "access-control-max-age": "600",
      })
      res.end()
      return
    }
    const route = routeOf(path)
    if (!route) throw new ApiError(404, "not_found")
    if (!route.methods.has(req.method ?? "")) throw new ApiError(405, "method")
    const ip = clientAddress(req.socket.remoteAddress, forwardedFor(req), trusted)
    if (route.kind === "info") {
      admit(limiter.admitInfo(ip))
      if (path === "/") {
        sendJson(res, 200, publicIndex())
        return
      }
      if (path === "/v0/record") {
        const packet = await fetchRelayRecord(opts.discover).catch(() => null)
        const doc = packet ? recordDocument(packet) : null
        if (!doc) throw new ApiError(502, "record")
        sendJson(res, 200, doc)
        return
      }
      if (path === "/v0/stats") {
        const snapshot = await readRelaySnapshot(opts.discover).catch(() => null)
        if (!snapshot) throw new ApiError(502, "stats")
        sendJson(res, 200, snapshot)
        return
      }
      if (path === "/v0/peers") {
        const found = await discoverRelays(opts.discover, { pinned: opts.discoverId }).catch(() => null)
        if (!found) throw new ApiError(502, "peers")
        sendJson(res, 200, {
          relays: found.map((relay) => ({ id: relay.id, host: relay.endpoint.host, port: relay.endpoint.port })),
        })
        return
      }
      throw new ApiError(404, "not_found")
    }

    admit(limiter.admitTransfer(ip))
    limiter.hold(ip)
    try {
      const declared = declaredLength(req)
      if (declared !== null && declared > maxBytes) throw new ApiError(413, "size")
      if (declared !== null) admit(limiter.bytesFit(ip, declared))
      const side = path === "/v0/send" ? "send" : "receive"
      const deadlineMs = headerInt(req, "x-tesera-deadline-ms", DEFAULT_DEADLINE_MS, 1_000, MAX_API_DEADLINE_MS)
      const deadlineAt = Date.now() + deadlineMs
      const session = readSession(req)
      const coding = readCoding(req)
      const payload = side === "send" ? await readBody(req, maxBytes) : await drain(req, maxBytes)
      if (side === "send" && payload.length === 0) throw new ApiError(400, "empty")
      if (side === "send") admit(limiter.addBytes(ip, payload.length))
      const { relays, seedDefault } = await resolveCallRelays(req, seedRelays)
      const outcome = await enter(sessionKey(session), {
        side,
        session,
        relays,
        relayKey: relayKey(relays),
        seedDefault,
        payload: side === "send" ? payload : null,
        deadlineAt,
        coding,
        abort: abortFrom(req, res),
      })
      if (res.writableEnded || res.destroyed) return
      if (side === "receive") {
        admit(limiter.addBytes(ip, outcome.bytes.length))
        writeCors(res, 200, {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
          "x-tesera-bytes": String(outcome.bytes.length),
          "x-tesera-relays": String(outcome.relays),
          "x-tesera-tesserae": String(outcome.tesserae),
          "x-tesera-retransmits": String(outcome.retransmits),
          "x-tesera-acks": String(outcome.acks),
        })
        res.end(outcome.bytes)
        return
      }
      sendJson(res, 200, {
        bytes: outcome.bytes.length,
        relays: outcome.relays,
        tesserae: outcome.tesserae,
        retransmits: outcome.retransmits,
        acks: outcome.acks,
      })
    } finally {
      limiter.release(ip)
    }
  }

  function enter(key: string, arrival: Arrival): Promise<Outcome> {
    const existing = slots.get(key)
    if (existing) {
      if (existing.settled || existing.running || existing.second || existing.first.side === arrival.side) {
        throw new ApiError(409, "in_use")
      }
      if (existing.first.relayKey !== arrival.relayKey) throw new ApiError(409, "relays")
      existing.second = arrival
      existing.running = true
      clearTimeout(existing.timer)
      watchAbort(existing, arrival)
      void run(existing).catch((err) => {
        existing.fail(err instanceof ApiError ? err : new ApiError(502, "transfer"))
      })
      return existing.result
    }
    if (slots.size >= maxPairs) throw new ApiError(503, "busy")

    let finish: (value: Outcome) => void = () => {}
    let reject: (err: ApiError) => void = () => {}
    const result = new Promise<Outcome>((resolve, rejectPromise) => {
      finish = resolve
      reject = rejectPromise
    })
    const slot: Slot = {
      key,
      first: arrival,
      second: null,
      running: false,
      settled: false,
      timer: setTimeout(() => {
        slot.fail(new ApiError(408, "timeout"))
      }, Math.max(1, arrival.deadlineAt - Date.now())),
      result,
      finish: (value) => {
        if (slot.settled) return
        slot.settled = true
        clearTimeout(slot.timer)
        slots.delete(key)
        finish(value)
      },
      fail: (err) => {
        if (slot.settled) return
        slot.settled = true
        clearTimeout(slot.timer)
        slots.delete(key)
        reject(err)
      },
      cancel: () => {},
    }
    slots.set(key, slot)
    watchAbort(slot, arrival)
    return result
  }

  function watchAbort(slot: Slot, arrival: Arrival): void {
    const stop = () => {
      if (slot.settled) return
      if (!slot.running) {
        slot.fail(new ApiError(499, "closed"))
        return
      }
      slot.cancel()
      slot.fail(new ApiError(502, "transfer"))
    }
    if (arrival.abort.aborted) stop()
    else arrival.abort.addEventListener("abort", stop, { once: true })
  }

  /** The default seed's confirmed relays, seed first. Reused briefly when `preferJoined` is on. */
  async function seedRelays(): Promise<Endpoint[]> {
    const now = Date.now()
    if (opts.preferJoined && seedCache && now - seedCache.at < SEED_RELAYS_MS) return seedCache.relays
    const found = await discoverRelays(opts.discover, { pinned: opts.discoverId ?? null })
    const relays = found.map((relay) => relay.endpoint)
    if (opts.preferJoined) seedCache = { at: now, relays }
    return relays
  }

  async function run(slot: Slot): Promise<void> {
    const send = slot.first.side === "send" ? slot.first : slot.second
    const receive = slot.first.side === "receive" ? slot.first : slot.second
    if (!send?.payload || !receive) throw new ApiError(502, "transfer")
    const deadlineAt = Math.min(send.deadlineAt, receive.deadlineAt)
    const left = deadlineAt - Date.now()
    if (left < 1) throw new ApiError(408, "timeout")
    const plan =
      opts.preferJoined && send.seedDefault ? preferJoined(send.relays) : { relays: send.relays, fallback: null }
    try {
      let outcome: Outcome
      try {
        const firstMs = plan.fallback ? Math.ceil(left / 2) : left
        outcome = await move(slot, send, receive, advertise, firstMs, plan.relays, pool)
      } catch (err) {
        const rest = deadlineAt - Date.now()
        if (!plan.fallback || slot.settled || err instanceof ApiError || rest < MIN_RETRY_MS) throw err
        const timedOut = asError(err).message === "transfer timed out"
        log("retry", { relays: plan.relays.length, reason: timedOut ? "timeout" : "transfer" })
        outcome = await move(slot, send, receive, advertise, rest, plan.fallback, pool)
      }
      if (slot.settled) return
      log("send", {
        bytes: outcome.bytes.length,
        relays: outcome.relays,
        tesserae: outcome.tesserae,
        retransmits: outcome.retransmits,
        acks: outcome.acks,
      })
      slot.finish(outcome)
    } catch (err) {
      if (slot.settled) return
      const timedOut = asError(err).message === "transfer timed out"
      throw timedOut ? new ApiError(408, "timeout") : err instanceof ApiError ? err : new ApiError(502, "transfer")
    }
  }
}

async function move(
  slot: Slot,
  send: Arrival,
  receive: Arrival,
  advertise: string,
  deadlineMs: number,
  relays: Endpoint[],
  pool: PortPool | null,
): Promise<Outcome> {
  const payload = send.payload
  if (!payload) throw new ApiError(502, "transfer")
  const bindHost = isLoopback(advertise) ? advertise : "0.0.0.0"
  const rx = await startOnPort(
    pool,
    (port) =>
      new TeseraReceiver({
        session: send.session,
        relays,
        bindHost,
        bindPort: port,
        nackAfterMs: receive.coding.nackAfterMs,
      }),
  )
  if (!rx) throw new ApiError(503, "busy")
  const receiver = rx.item
  let sender: TeseraSender | undefined
  let txPort: number | null = null
  slot.cancel = () => {
    sender?.fail(new Error("closed"))
    receiver.fail(new Error("closed"))
  }
  let readError: Error | null = null
  const reading = readAll(receiver).catch((err: unknown) => {
    readError = asError(err)
    return Buffer.alloc(0)
  })
  try {
    const boundRx = receiver.endpoint
    const tx = await startOnPort(
      pool,
      (port) =>
        new TeseraSender({
          session: send.session,
          relays,
          receiver: { host: advertise, port: boundRx.port },
          bindHost,
          bindPort: port,
          k: send.coding.k,
          n: send.coding.n,
          shardSize: send.coding.shardSize,
          window: send.coding.window,
          maxSends: send.coding.maxSends,
          retxAfterMs: send.coding.retxAfterMs,
          deadlineMs,
        }),
    )
    if (!tx) throw new ApiError(503, "busy")
    sender = tx.item
    txPort = tx.port
    const boundTx = sender.endpoint
    receiver.setSender({ host: advertise, port: boundTx.port })
    sender.onPeerFail = (err) => receiver.fail(err)
    receiver.onPeerFail = (err) => sender?.fail(err)
    await sender.write(payload)
    await sender.end()
    const output = await reading
    if (readError) throw readError
    if (!output.equals(payload)) throw new Error("transfer mismatch")
    return {
      bytes: output,
      relays: relays.length,
      tesserae: sender.stats.tesseraSends,
      retransmits: sender.stats.tesseraRetransmissions,
      acks: receiver.stats.acksSent,
    }
  } finally {
    slot.cancel = () => {}
    await sender?.close()
    await receiver.close()
    await reading.catch(() => {})
    if (pool && rx.port !== null) pool.release(rx.port)
    if (pool && txPort !== null) pool.release(txPort)
  }
}

async function readAll(receiver: TeseraReceiver): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for (;;) {
    const chunk = await receiver.read()
    if (!chunk) return concatBytes(chunks)
    chunks.push(chunk)
  }
}

function sessionKey(session: Buffer): string {
  return createHash("sha256").update(session).digest("hex")
}

function relayKey(relays: Endpoint[]): string {
  return relays.map((relay) => `${relay.host}:${relay.port}`).sort().join(",")
}

function readSession(req: IncomingMessage): Buffer {
  try {
    return parseSession(headerText(req, "x-tesera-session") ?? "")
  } catch {
    throw new ApiError(400, "session")
  }
}

function readCoding(req: IncomingMessage): Coding {
  const k = headerInt(req, "x-tesera-k", 2, 1, 32)
  const n = headerInt(req, "x-tesera-n", 3, 1, 32)
  const shardSize = headerInt(req, "x-tesera-shard", DEFAULT_SHARD, 1, MAX_SHARD)
  const window = headerInt(req, "x-tesera-window", DEFAULT_WINDOW, 1, MAX_AHEAD)
  const maxSends = headerInt(req, "x-tesera-max-sends", DEFAULT_MAX_SENDS, 1, 100)
  const retxAfterMs = headerInt(req, "x-tesera-retx-after-ms", DEFAULT_RETX_AFTER_MS, 1, 60_000)
  const nackAfterMs = headerInt(req, "x-tesera-nack-after-ms", DEFAULT_NACK_AFTER_MS, 1, 60_000)
  try {
    assertCode(k, n)
    assertShardSize(shardSize)
  } catch {
    throw new ApiError(400, "option")
  }
  return { k, n, shardSize, window, maxSends, retxAfterMs, nackAfterMs }
}

async function resolveCallRelays(
  req: IncomingMessage,
  seedRelays: () => Promise<Endpoint[]>,
): Promise<{ relays: Endpoint[]; seedDefault: boolean }> {
  const listed = headerText(req, "x-tesera-relays")
  const discover = headerText(req, "x-tesera-discover")
  if (listed !== undefined && discover !== undefined) throw new ApiError(400, "option")
  try {
    if (listed !== undefined) return { relays: await listedRelays(listed), seedDefault: false }
    if (discover === undefined) {
      const relays = await seedRelays()
      if (relays.length < 1) throw new ApiError(400, "relays")
      return { relays, seedDefault: true }
    }
    const ref = await resolveRelayRef(discover)
    const found = await discoverRelays(ref.endpoint, { pinned: ref.id })
    if (found.length < 1) throw new ApiError(400, "relays")
    return { relays: found.map((relay) => relay.endpoint), seedDefault: false }
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError(400, "relays")
  }
}

async function listedRelays(value: string): Promise<Endpoint[]> {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length < 1) throw new ApiError(400, "relays")
  const refs = await Promise.all(parts.map((part) => resolveRelayRef(part)))
  await Promise.all(refs.flatMap((ref) => (ref.id === null ? [] : [confirmRelay(ref.endpoint, ref.id)])))
  return refs.map((ref) => ref.endpoint)
}

function headerText(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (value === undefined) return undefined
  if (Array.isArray(value)) throw new ApiError(400, "option")
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new ApiError(400, "option")
  return trimmed
}

function headerInt(req: IncomingMessage, name: string, fallback: number, min: number, max: number): number {
  const text = headerText(req, name)
  if (text === undefined) return fallback
  if (!/^\d+$/.test(text)) throw new ApiError(400, "option")
  const parsed = Number(text)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new ApiError(400, "option")
  return parsed
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0)
  if (Number.isFinite(declared) && declared > max) {
    req.pause()
    return Promise.reject(new ApiError(413, "size"))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on("data", (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > max) {
        failed = true
        req.pause()
        reject(new ApiError(413, "size"))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks))
    })
    req.on("error", (err) => {
      if (!failed) reject(asError(err))
    })
  })
}

async function drain(req: IncomingMessage, max: number): Promise<Buffer> {
  if (req.method === "GET" || req.method === "HEAD") return Buffer.alloc(0)
  await readBody(req, max)
  return Buffer.alloc(0)
}

function abortFrom(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  const stop = () => {
    if (!res.writableFinished) controller.abort()
  }
  res.on("close", stop)
  req.on("aborted", stop)
  return controller.signal
}

function note(log: (event: string, fields: LogFields) => void, err: ApiError): void {
  if (err.logged || err.code === "closed") return
  err.logged = true
  log(err.status >= 500 ? "error" : "reject", { reason: err.code })
}

function writeCors(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": EXPOSE_HEADERS,
    ...headers,
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  writeCors(res, status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  })
  res.end(JSON.stringify(body))
}

function publicIndex(): {
  name: string
  software: string
  wire: number
  endpoints: { send: string; receive: string; record: string; stats: string; peers: string }
  docs: string
} {
  return {
    name: "tesera public api",
    software: SOFTWARE_VERSION,
    wire: PROTOCOL_VERSION,
    endpoints: {
      send: "POST /v0/send",
      receive: "POST /v0/receive",
      record: "GET /v0/record",
      stats: "GET /v0/stats",
      peers: "GET /v0/peers",
    },
    docs: DOCS_URL,
  }
}

type Route = { kind: "info" | "transfer"; methods: Set<string> }

function routeOf(path: string | undefined): Route | null {
  if (path === "/" || path === "/v0/record" || path === "/v0/stats" || path === "/v0/peers") {
    return { kind: "info", methods: new Set(["GET"]) }
  }
  if (path === "/v0/send" || path === "/v0/receive") return { kind: "transfer", methods: new Set(["POST"]) }
  return null
}

function admit(result: LimitResult): void {
  if (!result.ok) throw new ApiError(429, "rate_limit", result.retryAfterSec)
}

function retryHeader(err: ApiError): Record<string, string> {
  if (!err.retryAfterSec) return {}
  return { "retry-after": String(err.retryAfterSec) }
}

function forwardedFor(req: IncomingMessage): string | undefined {
  const value = req.headers["x-forwarded-for"]
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.join(", ") : value
}

function declaredLength(req: IncomingMessage): number | null {
  const raw = req.headers["content-length"]
  if (raw === undefined) return null
  const text = Array.isArray(raw) ? raw[0] : raw
  if (!text || !/^\d+$/.test(text)) return null
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed)) return null
  return parsed
}
