import type { Endpoint } from "../carrier/transport.js"

/**
 * Attach framing, version 1. See notes/attach.md. This is the only thing an endpoint that cannot
 * speak UDP, such as a browser, adds around an ordinary tesera datagram to reach a relay and, through
 * that relay, one more UDP relay. The bytes inside the framing are exactly the datagrams a native
 * endpoint sends and receives: the UDP wire format does not change.
 *
 * control, on a bidirectional stream the endpoint opens, one request then one reply:
 *   version u8 | kind u8 | body
 *   HELLO request has no body; its reply body is the attachment address, IPv4 4 | port u16
 *   CLAIM request body is a 16-byte session id; its reply body is one status byte
 * datagram, one per transport datagram, either way:
 *   version u8 | IPv4 4 | port u16 | tesera datagram
 * From the endpoint the address is where the datagram goes. From the relay it is where it came from.
 */
export const ATTACH_VERSION = 1
/** The path carries the version, so a relay can refuse a version it does not speak at connect time. */
export const ATTACH_PATH = `/tesera/attach/${ATTACH_VERSION}`
/** version u8 | IPv4 4 | port u16 */
export const FRAME_HEADER_LEN = 7

export const HELLO = 1
export const CLAIM = 2

export const CLAIM_OK = 0
export const CLAIM_TAKEN = 1
export const CLAIM_FULL = 2

export type Control = { kind: number; body: Uint8Array }
export type Frame = { address: Endpoint; packet: Uint8Array }

export function encodeControl(kind: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(2 + body.length)
  out[0] = ATTACH_VERSION
  out[1] = kind
  out.set(body, 2)
  return out
}

/** Null for anything that isn't a version 1 control message. */
export function decodeControl(bytes: Uint8Array): Control | null {
  const kind = bytes[1]
  if (bytes.length < 2 || bytes[0] !== ATTACH_VERSION || kind === undefined) return null
  return { kind, body: bytes.subarray(2) }
}

export function encodeAddress(address: Endpoint): Uint8Array {
  const out = new Uint8Array(6)
  writeAddress(out, 0, address)
  return out
}

/** Null for anything that isn't a 6-byte IPv4 address and a non-zero port. */
export function decodeAddress(bytes: Uint8Array): Endpoint | null {
  return bytes.length === 6 ? readAddress(bytes, 0) : null
}

export function encodeFrame(address: Endpoint, packet: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_LEN + packet.length)
  out[0] = ATTACH_VERSION
  writeAddress(out, 1, address)
  out.set(packet, FRAME_HEADER_LEN)
  return out
}

/** Null for anything that isn't a version 1 frame with an IPv4 address and a non-zero port. */
export function decodeFrame(bytes: Uint8Array): Frame | null {
  if (bytes.length < FRAME_HEADER_LEN || bytes[0] !== ATTACH_VERSION) return null
  const address = readAddress(bytes, 1)
  if (!address) return null
  return { address, packet: bytes.subarray(FRAME_HEADER_LEN) }
}

function writeAddress(out: Uint8Array, at: number, { host, port }: Endpoint): void {
  const octets = host.split(".").map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`attach framing carries IPv4 only, got ${host}`)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${port}`)
  out.set(octets, at)
  out[at + 4] = port >> 8
  out[at + 5] = port & 0xff
}

function readAddress(bytes: Uint8Array, at: number): Endpoint | null {
  const a = bytes[at]
  const b = bytes[at + 1]
  const c = bytes[at + 2]
  const d = bytes[at + 3]
  const hi = bytes[at + 4]
  const lo = bytes[at + 5]
  if (a === undefined || b === undefined || c === undefined || d === undefined || hi === undefined || lo === undefined) {
    return null
  }
  const port = (hi << 8) | lo
  if (port === 0) return null
  return { host: `${a}.${b}.${c}.${d}`, port }
}
