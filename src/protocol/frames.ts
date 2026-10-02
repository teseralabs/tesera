import {
  CRC_LEN,
  DATA_HEADER_LEN,
  FRAME_ACK,
  FRAME_DATA,
  FRAME_NACK,
  FRAME_SAMPLE,
  MAC_LEN,
  MAX_N,
  MAX_SHARD,
  PROTOCOL_VERSION,
  SESSION_ID_LEN,
} from "../constants.js"
import { mac16, macMatches } from "../crypto/session.js"
import { crc32 } from "./crc32.js"

/** Block id of a data frame, or null if the datagram is not one. Used by the loss sim. */
export function peekDataBlockId(packet: Uint8Array): number | null {
  const peeked = peekRelayFrame(packet)
  return peeked?.kind === "data" ? peeked.blockId : null
}

export type RelayFramePeek = {
  kind: "data" | "ack" | "nack"
  blockId: number
  sessionPrefix: string
  /** Set for a data frame. Zero for ack and nack. */
  tesseraIndex: number
}

/** Header fields a relay can read. The payload stays opaque. */
export function peekRelayFrame(packet: Uint8Array): RelayFramePeek | null {
  if (packet.length < 22 || packet[0] !== PROTOCOL_VERSION) return null
  const type = packet[1]
  const kind = type === FRAME_DATA ? "data" : type === FRAME_ACK ? "ack" : type === FRAME_NACK ? "nack" : null
  if (!kind) return null
  const blockId =
    (((packet[18] ?? 0) << 24) | ((packet[19] ?? 0) << 16) | ((packet[20] ?? 0) << 8) | (packet[21] ?? 0)) >>> 0
  const tesseraIndex = kind === "data" && packet.length >= 23 ? packet[22] ?? 0 : 0
  return { kind, blockId, sessionPrefix: Buffer.from(packet.subarray(2, 6)).toString("hex"), tesseraIndex }
}

export type DataFrame = {
  kind: "data"
  sessionId: Buffer
  blockId: number
  tesseraIndex: number
  k: number
  n: number
  cipherLen: number
  payload: Buffer
}

export type AckFrame = {
  kind: "ack"
  sessionId: Buffer
  blockId: number
}

export type NackFrame = {
  kind: "nack"
  sessionId: Buffer
  blockId: number
  missing: number[]
}

export type SampleFrame = {
  kind: "sample"
  sessionId: Buffer
  blockId: number
  tesseraIndex: number
}

export type Frame = DataFrame | AckFrame | NackFrame | SampleFrame

function sessionAt(packet: Buffer): Buffer {
  return Buffer.from(packet.subarray(2, 2 + SESSION_ID_LEN))
}

export function encodeData(frame: DataFrame): Buffer {
  if (frame.sessionId.length !== SESSION_ID_LEN) throw new Error("session id must be 16 bytes")
  if (frame.payload.length > 0xffff || frame.cipherLen > 0xffff) {
    throw new Error("tessera does not fit in a u16 length")
  }
  const out = Buffer.alloc(DATA_HEADER_LEN + frame.payload.length + 4)
  out[0] = PROTOCOL_VERSION
  out[1] = FRAME_DATA
  out.set(frame.sessionId, 2)
  out.writeUInt32BE(frame.blockId, 18)
  out[22] = frame.tesseraIndex
  out[23] = frame.k
  out[24] = frame.n
  out.writeUInt16BE(frame.cipherLen, 25)
  out.writeUInt16BE(frame.payload.length, 27)
  out.set(frame.payload, DATA_HEADER_LEN)
  out.writeUInt32BE(crc32(out.subarray(0, out.length - 4)), out.length - 4)
  return out
}

export function encodeAck(frame: AckFrame, key: Uint8Array): Buffer {
  return finishControl(FRAME_ACK, frame.sessionId, frame.blockId, Buffer.alloc(0), key)
}

export function encodeNack(frame: NackFrame, key: Uint8Array): Buffer {
  if (frame.missing.length > MAX_N) throw new Error("nack lists too many tesserae")
  const body = Buffer.alloc(1 + frame.missing.length)
  body[0] = frame.missing.length
  for (let i = 0; i < frame.missing.length; i++) body[i + 1] = frame.missing[i] ?? 0
  return finishControl(FRAME_NACK, frame.sessionId, frame.blockId, body, key)
}

export function encodeSample(frame: SampleFrame, key: Uint8Array): Buffer {
  if (!Number.isInteger(frame.tesseraIndex) || frame.tesseraIndex < 0 || frame.tesseraIndex >= MAX_N) {
    throw new Error("bad tessera index")
  }
  return finishControl(FRAME_SAMPLE, frame.sessionId, frame.blockId, Buffer.from([frame.tesseraIndex]), key)
}

function finishControl(
  type: number,
  sessionId: Buffer,
  blockId: number,
  body: Buffer,
  key: Uint8Array,
): Buffer {
  if (sessionId.length !== SESSION_ID_LEN) throw new Error("session id must be 16 bytes")
  const unsigned = Buffer.alloc(22 + body.length)
  unsigned[0] = PROTOCOL_VERSION
  unsigned[1] = type
  unsigned.set(sessionId, 2)
  unsigned.writeUInt32BE(blockId, 18)
  unsigned.set(body, 22)
  return Buffer.concat([unsigned, mac16(key, unsigned)])
}

/** Returns null for truncated, corrupt, or inauthentic datagrams. */
/** Data frames ignore `macKey`. Control frames fail closed when it is absent. */
export function decodeFrame(buf: Uint8Array, macKey: Uint8Array | null): Frame | null {
  const packet = Buffer.from(buf)
  if (packet.length < 2 || packet[0] !== PROTOCOL_VERSION) return null
  const type = packet[1]
  if (type === FRAME_DATA) return decodeData(packet)
  if (!macKey) return null
  if (type === FRAME_ACK || type === FRAME_NACK || type === FRAME_SAMPLE) return decodeControl(packet, macKey, type)
  return null
}

function decodeData(packet: Buffer): DataFrame | null {
  if (packet.length < DATA_HEADER_LEN + CRC_LEN) return null
  const declared = packet.readUInt32BE(packet.length - CRC_LEN)
  if (declared !== crc32(packet.subarray(0, packet.length - CRC_LEN))) return null
  const shardLen = packet.readUInt16BE(27)
  if (shardLen < 1 || shardLen > MAX_SHARD) return null
  if (packet.length !== DATA_HEADER_LEN + shardLen + CRC_LEN) return null
  const k = packet[23] ?? 0
  const n = packet[24] ?? 0
  const tesseraIndex = packet[22] ?? 0
  if (k < 1 || n < k || n > MAX_N || tesseraIndex >= n) return null
  const cipherLen = packet.readUInt16BE(25)
  if (cipherLen < 1 || cipherLen > k * shardLen) return null
  return {
    kind: "data",
    sessionId: sessionAt(packet),
    blockId: packet.readUInt32BE(18),
    tesseraIndex,
    k,
    n,
    cipherLen,
    payload: Buffer.from(packet.subarray(DATA_HEADER_LEN, DATA_HEADER_LEN + shardLen)),
  }
}

function decodeControl(packet: Buffer, key: Uint8Array, type: number): Frame | null {
  if (packet.length < 22 + MAC_LEN) return null
  const unsigned = packet.subarray(0, packet.length - MAC_LEN)
  const mac = packet.subarray(packet.length - MAC_LEN)
  if (!macMatches(key, unsigned, mac)) return null
  const sessionId = sessionAt(packet)
  const blockId = packet.readUInt32BE(18)
  if (type === FRAME_ACK) {
    if (packet.length !== 22 + MAC_LEN) return null
    return { kind: "ack", sessionId, blockId }
  }
  if (type === FRAME_SAMPLE) {
    if (packet.length !== 23 + MAC_LEN) return null
    return { kind: "sample", sessionId, blockId, tesseraIndex: packet[22] ?? 0 }
  }
  const count = packet[22] ?? 0
  if (count > MAX_N || packet.length !== 23 + count + MAC_LEN) return null
  const missing: number[] = []
  for (let i = 0; i < count; i++) missing.push(packet[23 + i] ?? 0)
  return { kind: "nack", sessionId, blockId, missing }
}
