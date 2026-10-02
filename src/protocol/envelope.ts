import { ENVELOPE_LEN, PROTOCOL_VERSION } from "../constants.js"
import type { Endpoint } from "../carrier/udp.js"

/** Forward envelope. ASCII TESR, distinct from the TSID identity packet. */
const MAGIC = [0x54, 0x45, 0x53, 0x52] as const

export function encodeEnvelope(dest: Endpoint, inner: Uint8Array): Buffer {
  const out = Buffer.alloc(ENVELOPE_LEN + inner.length)
  out[0] = MAGIC[0]
  out[1] = MAGIC[1]
  out[2] = MAGIC[2]
  out[3] = MAGIC[3]
  out[4] = PROTOCOL_VERSION
  const octets = dest.host.split(".").map((part) => Number(part))
  out[5] = octets[0] ?? 0
  out[6] = octets[1] ?? 0
  out[7] = octets[2] ?? 0
  out[8] = octets[3] ?? 0
  out.writeUInt16BE(dest.port, 9)
  out.set(inner, ENVELOPE_LEN)
  return out
}

export function decodeEnvelope(packet: Uint8Array): { dest: Endpoint; inner: Buffer } | null {
  if (packet.length < ENVELOPE_LEN) return null
  if (packet[0] !== MAGIC[0] || packet[1] !== MAGIC[1] || packet[2] !== MAGIC[2] || packet[3] !== MAGIC[3]) {
    return null
  }
  if (packet[4] !== PROTOCOL_VERSION) return null
  const host = `${packet[5]}.${packet[6]}.${packet[7]}.${packet[8]}`
  const port = ((packet[9] ?? 0) << 8) | (packet[10] ?? 0)
  if (port === 0) return null
  return { dest: { host, port }, inner: Buffer.from(packet.subarray(ENVELOPE_LEN)) }
}
