import { createServer, type Server, type ServerResponse } from "node:http"
import type { Endpoint } from "../carrier/udp.js"
import type { RecordDocument } from "../identity/record.js"
import type { RelaySnapshot } from "../identity/stats.js"

/** This process only. These numbers restart with the relay. */
export type RelayReport = {
  uptimeMs: number
  forwarded: number
  bytes: number
  data: number
  acks: number
  nacks: number
  duplicates: number
  denied: number
  invalid: number
  limited: number
}

/** One relay this seed knows. `seen` is milliseconds since the epoch. */
export type ListedRelay = {
  id: string
  host: string
  port: number
  online: boolean
  seen: number
  bytes: number
  transfers: number
}

export type RelayDirectory = {
  relays: ListedRelay[]
}

export async function listenRelayApi(
  host: string,
  port: number,
  read: {
    stats: () => RelaySnapshot
    relay: () => RelayReport
    peers: () => RelayDirectory
    record?: () => RecordDocument | null
  },
): Promise<{ server: Server; endpoint: Endpoint }> {
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0]
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method" })
      return
    }
    if (path === "/v0/record") {
      try {
        const doc = read.record?.() ?? null
        if (!doc) sendJson(res, 404, { error: "not_found" })
        else sendJson(res, 200, doc)
      } catch {
        sendJson(res, 500, { error: "unavailable" })
      }
      return
    }
    const body = path === "/v0/stats" ? read.stats : path === "/v0/relay" ? read.relay : path === "/v0/peers" ? read.peers : null
    if (!body) {
      sendJson(res, 404, { error: "not_found" })
      return
    }
    try {
      sendJson(res, 200, body())
    } catch {
      sendJson(res, 500, { error: "unavailable" })
    }
  })
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
  return { server, endpoint: { host: address.address, port: address.port } }
}

export function closeRelayApi(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  })
  res.end(JSON.stringify(body))
}
