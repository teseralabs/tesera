// The public HTTP API: the control plane, under /v1.
//
// Discovery lists relays and their transports. Rooms hold one offer and one answer, so 2 endpoints
// can find each other. Neither sees a session secret, a key, or a byte of a transfer.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Endpoint } from "../carrier/udp.js"
import { PROTOCOL_VERSION } from "../constants.js"
import { ApiLimiter, DEFAULT_API_LIMITS, clientAddress, trustedProxies, type ApiLimitConfig, type LimitResult } from "./limit.js"
import { SOFTWARE_VERSION } from "../identity/record.js"
import type { LogFields } from "../log.js"
import type { Discovery } from "../control/discovery.js"
import { MAX_DOCUMENT_BYTES, Rendezvous, RendezvousError } from "../control/rendezvous.js"

/** Time allowed to receive request headers. */
export const API_HEADERS_TIMEOUT_MS = 10_000
/** Time allowed to receive a complete request, including a slow body. */
export const API_REQUEST_TIMEOUT_MS = 60_000
export const API_KEEPALIVE_TIMEOUT_MS = 5_000
export const API_MAX_HEADER_BYTES = 16 * 1024
const DOCS_URL = "https://tesera.net/docs#api"
/** A room request body: one offer or answer, with room for whitespace. */
const MAX_ROOM_BODY = 2 * MAX_DOCUMENT_BYTES
const ROOM_SWEEP_MS = 30_000

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
  /** Serves GET /v1/relays. Unset leaves the route out. */
  discovery?: Discovery
  /** The rooms. Defaults to a new in-memory store. */
  rendezvous?: Rendezvous
  /** Socket addresses allowed to supply the client through X-Forwarded-For. */
  trustProxy?: readonly string[]
  limits?: Partial<ApiLimitConfig>
  log?: (event: string, fields: LogFields) => void
}

export type PublicApi = {
  endpoint: Endpoint
  close: () => Promise<void>
}

const ALLOW_HEADERS = "content-type, authorization"

export async function listenPublicApi(host: string, port: number, opts: PublicApiOptions = {}): Promise<PublicApi> {
  const log = opts.log ?? (() => {})
  const trusted = trustedProxies(opts.trustProxy ?? [])
  const limiter = new ApiLimiter({ ...DEFAULT_API_LIMITS, ...opts.limits })
  const rooms = opts.rendezvous ?? new Rendezvous()
  const sweep = setInterval(() => rooms.sweep(), ROOM_SWEEP_MS)
  sweep.unref()
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
      clearInterval(sweep)
      rooms.clear()
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
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
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
    admit(limiter.admitInfo(ip))
    if (route.kind === "index") {
      sendJson(res, 200, publicIndex())
      return
    }
    if (route.kind === "relays") {
      if (!opts.discovery) throw new ApiError(404, "not_found")
      sendJson(res, 200, opts.discovery.document())
      return
    }
    await room(req, res, route, ip)
  }

  /** The room routes. The room id and token never go in a log line. */
  async function room(req: IncomingMessage, res: ServerResponse, route: Route, ip: string): Promise<void> {
    const { room, answer } = route
    try {
      if (!room) {
        const text = await readText(req)
        admit(limiter.admitCreate(ip))
        const created = rooms.create(text)
        log("rendezvous", { step: "open", rooms: rooms.size })
        sendJson(res, 201, { room: created.room, token: created.token, expiresAt: Math.floor(created.expiresAt / 1000) })
        return
      }
      if (!answer && req.method === "GET") {
        sendDocument(res, 200, rooms.offer(room).offer)
        return
      }
      if (!answer && req.method === "DELETE") {
        rooms.close(room, bearer(req))
        log("rendezvous", { step: "close", rooms: rooms.size })
        writeCors(res, 204)
        res.end()
        return
      }
      if (req.method === "POST") {
        rooms.answer(room, await readText(req))
        log("rendezvous", { step: "answer" })
        writeCors(res, 204)
        res.end()
        return
      }
      const waitMs = waitParam(req.url)
      const found = await rooms.waitAnswer(room, bearer(req), waitMs, abortFrom(req, res))
      if (res.writableEnded || res.destroyed) return
      if (found !== null) {
        sendDocument(res, 200, found)
        return
      }
      // An empty wait: either no answer yet, or the room went away while waiting.
      await rooms.waitAnswer(room, bearer(req), 0)
      writeCors(res, 204, { "cache-control": "no-store" })
      res.end()
    } catch (err) {
      if (err instanceof RendezvousError) throw new ApiError(err.status, err.code)
      throw err
    }
  }
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
  endpoints: Record<string, string>
  docs: string
} {
  return {
    name: "tesera control plane",
    software: SOFTWARE_VERSION,
    wire: PROTOCOL_VERSION,
    endpoints: {
      relays: "GET /v1/relays",
      rooms: "POST /v1/rooms",
    },
    docs: DOCS_URL,
  }
}

type Route = {
  kind: "index" | "relays" | "rooms"
  methods: Set<string>
  room?: string
  answer?: boolean
}

function routeOf(path: string | undefined): Route | null {
  if (path === "/") return { kind: "index", methods: new Set(["GET"]) }
  if (path === "/v1/relays") return { kind: "relays", methods: new Set(["GET"]) }
  if (path === "/v1/rooms") return { kind: "rooms", methods: new Set(["POST"]) }
  const room = /^\/v1\/rooms\/([^/]+)(\/answer)?$/.exec(path ?? "")
  if (room) {
    const answer = room[2] !== undefined
    return { kind: "rooms", methods: new Set(answer ? ["GET", "POST"] : ["GET", "DELETE"]), room: room[1], answer }
  }
  return null
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
      if (!failed) reject(err)
    })
  })
}

async function readText(req: IncomingMessage): Promise<string> {
  const body = await readBody(req, MAX_ROOM_BODY)
  const text = body.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(body)) throw new ApiError(400, "document")
  return text
}

function headerText(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (value === undefined) return undefined
  if (Array.isArray(value)) throw new ApiError(400, "option")
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new ApiError(400, "option")
  return trimmed
}

function bearer(req: IncomingMessage): string {
  const match = /^Bearer ([A-Za-z0-9_-]{1,64})$/.exec(headerText(req, "authorization") ?? "")
  if (!match?.[1]) throw new ApiError(401, "token")
  return match[1]
}

/** `?wait=SECONDS`, 0 when absent. The store caps it. */
function waitParam(url: string | undefined): number {
  const value = new URLSearchParams(url?.split("?")[1] ?? "").get("wait")
  if (value === null) return 0
  if (!/^\d{1,3}$/.test(value)) throw new ApiError(400, "option")
  return Number(value) * 1000
}

/** A stored offer or answer, as the exact text the endpoint sent. */
function sendDocument(res: ServerResponse, status: number, text: string): void {
  writeCors(res, status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(text)
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
