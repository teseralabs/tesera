import { readFile, rename, writeFile } from "node:fs/promises"
import { type Socket } from "node:dgram"
import { bindUdp, closeUdp, createUdpSocket, normalizeHost, sendUdp, type Endpoint } from "../carrier/udp.js"
import { PROTOCOL_VERSION } from "../constants.js"
import { asError, sleep } from "../util.js"
import {
  HEADER_LEN,
  KIND_RECORD,
  KIND_RECORD_ASK,
  formatId,
  identityKind,
  signIdentity,
  verifyIdentity,
  writeIdentityHeader,
  type Identity,
} from "./id.js"

const SIGNATURE_LEN = 64
const PUBLIC_KEY_LEN = 32
/** Canonical body, not counting the identity header or the signature. */
export const MAX_RECORD_BODY = 512
export const RECORD_VERSION = 1
export const DEFAULT_RECORD_TTL_SEC = 24 * 60 * 60
export const MIN_RECORD_TTL_SEC = 60
export const MAX_RECORD_TTL_SEC = 7 * 24 * 60 * 60
/** How far ahead of the verifier's clock an issuedAt may sit. */
export const RECORD_SKEW_SEC = 5 * 60
const FIXED_LEN = 50
export const RECORD_DOMAIN = Buffer.from("tesera-relay-record-v1\0")

/** This build's self-reported name. A signature does not prove the binary is unmodified. */
export const IMPLEMENTATION_ID = "tesera"
/** Keep this in step with package.json. It is a claim, not a measurement. */
export const SOFTWARE_VERSION = "0.3.0-beta"
/** Informational. Unknown tokens are ignored, and none of these relax a check. */
export const RECORD_CAPABILITIES = ["discover", "forward"] as const

const IMPL_RE = /^[a-z0-9-]{1,16}$/
const SOFTWARE_RE = /^[\x21-\x7e]{1,32}$/
const BUILD_RE = /^[A-Za-z0-9._-]{1,40}$/
const MANIFEST_RE = /^[a-z0-9]{1,64}$/
const CAP_RE = /^[a-z0-9-]{1,16}$/

export type RecordClaims = {
  addresses: Endpoint[]
  name: string
  ttlSec: number
  implementation: string
  software: string
  build: string
  manifest: string
  capabilities: readonly string[]
}

export type SignedRecord = {
  packet: Buffer
  body: Buffer
  id: string
  publicKey: Buffer
  seq: bigint
  issuedAt: number
  ttl: number
  wire: number
  implementation: string
  software: string
  build: string
  manifest: string
  capabilities: string[]
  addresses: Endpoint[]
  name: string
}

export type RecordView = {
  id: string
  seq: string
  issuedAt: number
  ttl: number
  wire: number
  implementation: string
  software: string
  build: string
  manifest: string
  capabilities: string[]
  addresses: string[]
  name: string
}

export type RecordDocument = {
  packet: string
  record: RecordView
}

export type RecordDecision =
  | { action: "accept" | "same" | "supersede" | "keep"; record: SignedRecord }
  | { action: "conflict" | "reject"; record: SignedRecord | null }

export function officialClaims(partial: { addresses: Endpoint[]; name: string; ttlSec: number }): RecordClaims {
  return {
    addresses: partial.addresses,
    name: partial.name,
    ttlSec: partial.ttlSec,
    implementation: IMPLEMENTATION_ID,
    software: SOFTWARE_VERSION,
    build: "",
    manifest: "",
    capabilities: RECORD_CAPABILITIES,
  }
}

export function encodeRecordAsk(): Buffer {
  const out = Buffer.alloc(HEADER_LEN)
  writeIdentityHeader(out, KIND_RECORD_ASK)
  return out
}

export function isRecordAsk(packet: Uint8Array): boolean {
  return packet.length === HEADER_LEN && identityKind(packet) === KIND_RECORD_ASK
}

export function encodeRecord(identity: Identity, claims: RecordClaims, seq: bigint, issuedAt: number): Buffer {
  const body = canonicalBody(identity.publicKey, claims, seq, issuedAt)
  if (body.length > MAX_RECORD_BODY) throw new Error("relay record is larger than 512 bytes")
  const signature = signIdentity(identity, Buffer.concat([RECORD_DOMAIN, body]))
  const out = Buffer.alloc(HEADER_LEN + body.length + SIGNATURE_LEN)
  writeIdentityHeader(out, KIND_RECORD)
  out.set(body, HEADER_LEN)
  out.set(signature, HEADER_LEN + body.length)
  return out
}

/** Format only. A true result still has to pass `verifyRecord`. */
export function decodeRecord(packet: Uint8Array): SignedRecord | null {
  if (identityKind(packet) !== KIND_RECORD) return null
  if (packet.length < HEADER_LEN + FIXED_LEN + SIGNATURE_LEN) return null
  const bodyLen = packet.length - HEADER_LEN - SIGNATURE_LEN
  if (bodyLen > MAX_RECORD_BODY) return null
  const body = Buffer.from(packet.subarray(HEADER_LEN, HEADER_LEN + bodyLen))
  if (body[0] !== RECORD_VERSION) return null
  const wire = body[1]
  if (wire === undefined) return null
  const publicKey = Buffer.from(body.subarray(2, 2 + PUBLIC_KEY_LEN))
  let id: string
  try {
    id = formatId(publicKey)
  } catch {
    return null
  }
  const seq = body.readBigUInt64BE(34)
  if (seq < 1n) return null
  const issuedAt = body.readUInt32BE(42)
  const ttl = body.readUInt32BE(46)
  if (ttl < MIN_RECORD_TTL_SEC || ttl > MAX_RECORD_TTL_SEC) return null
  let at = FIXED_LEN
  const implementation = readToken(body, at, 1, 16, IMPL_RE)
  if (!implementation) return null
  at = implementation.next
  const software = readToken(body, at, 1, 32, SOFTWARE_RE)
  if (!software) return null
  at = software.next
  const build = readToken(body, at, 0, 40, BUILD_RE)
  if (!build) return null
  at = build.next
  const manifest = readToken(body, at, 0, 64, MANIFEST_RE)
  if (!manifest) return null
  at = manifest.next
  const capabilities = readCapabilities(body, at)
  if (!capabilities) return null
  at = capabilities.next
  const addresses = readAddresses(body, at)
  if (!addresses) return null
  at = addresses.next
  const name = readName(body, at)
  if (!name || name.next !== body.length) return null
  return {
    packet: Buffer.from(packet),
    body,
    id,
    publicKey,
    seq,
    issuedAt,
    ttl,
    wire,
    implementation: implementation.text,
    software: software.text,
    build: build.text,
    manifest: manifest.text,
    capabilities: capabilities.tokens,
    addresses: addresses.endpoints,
    name: name.text,
  }
}

export function verifyRecord(record: SignedRecord): boolean {
  if (record.packet.length < SIGNATURE_LEN) return false
  const signature = record.packet.subarray(record.packet.length - SIGNATURE_LEN)
  return verifyIdentity(record.publicKey, Buffer.concat([RECORD_DOMAIN, record.body]), signature)
}

/** Clock check. Sequence is not part of it. */
export function recordFresh(record: SignedRecord, nowSec: number): boolean {
  if (!Number.isSafeInteger(nowSec)) return false
  if (record.issuedAt > nowSec + RECORD_SKEW_SEC) return false
  return nowSec <= record.issuedAt + record.ttl
}

/**
 * Higher sequence wins, including when that card is no longer fresh.
 * An equal sequence with a different body is a conflict and the incoming card is not used.
 * Both cards must already verify. An unverified incoming card is rejected.
 */
export function chooseRecord(held: SignedRecord | null, incoming: SignedRecord): RecordDecision {
  if (!verifyRecord(incoming)) return { action: "reject", record: held }
  if (held && !verifyRecord(held)) return { action: "reject", record: null }
  if (!held) return { action: "accept", record: incoming }
  if (!held.publicKey.equals(incoming.publicKey)) return { action: "reject", record: held }
  if (incoming.seq > held.seq) return { action: "supersede", record: incoming }
  if (incoming.seq < held.seq) return { action: "keep", record: held }
  if (held.body.equals(incoming.body)) return { action: "same", record: held }
  return { action: "conflict", record: held }
}

/** Fields decoded from `packet`. Null when the packet is not a valid signed record. */
export function recordDocument(packet: Uint8Array): RecordDocument | null {
  const record = decodeRecord(packet)
  if (!record || !verifyRecord(record)) return null
  return { packet: Buffer.from(packet).toString("base64"), record: recordView(record) }
}

export function recordView(record: SignedRecord): RecordView {
  return {
    id: record.id,
    seq: record.seq.toString(),
    issuedAt: record.issuedAt,
    ttl: record.ttl,
    wire: record.wire,
    implementation: record.implementation,
    software: record.software,
    build: record.build,
    manifest: record.manifest,
    capabilities: [...record.capabilities],
    addresses: record.addresses.map((endpoint) => `${endpoint.host}:${endpoint.port}`),
    name: record.name,
  }
}

export type PlannedRecord = { packet: Buffer; seq: bigint; reused: boolean }

/**
 * Keep the stored card when it still verifies, the claims match, and more than half its ttl remains.
 * Otherwise sign the next sequence. A missing file starts at 1. A file that does not verify throws
 * so the caller does not silently roll the counter backward.
 */
export function planRecord(input: {
  identity: Identity
  claims: RecordClaims
  stored: Uint8Array | null
  nowSec: number
}): PlannedRecord {
  if (!Number.isSafeInteger(input.nowSec) || input.nowSec < 0) throw new Error("record time must be a unix second")
  const stored = input.stored ? decodeRecord(input.stored) : null
  if (input.stored && (!stored || !verifyRecord(stored))) throw new Error("record file is not a valid record")
  if (stored && !stored.publicKey.equals(input.identity.publicKey)) {
    throw new Error("record file is for a different relay")
  }
  if (
    stored &&
    sameClaims(stored, input.claims) &&
    recordFresh(stored, input.nowSec) &&
    (stored.issuedAt + stored.ttl - input.nowSec) * 2 > stored.ttl
  ) {
    return { packet: stored.packet, seq: stored.seq, reused: true }
  }
  const seq = stored ? nextSeq(stored.seq) : 1n
  const packet = encodeRecord(input.identity, input.claims, seq, input.nowSec)
  return { packet, seq, reused: false }
}

export async function readRecordFile(path: string): Promise<Buffer | null> {
  let data: Buffer
  try {
    data = await readFile(path)
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
  if (data.length === 0 || data.length > HEADER_LEN + MAX_RECORD_BODY + SIGNATURE_LEN) {
    throw new Error("record file is not a valid record")
  }
  return data
}

export async function writeRecordFile(path: string, packet: Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, packet, { mode: 0o644 })
  await rename(tmp, path)
}

export async function fetchRelayRecord(endpoint: Endpoint, opts: { timeoutMs?: number; attempts?: number } = {}): Promise<Buffer> {
  const attempts = opts.attempts ?? 3
  const timeoutMs = opts.timeoutMs ?? 300
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("record attempts must be >= 1")
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("record timeout must be >= 0")
  const socket = createUdpSocket()
  let opened = false
  try {
    await bindUdp(socket, "0.0.0.0", 0)
    opened = true
    for (let attempt = 0; attempt < attempts; attempt++) {
      const packet = await oneFetch(socket, endpoint, timeoutMs)
      if (packet) return packet
      if (attempt + 1 < attempts) await sleep(20)
    }
    throw new Error(`relay ${endpoint.host}:${endpoint.port} did not return a record`)
  } finally {
    if (opened) await closeUdp(socket)
  }
}

function sameClaims(record: SignedRecord, claims: RecordClaims): boolean {
  if (record.wire !== PROTOCOL_VERSION) return false
  if (record.ttl !== claims.ttlSec) return false
  if (record.implementation !== claims.implementation) return false
  if (record.software !== claims.software) return false
  if (record.build !== claims.build) return false
  if (record.manifest !== claims.manifest) return false
  if (record.name !== claims.name) return false
  if (record.capabilities.join("\0") !== [...claims.capabilities].sort().join("\0")) return false
  const want = canonicalAddresses(claims.addresses)
  if (record.addresses.length !== want.length) return false
  return record.addresses.every((endpoint, index) => {
    const other = want[index]
    return other !== undefined && endpoint.host === other.host && endpoint.port === other.port
  })
}

function nextSeq(seq: bigint): bigint {
  if (seq >= (1n << 64n) - 1n) throw new Error("record sequence is exhausted")
  return seq + 1n
}

function canonicalBody(publicKey: Uint8Array, claims: RecordClaims, seq: bigint, issuedAt: number): Buffer {
  if (publicKey.length !== PUBLIC_KEY_LEN) throw new Error("relay record needs a 32-byte public key")
  if (seq < 1n || seq > (1n << 64n) - 1n) throw new Error("record sequence must fit in 64 bits and start at 1")
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt > 0xffffffff) {
    throw new Error("record issuedAt must be a unix second")
  }
  if (!Number.isSafeInteger(claims.ttlSec) || claims.ttlSec < MIN_RECORD_TTL_SEC || claims.ttlSec > MAX_RECORD_TTL_SEC) {
    throw new Error(`record ttl must be from ${MIN_RECORD_TTL_SEC} to ${MAX_RECORD_TTL_SEC} seconds`)
  }
  assertToken(claims.implementation, IMPL_RE, "implementation")
  assertToken(claims.software, SOFTWARE_RE, "software version")
  assertToken(claims.build, BUILD_RE, "build", true)
  assertToken(claims.manifest, MANIFEST_RE, "manifest", true)
  const capabilities = canonicalCapabilities(claims.capabilities)
  const addresses = canonicalAddresses(claims.addresses)
  const name = canonicalName(claims.name)
  const parts = [
    tokenBytes(claims.implementation),
    tokenBytes(claims.software),
    tokenBytes(claims.build),
    tokenBytes(claims.manifest),
    capabilityBytes(capabilities),
    addressBytes(addresses),
    nameBytes(name),
  ]
  const body = Buffer.alloc(FIXED_LEN + parts.reduce((sum, part) => sum + part.length, 0))
  body[0] = RECORD_VERSION
  body[1] = PROTOCOL_VERSION
  body.set(publicKey, 2)
  body.writeBigUInt64BE(seq, 34)
  body.writeUInt32BE(issuedAt, 42)
  body.writeUInt32BE(claims.ttlSec, 46)
  let at = FIXED_LEN
  for (const part of parts) {
    body.set(part, at)
    at += part.length
  }
  return body
}

function canonicalCapabilities(capabilities: readonly string[]): string[] {
  if (capabilities.length > 8) throw new Error("a relay record lists at most 8 capabilities")
  const tokens = [...capabilities]
  for (const token of tokens) assertToken(token, CAP_RE, "capability")
  tokens.sort()
  for (let index = 1; index < tokens.length; index++) {
    if (tokens[index] === tokens[index - 1]) throw new Error("relay record capabilities repeat")
  }
  return tokens
}

function canonicalAddresses(addresses: Endpoint[]): Endpoint[] {
  if (addresses.length > 4) throw new Error("a relay record lists at most 4 addresses")
  const normalized = addresses.map((endpoint) => {
    const host = normalizeHost(endpoint.host)
    if (host === "0.0.0.0") throw new Error("a relay record cannot advertise 0.0.0.0")
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
      throw new Error("a relay record needs a UDP port")
    }
    return { host, port: endpoint.port }
  })
  normalized.sort((left, right) => {
    const byHost = Buffer.compare(ipv4(left.host), ipv4(right.host))
    if (byHost !== 0) return byHost
    return left.port - right.port
  })
  for (let index = 1; index < normalized.length; index++) {
    const prev = normalized[index - 1]
    const next = normalized[index]
    if (prev && next && prev.host === next.host && prev.port === next.port) {
      throw new Error("relay record addresses repeat")
    }
  }
  return normalized
}

function canonicalName(name: string): Buffer {
  const bytes = Buffer.from(name, "utf8")
  if (bytes.length > 64) throw new Error("relay name must be at most 64 bytes")
  if (!nameBytesOk(bytes)) throw new Error("relay name has a character the record does not allow")
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== name) {
    throw new Error("relay name has a character the record does not allow")
  }
  return bytes
}

function nameBytesOk(bytes: Buffer): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    for (const char of text) {
      const code = char.codePointAt(0)
      if (code === undefined || code < 0x20 || code === 0x7f) return false
      if (code >= 0x202a && code <= 0x202e) return false
      if (code >= 0x2066 && code <= 0x2069) return false
    }
    return Buffer.from(text, "utf8").equals(bytes)
  } catch {
    return false
  }
}

function assertToken(value: string, pattern: RegExp, label: string, allowEmpty = false): void {
  if (allowEmpty && value.length === 0) return
  if (!pattern.test(value)) throw new Error(`relay record ${label} is not allowed`)
}

function tokenBytes(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8")
  const out = Buffer.alloc(1 + bytes.length)
  out[0] = bytes.length
  out.set(bytes, 1)
  return out
}

function capabilityBytes(tokens: string[]): Buffer {
  const parts = tokens.map((token) => tokenBytes(token))
  const out = Buffer.alloc(1 + parts.reduce((sum, part) => sum + part.length, 0))
  out[0] = tokens.length
  let at = 1
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function addressBytes(addresses: Endpoint[]): Buffer {
  const out = Buffer.alloc(1 + addresses.length * 7)
  out[0] = addresses.length
  addresses.forEach((endpoint, index) => {
    const at = 1 + index * 7
    out[at] = 4
    out.set(ipv4(endpoint.host), at + 1)
    out.writeUInt16BE(endpoint.port, at + 5)
  })
  return out
}

function nameBytes(name: Buffer): Buffer {
  const out = Buffer.alloc(1 + name.length)
  out[0] = name.length
  out.set(name, 1)
  return out
}

function ipv4(host: string): Buffer {
  return Buffer.from(host.split(".").map((part) => Number(part)))
}

function readToken(
  body: Buffer,
  at: number,
  min: number,
  max: number,
  pattern: RegExp,
): { text: string; next: number } | null {
  const read = readSpan(body, at, min, max)
  if (!read) return null
  if (read.bytes.length === 0) return { text: "", next: read.next }
  const text = read.bytes.toString("utf8")
  if (Buffer.byteLength(text) !== read.bytes.length || !pattern.test(text)) return null
  return { text, next: read.next }
}

function readCapabilities(body: Buffer, at: number): { tokens: string[]; next: number } | null {
  if (at >= body.length) return null
  const count = body[at]
  if (count === undefined || count > 8) return null
  const tokens: string[] = []
  let next = at + 1
  for (let index = 0; index < count; index++) {
    const token = readToken(body, next, 1, 16, CAP_RE)
    if (!token) return null
    tokens.push(token.text)
    next = token.next
  }
  for (let index = 1; index < tokens.length; index++) {
    const prev = tokens[index - 1]
    const token = tokens[index]
    if (prev === undefined || token === undefined || prev >= token) return null
  }
  return { tokens, next }
}

function readAddresses(body: Buffer, at: number): { endpoints: Endpoint[]; next: number } | null {
  if (at >= body.length) return null
  const count = body[at]
  if (count === undefined || count > 4) return null
  const endpoints: Endpoint[] = []
  let next = at + 1
  for (let index = 0; index < count; index++) {
    if (next + 7 > body.length) return null
    if (body[next] !== 4) return null
    const host = [body[next + 1], body[next + 2], body[next + 3], body[next + 4]].join(".")
    const port = body.readUInt16BE(next + 5)
    let endpoint: Endpoint
    try {
      endpoint = { host: normalizeHost(host), port }
    } catch {
      return null
    }
    if (endpoint.host === "0.0.0.0" || port < 1) return null
    endpoints.push(endpoint)
    next += 7
  }
  for (let index = 1; index < endpoints.length; index++) {
    const prev = endpoints[index - 1]
    const endpoint = endpoints[index]
    if (!prev || !endpoint) return null
    const order = Buffer.compare(ipv4(prev.host), ipv4(endpoint.host)) || prev.port - endpoint.port
    if (order >= 0) return null
  }
  return { endpoints, next }
}

function readName(body: Buffer, at: number): { text: string; next: number } | null {
  const read = readSpan(body, at, 0, 64)
  if (!read || !nameBytesOk(read.bytes)) return null
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(read.bytes), next: read.next }
}

function readSpan(body: Buffer, at: number, min: number, max: number): { bytes: Buffer; next: number } | null {
  if (at >= body.length) return null
  const len = body[at]
  if (len === undefined || len < min || len > max) return null
  const start = at + 1
  const end = start + len
  if (end > body.length) return null
  return { bytes: Buffer.from(body.subarray(start, end)), next: end }
}

function oneFetch(socket: Socket, endpoint: Endpoint, timeoutMs: number): Promise<Buffer | null> {
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
    const onMessage = (msg: Buffer, rinfo: { address: string; port: number }) => {
      if (rinfo.port !== endpoint.port) return
      let host: string
      try {
        host = normalizeHost(rinfo.address)
      } catch {
        return
      }
      if (host !== endpoint.host) return
      if (!decodeRecord(msg)) return
      finish(() => resolve(Buffer.from(msg)))
    }
    timer = setTimeout(() => finish(() => resolve(null)), timeoutMs)
    socket.on("message", onMessage)
    sendUdp(socket, encodeRecordAsk(), endpoint).catch((err) => finish(() => reject(asError(err))))
  })
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT"
}
