import { randomBytes } from "node:crypto"
import { type Socket } from "node:dgram"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, type Endpoint } from "../carrier/udp.js"
import { asError, sleep } from "../util.js"
import {
  HEADER_LEN,
  KIND_SNAPSHOT,
  KIND_SNAPSHOT_QUERY,
  KIND_USAGE,
  formatId,
  identityKind,
  signIdentity,
  verifyIdentity,
  writeIdentityHeader,
  type Identity,
} from "./id.js"

const CHALLENGE_LEN = 16
const PUBLIC_KEY_LEN = 32
const SIGNATURE_LEN = 64
const U64_LEN = 8
const QUERY_LEN = HEADER_LEN + CHALLENGE_LEN
const SEQ_LEN = 4
const USAGE_LEN_V1 = HEADER_LEN + PUBLIC_KEY_LEN + SEQ_LEN + U64_LEN + SIGNATURE_LEN
const USAGE_LEN = USAGE_LEN_V1 + 4
const SNAPSHOT_LEN_V1 = HEADER_LEN + CHALLENGE_LEN + PUBLIC_KEY_LEN + 2 + U64_LEN + SIGNATURE_LEN
const SNAPSHOT_LEN = SNAPSHOT_LEN_V1 + 4
const USAGE_DOMAIN = Buffer.from("tesera-usage-v1\0")
const SNAPSHOT_DOMAIN = Buffer.from("tesera-snapshot-v1\0")

export type RelaySnapshot = {
  relays: number
  bytes: number
  /** Sends of data for which a relay forwarded the data and an acknowledgement. */
  transfers: number
}

type ReadOptions = {
  timeoutMs?: number
  attempts?: number
}

export function encodeUsage(identity: Identity, seq: number, bytes: number, transfers = 0): Buffer {
  const order = u32(seq)
  const count = u64(bytes)
  const moved = u32Any(transfers)
  const signature = signIdentity(identity, Buffer.concat([USAGE_DOMAIN, identity.publicKey, order, count, moved]))
  const out = Buffer.alloc(USAGE_LEN)
  writeIdentityHeader(out, KIND_USAGE)
  out.set(identity.publicKey, HEADER_LEN)
  out.set(order, HEADER_LEN + PUBLIC_KEY_LEN)
  out.set(count, HEADER_LEN + PUBLIC_KEY_LEN + SEQ_LEN)
  out.set(moved, HEADER_LEN + PUBLIC_KEY_LEN + SEQ_LEN + U64_LEN)
  out.set(signature, HEADER_LEN + PUBLIC_KEY_LEN + SEQ_LEN + U64_LEN + 4)
  return out
}

export function decodeUsage(packet: Uint8Array): { id: string; seq: number; bytes: number; transfers: number } | null {
  const version = packet.length === USAGE_LEN ? 2 : packet.length === USAGE_LEN_V1 ? 1 : 0
  if (!version || identityKind(packet) !== KIND_USAGE) return null
  const publicKey = packet.subarray(HEADER_LEN, HEADER_LEN + PUBLIC_KEY_LEN)
  const order = packet.subarray(HEADER_LEN + PUBLIC_KEY_LEN, HEADER_LEN + PUBLIC_KEY_LEN + SEQ_LEN)
  const count = packet.subarray(HEADER_LEN + PUBLIC_KEY_LEN + SEQ_LEN, HEADER_LEN + PUBLIC_KEY_LEN + SEQ_LEN + U64_LEN)
  const movedAt = HEADER_LEN + PUBLIC_KEY_LEN + SEQ_LEN + U64_LEN
  const moved = version === 2 ? packet.subarray(movedAt, movedAt + 4) : Buffer.alloc(0)
  const signature = packet.subarray(movedAt + (version === 2 ? 4 : 0))
  const signed = Buffer.concat([USAGE_DOMAIN, publicKey, order, count, moved])
  if (!verifyIdentity(publicKey, signed, signature)) return null
  const bytes = readU64(count)
  const seq = readU32(order)
  const transfers = version === 2 ? readU32(moved) : 0
  if (bytes === null || seq === null || transfers === null) return null
  try {
    return { id: formatId(publicKey), seq, bytes, transfers }
  } catch {
    return null
  }
}

export function encodeSnapshotQuery(challenge: Uint8Array): Buffer {
  if (challenge.length !== CHALLENGE_LEN) throw new Error("challenge must be 16 bytes")
  const out = Buffer.alloc(QUERY_LEN)
  writeIdentityHeader(out, KIND_SNAPSHOT_QUERY)
  out.set(challenge, HEADER_LEN)
  return out
}

export function decodeSnapshotQuery(packet: Uint8Array): Buffer | null {
  if (packet.length !== QUERY_LEN || identityKind(packet) !== KIND_SNAPSHOT_QUERY) return null
  return Buffer.from(packet.subarray(HEADER_LEN))
}

export function encodeSnapshot(identity: Identity, challenge: Uint8Array, snapshot: RelaySnapshot): Buffer {
  if (challenge.length !== CHALLENGE_LEN) throw new Error("challenge must be 16 bytes")
  if (!Number.isInteger(snapshot.relays) || snapshot.relays < 1 || snapshot.relays > 0xffff) {
    throw new Error("relay count must fit in 16 bits")
  }
  if (!Number.isInteger(snapshot.transfers) || snapshot.transfers < 0 || snapshot.transfers > 0xffffffff) {
    throw new Error("transfer count must fit in 32 bits")
  }
  const count = u64(snapshot.bytes)
  const moved = u32Any(snapshot.transfers)
  const relays = Buffer.alloc(2)
  relays.writeUInt16BE(snapshot.relays)
  const signed = Buffer.concat([SNAPSHOT_DOMAIN, challenge, identity.publicKey, relays, count, moved])
  const signature = signIdentity(identity, signed)
  const out = Buffer.alloc(SNAPSHOT_LEN)
  writeIdentityHeader(out, KIND_SNAPSHOT)
  let at = HEADER_LEN
  out.set(challenge, at)
  at += CHALLENGE_LEN
  out.set(identity.publicKey, at)
  at += PUBLIC_KEY_LEN
  out.set(relays, at)
  at += 2
  out.set(count, at)
  at += U64_LEN
  out.set(moved, at)
  at += 4
  out.set(signature, at)
  return out
}

export function decodeSnapshot(packet: Uint8Array): { id: string; snapshot: RelaySnapshot } | null {
  const version = packet.length === SNAPSHOT_LEN ? 2 : packet.length === SNAPSHOT_LEN_V1 ? 1 : 0
  if (!version || identityKind(packet) !== KIND_SNAPSHOT) return null
  let at = HEADER_LEN
  const challenge = packet.subarray(at, at + CHALLENGE_LEN)
  at += CHALLENGE_LEN
  const publicKey = packet.subarray(at, at + PUBLIC_KEY_LEN)
  at += PUBLIC_KEY_LEN
  const relays = packet.subarray(at, at + 2)
  at += 2
  const count = packet.subarray(at, at + U64_LEN)
  at += U64_LEN
  const moved = version === 2 ? packet.subarray(at, at + 4) : Buffer.alloc(0)
  at += version === 2 ? 4 : 0
  const signature = packet.subarray(at)
  if (!verifyIdentity(publicKey, Buffer.concat([SNAPSHOT_DOMAIN, challenge, publicKey, relays, count, moved]), signature)) {
    return null
  }
  const bytes = readU64(count)
  const transfers = version === 2 ? readU32(moved) : 0
  const relayCount = (relays[0] ?? 0) * 256 + (relays[1] ?? 0)
  if (bytes === null || transfers === null || relayCount < 1) return null
  try {
    return { id: formatId(publicKey), snapshot: { relays: relayCount, bytes, transfers } }
  } catch {
    return null
  }
}

/** Ask a seed how many relays have joined it, and how many bytes they have forwarded. */
export async function readRelaySnapshot(seed: Endpoint, opts: ReadOptions = {}): Promise<RelaySnapshot> {
  const attempts = opts.attempts ?? 3
  const timeoutMs = opts.timeoutMs ?? 300
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("stats attempts must be >= 1")
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("stats timeout must be >= 0")
  const socket = createUdpSocket()
  let opened = false
  try {
    await bindUdp(socket, "0.0.0.0", 0)
    opened = true
    for (let attempt = 0; attempt < attempts; attempt++) {
      const snapshot = await oneSnapshot(socket, seed, timeoutMs)
      if (snapshot) return snapshot
      if (attempt + 1 < attempts) await sleep(20)
    }
    throw new Error(`seed ${seed.host}:${seed.port} did not return a snapshot`)
  } finally {
    if (opened) await closeUdp(socket)
  }
}

function oneSnapshot(socket: Socket, seed: Endpoint, timeoutMs: number): Promise<RelaySnapshot | null> {
  const challenge = randomBytes(CHALLENGE_LEN)
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout
    const finish = (done: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off("message", onMessage)
      done()
    }
    const onMessage = (msg: Buffer) => {
      if (identityKind(msg) !== KIND_SNAPSHOT) return
      const got = msg.subarray(HEADER_LEN, HEADER_LEN + CHALLENGE_LEN)
      if (got.length !== challenge.length || !got.equals(challenge)) return
      const decoded = decodeSnapshot(msg)
      if (!decoded) return
      finish(() => resolve(decoded.snapshot))
    }
    timer = setTimeout(() => finish(() => resolve(null)), timeoutMs)
    socket.on("message", onMessage)
    sendUdp(socket, encodeSnapshotQuery(challenge), seed).catch((err) => finish(() => reject(asError(err))))
  })
}

function u32Any(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("count must fit in 32 bits")
  const out = Buffer.alloc(SEQ_LEN)
  out.writeUInt32BE(value)
  return out
}

function u32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) throw new Error("usage sequence must fit in 32 bits")
  const out = Buffer.alloc(SEQ_LEN)
  out.writeUInt32BE(value)
  return out
}

function readU32(bytes: Uint8Array): number | null {
  if (bytes.length !== SEQ_LEN) return null
  return Buffer.from(bytes).readUInt32BE(0)
}

function u64(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("byte count must be a non-negative safe integer")
  const out = Buffer.alloc(U64_LEN)
  out.writeBigUInt64BE(BigInt(value))
  return out
}

function readU64(bytes: Uint8Array): number | null {
  if (bytes.length !== U64_LEN) return null
  const value = Buffer.from(bytes).readBigUInt64BE(0)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(value)
}
