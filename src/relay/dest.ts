import { normalizeHost } from "../carrier/udp.js"

export type Cidr = { base: number; mask: number }

/** Ranges a public relay does not forward into unless `--allow-dest` names them. */
export const DENIED_DESTINATIONS: readonly string[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
]

const DENIED = DENIED_DESTINATIONS.map(parseCidr)

export function parseCidr(value: string): Cidr {
  const slash = value.lastIndexOf("/")
  if (slash <= 0) throw new Error(`invalid CIDR ${value}`)
  const prefix = Number(value.slice(slash + 1))
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`invalid CIDR ${value}`)
  const ip = ipv4ToInt(normalizeHost(value.slice(0, slash)))
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return { base: (ip & mask) >>> 0, mask }
}

/** True when a forwarded packet may be sent to this IPv4 address. */
export function destinationAllowed(host: string, allow: readonly Cidr[]): boolean {
  const ip = ipv4ToInt(normalizeHost(host))
  if (allow.some((cidr) => matches(ip, cidr))) return true
  return !DENIED.some((cidr) => matches(ip, cidr))
}

function ipv4ToInt(host: string): number {
  const parts = host.split(".").map((part) => Number(part))
  return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0
}

function matches(ip: number, cidr: Cidr): boolean {
  return ((ip & cidr.mask) >>> 0) === cidr.base
}
