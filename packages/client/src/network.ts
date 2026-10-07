import type { ControlPlane } from "./control.js"
import { ATTACH_VERSION } from "./core.js"
import { asTeseraError, TeseraError } from "./errors.js"
import { sameEndpoint } from "./client.js"
import type { ClientTransport, Endpoint, TransportConnection, TransportEvents } from "./transport.js"
import { webTransport, type WebTransportConstructor } from "./webtransport/transport.js"

export const DISCOVERY_VERSION = 1
const MAX_RELAYS = 256
const MAX_TRANSPORTS = 16
const MAX_HASHES = 8
/** A directory is reused for at most this long, whatever it says. */
const MAX_DIRECTORY_AGE_MS = 5 * 60 * 1000

/** How a discovery transport reads its directory fresh, so a share can reuse that read for its relays. */
const readers = new WeakMap<ClientTransport, { control: ControlPlane; read: (signal?: AbortSignal) => Promise<NetworkDirectory> }>()

/** A fresh directory read through `transport`'s own cache, when it is a discovery transport on `control`. */
export function freshDirectoryVia(transport: ClientTransport, control: ControlPlane): ((signal?: AbortSignal) => Promise<NetworkDirectory>) | null {
  const reader = readers.get(transport)
  return reader && reader.control === control ? reader.read : null
}

/** A relay's WebTransport attachment listener, as discovery lists it. */
export type WebTransportEntry = {
  url: string
  attach: number
  /** Hex SHA-256 digests to pin, unexpired. Empty for a certificate from a public authority. */
  certificateHashes: string[]
}

/** One relay and the transports this client can use to reach it. */
export type NetworkRelay = {
  id: string
  /** Where a transfer's tesserae are sent, when the relay carries UDP paths. */
  udp: Endpoint | null
  webTransport: WebTransportEntry | null
}

export type NetworkDirectory = {
  /** Unix seconds after which the directory should be fetched again. */
  expiresAt: number
  relays: NetworkRelay[]
}

/**
 * Read a discovery document. Unknown fields and transport types are ignored, so a newer control
 * plane can add them; a relay entry or transport that is malformed, expired, or for an attach
 * version this client doesn't speak is left out. Only a different document version is an error.
 */
export function parseDirectory(value: unknown, nowSec = Math.floor(Date.now() / 1000)): NetworkDirectory {
  const doc = object(value)
  if (!doc) throw new TeseraError("control", "the discovery document is not an object", { reason: "malformed" })
  if (doc["v"] !== DISCOVERY_VERSION) {
    throw new TeseraError("incompatible", `this client reads discovery version ${DISCOVERY_VERSION}, got ${String(doc["v"])}`)
  }
  const expiresAt = typeof doc["expiresAt"] === "number" && Number.isFinite(doc["expiresAt"]) ? doc["expiresAt"] : nowSec
  const list = Array.isArray(doc["relays"]) ? doc["relays"].slice(0, MAX_RELAYS) : []
  const relays: NetworkRelay[] = []
  for (const item of list) {
    const relay = object(item)
    const id = relay?.["id"]
    if (!relay || typeof id !== "string" || !id.startsWith("relay:")) continue
    const transports = Array.isArray(relay["transports"]) ? relay["transports"].slice(0, MAX_TRANSPORTS) : []
    let udp: Endpoint | null = null
    let wt: WebTransportEntry | null = null
    for (const t of transports) {
      const transport = object(t)
      if (!transport) continue
      if (transport["type"] === "udp" && !udp) udp = udpOf(transport)
      else if (transport["type"] === "webtransport" && !wt) wt = webTransportOf(transport, nowSec)
    }
    if (udp || wt) relays.push({ id, udp, webTransport: wt })
  }
  return { expiresAt, relays }
}

/** The UDP relays in a directory, in the order the control plane listed them. */
export function udpRelays(directory: NetworkDirectory): Endpoint[] {
  return directory.relays.flatMap((relay) => (relay.udp ? [relay.udp] : []))
}

/**
 * The relays a share codes its transfer across: listed UDP relays that are not browser entries
 * first, then entries' UDP addresses, each in listed order. An attachment relay a browser attaches
 * through stops that browser's transfer when it fails, so it is a path only when too few others are
 * listed. This is not a ranking: nothing here measures relays or knows their operators or networks.
 */
export function codedPaths(directory: NetworkDirectory, count: number): Endpoint[] {
  const udp = directory.relays.filter((relay) => relay.udp)
  const ordered = [...udp.filter((relay) => !relay.webTransport), ...udp.filter((relay) => relay.webTransport)]
  return ordered.slice(0, count).flatMap((relay) => (relay.udp ? [relay.udp] : []))
}

export type DiscoveryTransportOptions = {
  /** A WebTransport implementation for runtimes without a global one. */
  WebTransport?: WebTransportConstructor
  connectTimeoutMs?: number
  keepaliveMs?: number
}

/**
 * A client transport that finds its entry point through discovery. It tries the listed
 * WebTransport entries in the order given. If none connects, it fetches discovery once more, in
 * case a certificate rotated or a relay left, and tries again. It does not rank or measure entries.
 */
export function discoveryTransport(control: ControlPlane, opts: DiscoveryTransportOptions = {}): ClientTransport {
  let cached: { directory: NetworkDirectory; until: number } | null = null
  const directory = async (fresh: boolean, signal?: AbortSignal) => {
    if (!fresh && cached && Date.now() < cached.until) return cached.directory
    const parsed = parseDirectory(await control.discover(signal))
    cached = { directory: parsed, until: Math.min(parsed.expiresAt * 1000, Date.now() + MAX_DIRECTORY_AGE_MS) }
    return parsed
  }
  const attempt = async (dir: NetworkDirectory, events: TransportEvents, signal?: AbortSignal, avoid: Endpoint[] = []) => {
    let last: TeseraError | null = null
    for (const relay of dir.relays) {
      const entry = relay.webTransport
      if (!entry) continue
      const transport = webTransport({
        url: entry.url,
        certificateHash: entry.certificateHashes,
        ...(opts.WebTransport ? { WebTransport: opts.WebTransport } : {}),
        ...(opts.connectTimeoutMs ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
        ...(opts.keepaliveMs ? { keepaliveMs: opts.keepaliveMs } : {}),
      })
      // An entry whose UDP address is one to avoid is the same relay; skip it without connecting.
      if (relay.udp && avoid.some((at) => sameEndpoint(at, relay.udp!))) continue
      try {
        const connection = await transport.connect(events, signal)
        if (!avoid.some((at) => sameEndpoint(at, connection.endpoint))) return { connection, last }
        await connection.close().catch(() => {})
        last = new TeseraError("path", "the only reachable entry is one this connection was asked to avoid")
      } catch (err) {
        const failure = asTeseraError(err, "connection")
        if (failure.code === "cancelled" || failure.code === "unsupported") throw failure
        last = failure
      }
    }
    return { connection: null, last }
  }
  const transport: ClientTransport = {
    name: "webtransport",
    async connect(events, signal, hints): Promise<TransportConnection> {
      let tried = await attempt(await directory(false, signal), events, signal, hints?.avoid)
      if (tried.connection) return tried.connection
      tried = await attempt(await directory(true, signal), events, signal, hints?.avoid)
      if (tried.connection) return tried.connection
      if (tried.last) throw tried.last
      if (hints?.avoid?.length) throw new TeseraError("path", "discovery lists no WebTransport entry other than the ones to avoid")
      throw new TeseraError("connection", "discovery lists no WebTransport entry this client can use")
    },
  }
  readers.set(transport, { control, read: (signal) => directory(true, signal) })
  return transport
}

function udpOf(t: Record<string, unknown>): Endpoint | null {
  const { host, port } = t
  if (typeof host !== "string" || host.length === 0) return null
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

function webTransportOf(t: Record<string, unknown>, nowSec: number): WebTransportEntry | null {
  const { url, attach, certificateHashes } = t
  if (typeof url !== "string" || !url.startsWith("https://")) return null
  if (attach !== ATTACH_VERSION) return null
  if (!Array.isArray(certificateHashes)) return null
  const listed = certificateHashes.slice(0, MAX_HASHES)
  const hashes: string[] = []
  for (const item of listed) {
    const cert = object(item)
    const sha256 = cert?.["sha256"]
    const notAfter = cert?.["notAfter"]
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || typeof notAfter !== "number") continue
    if (notAfter > nowSec) hashes.push(sha256)
  }
  // Pins that have all expired don't mean the listener needs none.
  if (listed.length > 0 && hashes.length === 0) return null
  return { url, attach, certificateHashes: hashes }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
