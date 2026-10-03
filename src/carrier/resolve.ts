import { lookup } from "node:dns/promises"
import { formatId, parseId, ID_PREFIX, type RelayRef } from "../identity/id.js"
import { normalizeEndpoint, normalizeHost, type Endpoint } from "./udp.js"

/** Port used when a relay address is only a name or an IPv4 address. */
export const DEFAULT_RELAY_PORT = 4101

export type HostLookup = (host: string) => Promise<string>

/** Look up one A record. An IPv4 address is returned as itself. */
export async function resolveEndpoint(
  value: string,
  defaultPort?: number,
  lookupHost: HostLookup = lookupIPv4,
): Promise<Endpoint> {
  const { host, port } = splitHostPort(value, defaultPort)
  return normalizeEndpoint(await resolveHost(host, lookupHost), port)
}

/** `host`, `host:port`, or `relay:ID@host` with the same port rule. */
export async function resolveRelayRef(
  value: string,
  lookupHost?: HostLookup,
): Promise<RelayRef> {
  const { id, host, port } = splitRelayRef(value)
  return { id, endpoint: await resolveEndpoint(`${host}:${port}`, DEFAULT_RELAY_PORT, lookupHost) }
}

/** Check a relay reference without a DNS lookup. */
export function splitRelayRef(value: string): { id: string | null; host: string; port: number } {
  const trimmed = value.trim()
  const at = trimmed.indexOf("@")
  if (at === -1) return { id: null, ...splitHostPort(trimmed, DEFAULT_RELAY_PORT) }
  const idText = trimmed.slice(0, at)
  const endpointText = trimmed.slice(at + 1)
  if (!idText.toLowerCase().startsWith(ID_PREFIX) || endpointText.length === 0) {
    throw new Error(`expected host:port, a domain name, or relay:ID@host, got ${trimmed}`)
  }
  return { id: formatId(parseId(idText)), ...splitHostPort(endpointText, DEFAULT_RELAY_PORT) }
}

async function resolveHost(host: string, lookupHost: HostLookup): Promise<string> {
  if (host === "localhost") return "127.0.0.1"
  if (isIPv4(host)) return normalizeHost(host)
  try {
    return normalizeHost(await lookupHost(host))
  } catch (err) {
    if (isDnsMiss(err)) throw new Error(`${host} has no IPv4 address`)
    throw err
  }
}

async function lookupIPv4(host: string): Promise<string> {
  const found = await lookup(host, { family: 4 })
  return found.address
}

function splitHostPort(value: string, defaultPort?: number): { host: string; port: number } {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error("expected host:port or a domain name")
  const colon = trimmed.lastIndexOf(":")
  if (colon === -1) {
    if (defaultPort === undefined) throw new Error(`expected host:port, got ${trimmed}`)
    return { host: trimmed, port: defaultPort }
  }
  const host = trimmed.slice(0, colon)
  const port = Number(trimmed.slice(colon + 1))
  if (host.length === 0 || !Number.isInteger(port)) throw new Error(`expected host:port, got ${trimmed}`)
  return { host, port }
}

function isIPv4(host: string): boolean {
  const parts = host.split(".")
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (!/^[0-9]+$/.test(part)) return false
    const octet = Number(part)
    return octet >= 0 && octet <= 255
  })
}

function isDnsMiss(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false
  const code = (err as { code: unknown }).code
  return code === "ENOTFOUND" || code === "ENODATA" || code === "EAI_AGAIN" || code === "ESERVFAIL"
}
