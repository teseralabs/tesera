import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"
import { parseEndpoint, type Endpoint } from "../carrier/udp.js"
import { PROTOCOL_VERSION } from "../constants.js"

/** Text form is `relay:` plus the lowercase base32 of the raw Ed25519 public key. */
export const ID_PREFIX = "relay:"

const PUBLIC_KEY_LEN = 32
const SECRET_LEN = 32
const CHALLENGE_LEN = 16
const SIGNATURE_LEN = 64
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")
const DOMAIN = Buffer.from("tesera-bind-v1\0")

/** Not the TESR forward envelope, so a query cannot be parsed as something to forward. */
const ID_MAGIC = [0x54, 0x53, 0x49, 0x44] as const
const KIND_QUERY = 1
const KIND_PROOF = 2
export const KIND_LOOKUP = 3
export const KIND_TABLE = 4
export const KIND_JOIN = 5
export const KIND_USAGE = 6
export const KIND_SNAPSHOT_QUERY = 7
export const KIND_SNAPSHOT = 8
/** Small reply. The peer table follows only after this nonce comes back. */
export const KIND_AGAIN = 9
export const KIND_RESUME = 10
/** Ask a relay for its signed record. The body is empty. */
export const KIND_RECORD_ASK = 11
/** Signed relay record. The body is the canonical card. */
export const KIND_RECORD = 12
export const HEADER_LEN = 6
const IDENTITY_KINDS = new Set([
  KIND_QUERY,
  KIND_PROOF,
  KIND_LOOKUP,
  KIND_TABLE,
  KIND_JOIN,
  KIND_USAGE,
  KIND_SNAPSHOT_QUERY,
  KIND_SNAPSHOT,
  KIND_AGAIN,
  KIND_RESUME,
  KIND_RECORD_ASK,
  KIND_RECORD,
])
const QUERY_LEN = HEADER_LEN + CHALLENGE_LEN
const PROOF_LEN = QUERY_LEN + PUBLIC_KEY_LEN + SIGNATURE_LEN

export type Identity = {
  id: string
  publicKey: Buffer
  secret: Buffer
}

export type RelayRef = {
  id: string | null
  endpoint: Endpoint
}

export type Proof = {
  challenge: Buffer
  publicKey: Buffer
  signature: Buffer
}

export function generateIdentity(): Identity {
  const { privateKey } = generateKeyPairSync("ed25519")
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" })
  if (!Buffer.isBuffer(pkcs8) || pkcs8.length !== PKCS8_PREFIX.length + SECRET_LEN) {
    throw new Error("unexpected ed25519 private key encoding")
  }
  if (!pkcs8.subarray(0, PKCS8_PREFIX.length).equals(PKCS8_PREFIX)) {
    throw new Error("unexpected ed25519 private key encoding")
  }
  return identityFromSeed(Buffer.from(pkcs8.subarray(pkcs8.length - SECRET_LEN)))
}

export function identityFromSecret(secret: string): Identity {
  const trimmed = secret.trim()
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("identity secret must be 32 bytes as 64 hex characters (generate one with: tesera id)")
  }
  return identityFromSeed(Buffer.from(trimmed, "hex"))
}

export function formatId(publicKey: Uint8Array): string {
  if (publicKey.length !== PUBLIC_KEY_LEN) throw new Error("relay id is a 32-byte ed25519 public key")
  return ID_PREFIX + base32Encode(publicKey)
}

export function parseId(value: string): Buffer {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.startsWith(ID_PREFIX)) throw new Error(`relay id must start with ${ID_PREFIX}`)
  const publicKey = base32Decode(trimmed.slice(ID_PREFIX.length))
  if (publicKey.length !== PUBLIC_KEY_LEN) throw new Error("relay id has the wrong length")
  if (formatId(publicKey) !== trimmed) throw new Error("relay id is not canonical")
  return publicKey
}

/** `host:port`, or `relay:ID@host:port` when the relay's key is pinned. */
export function parseRelayRef(value: string): RelayRef {
  const trimmed = value.trim()
  const at = trimmed.indexOf("@")
  if (at === -1) return { id: null, endpoint: parseEndpoint(trimmed) }
  const idText = trimmed.slice(0, at)
  const endpointText = trimmed.slice(at + 1)
  if (!idText.toLowerCase().startsWith(ID_PREFIX) || endpointText.length === 0) {
    throw new Error(`expected host:port or relay:ID@host:port, got ${trimmed}`)
  }
  return { id: formatId(parseId(idText)), endpoint: parseEndpoint(endpointText) }
}

export function isIdentityPacket(packet: Uint8Array): boolean {
  const kind = identityKind(packet)
  return kind !== null && IDENTITY_KINDS.has(kind)
}

/** Versioned TSID header, or null when the packet is some other datagram. */
export function identityKind(packet: Uint8Array): number | null {
  if (packet.length < HEADER_LEN || !magicMatches(packet) || packet[4] !== PROTOCOL_VERSION) return null
  return packet[5] ?? null
}

export function writeIdentityHeader(out: Buffer, kind: number): void {
  writeHeader(out, kind)
}

export function signIdentity(identity: Identity, message: Uint8Array): Buffer {
  return sign(null, message, privateKeyFromSeed(identity.secret))
}

export function verifyIdentity(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== PUBLIC_KEY_LEN || signature.length !== SIGNATURE_LEN) return false
  try {
    return verify(null, message, publicKeyFromRaw(Buffer.from(publicKey)), signature)
  } catch {
    return false
  }
}

export function encodeQuery(challenge: Uint8Array): Buffer {
  if (challenge.length !== CHALLENGE_LEN) throw new Error("challenge must be 16 bytes")
  const out = Buffer.alloc(QUERY_LEN)
  writeHeader(out, KIND_QUERY)
  out.set(challenge, HEADER_LEN)
  return out
}

export function decodeQuery(packet: Uint8Array): Buffer | null {
  if (packet.length !== QUERY_LEN || !magicMatches(packet) || packet[4] !== PROTOCOL_VERSION) return null
  if (packet[5] !== KIND_QUERY) return null
  return Buffer.from(packet.subarray(HEADER_LEN))
}

export function encodeProof(identity: Identity, challenge: Uint8Array): Buffer {
  if (challenge.length !== CHALLENGE_LEN) throw new Error("challenge must be 16 bytes")
  const signature = sign(null, bindMessage(challenge, identity.publicKey), privateKeyFromSeed(identity.secret))
  const out = Buffer.alloc(PROOF_LEN)
  writeHeader(out, KIND_PROOF)
  out.set(challenge, HEADER_LEN)
  out.set(identity.publicKey, HEADER_LEN + CHALLENGE_LEN)
  out.set(signature, HEADER_LEN + CHALLENGE_LEN + PUBLIC_KEY_LEN)
  return out
}

export function decodeProof(packet: Uint8Array): Proof | null {
  if (packet.length !== PROOF_LEN || !magicMatches(packet) || packet[4] !== PROTOCOL_VERSION) return null
  if (packet[5] !== KIND_PROOF) return null
  const challengeAt = HEADER_LEN
  const publicAt = challengeAt + CHALLENGE_LEN
  const signatureAt = publicAt + PUBLIC_KEY_LEN
  return {
    challenge: Buffer.from(packet.subarray(challengeAt, publicAt)),
    publicKey: Buffer.from(packet.subarray(publicAt, signatureAt)),
    signature: Buffer.from(packet.subarray(signatureAt)),
  }
}

export function verifyProof(proof: Proof): boolean {
  if (
    proof.challenge.length !== CHALLENGE_LEN ||
    proof.publicKey.length !== PUBLIC_KEY_LEN ||
    proof.signature.length !== SIGNATURE_LEN
  ) {
    return false
  }
  try {
    return verify(null, bindMessage(proof.challenge, proof.publicKey), publicKeyFromRaw(proof.publicKey), proof.signature)
  } catch {
    return false
  }
}

export function base32Encode(data: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += alphabetAt((value >> bits) & 31)
    }
  }
  if (bits > 0) out += alphabetAt((value << (5 - bits)) & 31)
  return out
}

export function base32Decode(text: string): Buffer {
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of text) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error("relay id has a character base32 does not use")
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
    }
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) throw new Error("relay id is not canonical")
  return Buffer.from(bytes)
}

function identityFromSeed(seed: Buffer): Identity {
  const publicKey = rawPublicKey(createPublicKey(privateKeyFromSeed(seed)))
  return { id: formatId(publicKey), publicKey, secret: seed }
}

function privateKeyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  })
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  })
}

function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ type: "spki", format: "der" })
  if (!Buffer.isBuffer(der) || der.length !== SPKI_PREFIX.length + PUBLIC_KEY_LEN) {
    throw new Error("unexpected ed25519 public key encoding")
  }
  if (!der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) {
    throw new Error("unexpected ed25519 public key encoding")
  }
  return Buffer.from(der.subarray(SPKI_PREFIX.length))
}

function bindMessage(challenge: Uint8Array, publicKey: Uint8Array): Buffer {
  return Buffer.concat([DOMAIN, challenge, publicKey])
}

function writeHeader(out: Buffer, kind: number): void {
  out[0] = ID_MAGIC[0]
  out[1] = ID_MAGIC[1]
  out[2] = ID_MAGIC[2]
  out[3] = ID_MAGIC[3]
  out[4] = PROTOCOL_VERSION
  out[5] = kind
}

function magicMatches(packet: Uint8Array): boolean {
  return (
    packet[0] === ID_MAGIC[0] &&
    packet[1] === ID_MAGIC[1] &&
    packet[2] === ID_MAGIC[2] &&
    packet[3] === ID_MAGIC[3]
  )
}

function alphabetAt(index: number): string {
  const char = ALPHABET[index]
  if (char === undefined) throw new Error("base32 index out of range")
  return char
}
