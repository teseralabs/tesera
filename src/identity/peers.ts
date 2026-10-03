import { randomBytes } from "node:crypto"
import { type Socket } from "node:dgram"
import { bindUdp, closeUdp, createUdpSocket, normalizeHost, sendUdp, type Endpoint } from "../carrier/udp.js"
import { MAX_N } from "../constants.js"
import { asError, sleep } from "../util.js"
import { confirmRelay } from "./confirm.js"
import {
  KIND_AGAIN,
  KIND_JOIN,
  KIND_LOOKUP,
  KIND_RESUME,
  KIND_TABLE,
  HEADER_LEN,
  formatId,
  identityKind,
  parseId,
  signIdentity,
  verifyIdentity,
  writeIdentityHeader,
  type Identity,
} from "./id.js"

const CHALLENGE_LEN = 16
const PUBLIC_KEY_LEN = 32
const SIGNATURE_LEN = 64
const RECORD_LEN = PUBLIC_KEY_LEN + 4 + 2
/** The seed itself takes one of the 32 relay slots. */
export const MAX_INTRODUCED = MAX_N - 1
const LOOKUP_LEN = HEADER_LEN + CHALLENGE_LEN
const NONCE_LEN = 16
const AGAIN_LEN = LOOKUP_LEN + NONCE_LEN
const TABLE_PREFIX = HEADER_LEN + CHALLENGE_LEN + PUBLIC_KEY_LEN + 1
const TABLE_DOMAIN = Buffer.from("tesera-table-v1\0")

export type IntroducedRelay = {
  id: string
  endpoint: Endpoint
}

export type RelayTable = {
  id: string
  publicKey: Buffer
  peers: IntroducedRelay[]
}

type DiscoverOptions = {
  timeoutMs?: number
  attempts?: number
  confirmTimeoutMs?: number
  confirmAttempts?: number
  /** The seed's relay id. A table signed by any other key is refused. */
  pinned?: string | null
}

export function encodeJoin(): Buffer {
  const out = Buffer.alloc(HEADER_LEN)
  writeIdentityHeader(out, KIND_JOIN)
  return out
}

export function isJoin(packet: Uint8Array): boolean {
  return packet.length === HEADER_LEN && identityKind(packet) === KIND_JOIN
}

export function encodeLookup(challenge: Uint8Array): Buffer {
  if (challenge.length !== CHALLENGE_LEN) throw new Error("challenge must be 16 bytes")
  const out = Buffer.alloc(LOOKUP_LEN)
  writeIdentityHeader(out, KIND_LOOKUP)
  out.set(challenge, HEADER_LEN)
  return out
}

export function decodeLookup(packet: Uint8Array): Buffer | null {
  if (packet.length !== LOOKUP_LEN || identityKind(packet) !== KIND_LOOKUP) return null
  return Buffer.from(packet.subarray(HEADER_LEN))
}

export function encodeAgain(challenge: Uint8Array, nonce: Uint8Array): Buffer {
  if (challenge.length !== CHALLENGE_LEN || nonce.length !== NONCE_LEN) throw new Error("peer-table nonce must be 16 bytes")
  const out = Buffer.alloc(AGAIN_LEN)
  writeIdentityHeader(out, KIND_AGAIN)
  out.set(challenge, HEADER_LEN)
  out.set(nonce, HEADER_LEN + CHALLENGE_LEN)
  return out
}

export function decodeAgain(packet: Uint8Array): { challenge: Buffer; nonce: Buffer } | null {
  if (packet.length !== AGAIN_LEN || identityKind(packet) !== KIND_AGAIN) return null
  return {
    challenge: Buffer.from(packet.subarray(HEADER_LEN, HEADER_LEN + CHALLENGE_LEN)),
    nonce: Buffer.from(packet.subarray(HEADER_LEN + CHALLENGE_LEN)),
  }
}

export function encodeResume(challenge: Uint8Array, nonce: Uint8Array): Buffer {
  if (challenge.length !== CHALLENGE_LEN || nonce.length !== NONCE_LEN) throw new Error("peer-table nonce must be 16 bytes")
  const out = Buffer.alloc(AGAIN_LEN)
  writeIdentityHeader(out, KIND_RESUME)
  out.set(challenge, HEADER_LEN)
  out.set(nonce, HEADER_LEN + CHALLENGE_LEN)
  return out
}

export function decodeResume(packet: Uint8Array): { challenge: Buffer; nonce: Buffer } | null {
  if (packet.length !== AGAIN_LEN || identityKind(packet) !== KIND_RESUME) return null
  return {
    challenge: Buffer.from(packet.subarray(HEADER_LEN, HEADER_LEN + CHALLENGE_LEN)),
    nonce: Buffer.from(packet.subarray(HEADER_LEN + CHALLENGE_LEN)),
  }
}

export function encodeTable(identity: Identity, challenge: Uint8Array, peers: IntroducedRelay[]): Buffer {
  if (challenge.length !== CHALLENGE_LEN) throw new Error("challenge must be 16 bytes")
  if (peers.length > MAX_INTRODUCED) throw new Error(`a seed introduces at most ${MAX_INTRODUCED} relays`)
  const records = Buffer.alloc(1 + peers.length * RECORD_LEN)
  records[0] = peers.length
  const ordered = [...peers].sort((a, b) => Buffer.compare(parseId(a.id), parseId(b.id)))
  ordered.forEach((peer, index) => {
    const at = 1 + index * RECORD_LEN
    records.set(parseId(peer.id), at)
    writeEndpoint(records, at + PUBLIC_KEY_LEN, peer.endpoint)
  })
  const signed = tableMessage(challenge, identity.publicKey, records)
  const signature = signIdentity(identity, signed)
  const out = Buffer.alloc(HEADER_LEN + CHALLENGE_LEN + PUBLIC_KEY_LEN + records.length + SIGNATURE_LEN)
  writeIdentityHeader(out, KIND_TABLE)
  out.set(challenge, HEADER_LEN)
  out.set(identity.publicKey, HEADER_LEN + CHALLENGE_LEN)
  out.set(records, HEADER_LEN + CHALLENGE_LEN + PUBLIC_KEY_LEN)
  out.set(signature, out.length - SIGNATURE_LEN)
  return out
}

export function decodeTable(packet: Uint8Array): RelayTable | null {
  if (identityKind(packet) !== KIND_TABLE || packet.length < TABLE_PREFIX + SIGNATURE_LEN) return null
  const count = packet[TABLE_PREFIX - 1]
  if (count === undefined || count > MAX_INTRODUCED) return null
  if (packet.length !== TABLE_PREFIX + count * RECORD_LEN + SIGNATURE_LEN) return null
  const challenge = Buffer.from(packet.subarray(HEADER_LEN, HEADER_LEN + CHALLENGE_LEN))
  const publicKey = Buffer.from(packet.subarray(HEADER_LEN + CHALLENGE_LEN, HEADER_LEN + CHALLENGE_LEN + PUBLIC_KEY_LEN))
  const records = Buffer.from(packet.subarray(TABLE_PREFIX - 1, packet.length - SIGNATURE_LEN))
  const signature = packet.subarray(packet.length - SIGNATURE_LEN)
  if (!verifyIdentity(publicKey, tableMessage(challenge, publicKey, records), signature)) return null
  const peers: IntroducedRelay[] = []
  for (let index = 0; index < count; index++) {
    const at = 1 + index * RECORD_LEN
    const key = records.subarray(at, at + PUBLIC_KEY_LEN)
    const endpoint = readEndpoint(records, at + PUBLIC_KEY_LEN)
    if (!endpoint) return null
    peers.push({ id: formatId(key), endpoint })
  }
  return { id: formatId(publicKey), publicKey, peers }
}

/**
 * Ask a seed for the relays that have joined it.
 * The table signature says the seed listed them. Each address then has to
 * prove it holds the listed key, from that same address.
 */
export async function discoverRelays(seed: Endpoint, opts: DiscoverOptions = {}): Promise<IntroducedRelay[]> {
  const table = await readRelayTable(seed, opts)
  if (opts.pinned && table.id !== opts.pinned) {
    throw new Error(`seed ${seed.host}:${seed.port} is ${table.id}, not the pinned ${opts.pinned}`)
  }
  await confirmRelay(seed, table.id, {
    timeoutMs: opts.confirmTimeoutMs ?? 500,
    attempts: opts.confirmAttempts ?? 3,
  })
  const checks = await Promise.allSettled(
    table.peers
      .filter((peer) => peer.id !== table.id && !sameEndpoint(peer.endpoint, seed))
      .map(async (peer) => {
        await confirmRelay(peer.endpoint, peer.id, {
          timeoutMs: opts.confirmTimeoutMs ?? 500,
          attempts: opts.confirmAttempts ?? 3,
        })
        return peer
      }),
  )
  const peers = checks.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
  return [{ id: table.id, endpoint: { host: seed.host, port: seed.port } }, ...peers]
}

/** Most joined relays one transfer uses when it leaves the seed out. */
export const JOINED_PICK = 3

/**
 * Relays for a sender and receiver on the seed's own machine. The seed's
 * round trip is near zero there, so the scheduler would keep every block on
 * it. With 2 or more joined relays, use up to 3 of them, different hosts
 * first, and keep the seed for a retry. Otherwise use the seed alone.
 * `found` is `discoverRelays` output: the seed first, then relays that proved their key.
 */
export function preferJoined(
  found: readonly Endpoint[],
  random: () => number = Math.random,
): { relays: Endpoint[]; fallback: Endpoint[] | null } {
  const [seed, ...joined] = found
  if (!seed) throw new Error("no relays")
  const order = shuffled(joined, random)
  const hosts = new Set<string>()
  const picked: Endpoint[] = []
  for (const relay of order) {
    if (picked.length >= JOINED_PICK || hosts.has(relay.host)) continue
    hosts.add(relay.host)
    picked.push(relay)
  }
  for (const relay of order) {
    if (picked.length >= JOINED_PICK) break
    if (!picked.includes(relay)) picked.push(relay)
  }
  if (picked.length < 2) return { relays: [seed], fallback: null }
  return { relays: picked, fallback: [seed] }
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const swap = out[i] as T
    out[i] = out[j] as T
    out[j] = swap
  }
  return out
}

export async function readRelayTable(seed: Endpoint, opts: DiscoverOptions = {}): Promise<RelayTable> {
  const attempts = opts.attempts ?? 3
  const timeoutMs = opts.timeoutMs ?? 300
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("discover attempts must be >= 1")
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("discover timeout must be >= 0")
  const socket = createUdpSocket()
  let opened = false
  try {
    await bindUdp(socket, "0.0.0.0", 0)
    opened = true
    for (let attempt = 0; attempt < attempts; attempt++) {
      const table = await oneLookup(socket, seed, timeoutMs)
      if (table) return table
      if (attempt + 1 < attempts) await sleep(20)
    }
    throw new Error(`seed ${seed.host}:${seed.port} did not return a peer table`)
  } finally {
    if (opened) await closeUdp(socket)
  }
}

function oneLookup(socket: Socket, seed: Endpoint, timeoutMs: number): Promise<RelayTable | null> {
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
    let resumed = false
    const onMessage = (msg: Buffer) => {
      const again = decodeAgain(msg)
      if (again && again.challenge.equals(challenge) && !resumed) {
        resumed = true
        sendUdp(socket, encodeResume(challenge, again.nonce), seed).catch((err) => finish(() => reject(asError(err))))
        return
      }
      const table = decodeTable(msg)
      if (!table) return
      const got = msg.subarray(HEADER_LEN, HEADER_LEN + CHALLENGE_LEN)
      if (got.length !== challenge.length || !got.equals(challenge)) return
      finish(() => resolve(table))
    }
    timer = setTimeout(() => finish(() => resolve(null)), timeoutMs)
    socket.on("message", onMessage)
    sendUdp(socket, encodeLookup(challenge), seed).catch((err) => finish(() => reject(asError(err))))
  })
}

function tableMessage(challenge: Uint8Array, publicKey: Uint8Array, records: Uint8Array): Buffer {
  return Buffer.concat([TABLE_DOMAIN, challenge, publicKey, records])
}

function writeEndpoint(out: Buffer, at: number, endpoint: Endpoint): void {
  const host = normalizeHost(endpoint.host)
  const octets = host.split(".").map((part) => Number(part))
  octets.forEach((octet, index) => {
    out[at + index] = octet
  })
  out.writeUInt16BE(endpoint.port, at + 4)
}

function readEndpoint(records: Buffer, at: number): Endpoint | null {
  const octets = [records[at], records[at + 1], records[at + 2], records[at + 3]]
  if (octets.some((octet) => octet === undefined)) return null
  const port = records.readUInt16BE(at + 4)
  if (port < 1 || port > 65535) return null
  try {
    return { host: normalizeHost(octets.join(".")), port }
  } catch {
    return null
  }
}

function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.host === b.host && a.port === b.port
}
