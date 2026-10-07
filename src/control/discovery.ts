// What a client needs to reach the network: relays, and the transports each one serves.
// UDP relays come from the seed's table, each confirmed by a handshake with its identity key.
// A WebTransport entry comes from the operator's configuration (the relay id and its public URL)
// joined with a statement the relay signed (its certificate hashes and attach version).
// The control plane lists only what it has checked. It holds no session state and sees no transfer.

import { readFile } from "node:fs/promises"
import { verifyStatement, type PinnedCertificate, type TransportStatement } from "../attach/statement.js"
import { parseId } from "../identity/id.js"
import type { IntroducedRelay } from "../identity/peers.js"
import { asError } from "../util.js"

export const DISCOVERY_VERSION = 1
/** How often statements and the seed table are fetched again. */
export const DISCOVERY_REFRESH_MS = 60_000
/** The longest a client should keep a discovery document before asking again. */
export const DISCOVERY_MAX_AGE_SEC = 300
const MAX_ENTRIES = 64
const FETCH_TIMEOUT_MS = 5_000
const MAX_STATEMENT_RESPONSE_BYTES = 16 * 1024

/** One attachment relay to list, from the operator's --entries file. */
export type EntryConfig = {
  /** The relay's id. Its statement must verify against this key. */
  relay: string
  /** The public origin a client opens, such as https://edge.example:4433. */
  url: string
  /** Where the control plane reads the relay's signed statements: its relay API's /v1/transports. */
  statement: string
}

export type UdpTransport = { type: "udp"; host: string; port: number }
export type WebTransportTransport = {
  type: "webtransport"
  url: string
  attach: number
  /** Empty when the listener has a certificate from a public authority and needs no pin. */
  certificateHashes: PinnedCertificate[]
}
export type ListedTransport = UdpTransport | WebTransportTransport

export type ListedRelay = { id: string; transports: ListedTransport[] }

export type DiscoveryDocument = {
  v: typeof DISCOVERY_VERSION
  /** Unix seconds after which a client asks again. */
  expiresAt: number
  relays: ListedRelay[]
}

export type DiscoveryOptions = {
  entries: EntryConfig[]
  /** The seed's confirmed relays, for UDP. */
  udpRelays?: () => Promise<IntroducedRelay[]>
  /** Reads one statement URL. Defaults to an HTTP GET with a timeout and a size cap. */
  fetchJson?: (url: string) => Promise<unknown>
  refreshMs?: number
  now?: () => number
  /** A failed refresh: `statement` for an entry, `seed` for the seed's table. */
  log?: (reason: "statement" | "seed", fields: Record<string, string>) => void
}

/** Parse the operator's entries file: `{"entries":[{"relay","url","statement"}]}`. */
export function parseEntries(text: string): EntryConfig[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("entries file is not JSON")
  }
  const list = (parsed as { entries?: unknown } | null)?.entries
  if (!Array.isArray(list)) throw new Error('entries file needs an "entries" list')
  if (list.length > MAX_ENTRIES) throw new Error(`entries file lists more than ${MAX_ENTRIES} entries`)
  return list.map((value, i) => {
    const entry = (value ?? {}) as Record<string, unknown>
    const { relay, url, statement } = entry
    if (typeof relay !== "string") throw new Error(`entry ${i} needs a relay id`)
    try {
      parseId(relay)
    } catch (err) {
      throw new Error(`entry ${i}: ${asError(err).message}`)
    }
    if (typeof url !== "string" || !isOrigin(url, "https:")) throw new Error(`entry ${i} needs an https url with no path`)
    if (typeof statement !== "string" || !isUrl(statement)) throw new Error(`entry ${i} needs a statement url`)
    return { relay: relay.trim().toLowerCase(), url: url.replace(/\/$/, ""), statement }
  })
}

export async function readEntries(file: string): Promise<EntryConfig[]> {
  return parseEntries(await readFile(file, "utf8"))
}

/**
 * The discovery document, kept fresh in the background. A statement that can't be fetched keeps
 * its last verified copy until that copy expires; after that the entry is left out rather than
 * listed with hashes nobody has checked.
 */
export class Discovery {
  private readonly statements = new Map<string, TransportStatement>()
  private udp: IntroducedRelay[] = []
  private timer: NodeJS.Timeout | null = null
  private readonly now: () => number
  private readonly fetchJson: (url: string) => Promise<unknown>
  private readonly log: NonNullable<DiscoveryOptions["log"]>

  constructor(private readonly opts: DiscoveryOptions) {
    this.now = opts.now ?? Date.now
    this.fetchJson = opts.fetchJson ?? fetchJson
    this.log = opts.log ?? (() => {})
  }

  /** Fetch once, then keep refreshing until `stop`. */
  async start(): Promise<void> {
    await this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.opts.refreshMs ?? DISCOVERY_REFRESH_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async refresh(): Promise<void> {
    await Promise.all([
      ...this.opts.entries.map(async (entry) => {
        const found = await this.readStatement(entry).catch(() => {
          this.log("statement", { relay: entry.relay })
          return null
        })
        if (found) this.statements.set(entry.relay, found)
      }),
      (async () => {
        if (!this.opts.udpRelays) return
        try {
          this.udp = await this.opts.udpRelays()
        } catch {
          this.log("seed", {})
        }
      })(),
    ])
  }

  document(): DiscoveryDocument {
    const nowSec = Math.floor(this.now() / 1000)
    const relays = new Map<string, ListedRelay>()
    const listed = (id: string) => {
      let relay = relays.get(id)
      if (!relay) relays.set(id, (relay = { id, transports: [] }))
      return relay
    }
    let expiresAt = nowSec + DISCOVERY_MAX_AGE_SEC
    for (const entry of this.opts.entries) {
      const statement = this.current(entry.relay, nowSec)
      if (!statement) continue
      listed(entry.relay).transports.push({
        type: "webtransport",
        url: entry.url,
        attach: statement.attach,
        certificateHashes: statement.certificates,
      })
      expiresAt = Math.min(expiresAt, statement.expiresAt, ...statement.certificates.map((c) => c.notAfter))
    }
    for (const relay of this.udp) {
      listed(relay.id).transports.push({ type: "udp", host: relay.endpoint.host, port: relay.endpoint.port })
    }
    return { v: DISCOVERY_VERSION, expiresAt, relays: [...relays.values()] }
  }

  /** The last verified statement for `relay`, re-checked against the clock. */
  private current(relay: string, nowSec: number): TransportStatement | null {
    const statement = this.statements.get(relay)
    if (!statement) return null
    const certificates = statement.certificates.filter((cert) => cert.notAfter > nowSec)
    if (statement.expiresAt <= nowSec || (statement.certificates.length > 0 && certificates.length === 0)) {
      this.statements.delete(relay)
      return null
    }
    return { ...statement, certificates }
  }

  private async readStatement(entry: EntryConfig): Promise<TransportStatement | null> {
    const body = (await this.fetchJson(entry.statement)) as { statements?: unknown } | null
    const list = Array.isArray(body?.statements) ? body.statements : []
    const nowSec = Math.floor(this.now() / 1000)
    for (const doc of list) {
      const statement = verifyStatement(doc, entry.relay, nowSec)
      if (statement?.type === "webtransport") return statement
    }
    throw new Error("no valid statement")
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" })
  if (!response.ok) throw new Error(`statement fetch returned ${response.status}`)
  const text = await response.text()
  if (text.length > MAX_STATEMENT_RESPONSE_BYTES) throw new Error("statement response too large")
  return JSON.parse(text)
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function isOrigin(value: string, protocol: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === protocol && (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash
  } catch {
    return false
  }
}
