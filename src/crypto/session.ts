import { createCipheriv, createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from "node:crypto"
import { FRAME_DATA, INNER_HEADER_LEN, MAC_LEN, PROTOCOL_VERSION, SESSION_ID_LEN, TAG_LEN } from "../constants.js"

export const SESSION_PREFIX = "session:"

/** version, frame type, session id, block id, k, n, cipher length, shard length. */
export const BLOCK_AAD_LEN = 28

const AEAD_INFO = Buffer.from("tesera-aead-v2")
const MAC_INFO = Buffer.from("tesera-mac-v2")

export type TrafficKeys = {
  aeadKey: Buffer
  macKey: Buffer
}

export type BlockContext = {
  sessionId: Uint8Array
  blockId: number
  k: number
  n: number
  cipherLen: number
  shardLen: number
}

export function assertSession(session: Uint8Array): void {
  if (session.length !== 32) throw new Error("session must be 32 bytes")
}

export function formatSession(session: Uint8Array): string {
  assertSession(session)
  return SESSION_PREFIX + Buffer.from(session).toString("hex")
}

export function parseSession(value: string): Buffer {
  const trimmed = value.trim().toLowerCase()
  const hex = trimmed.startsWith(SESSION_PREFIX) ? trimmed.slice(SESSION_PREFIX.length) : ""
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("session must be session: and 64 hex characters (generate one with: tesera session)")
  }
  return Buffer.from(hex, "hex")
}

/**
 * One sender's keys. The full session id is the HKDF salt. The info string
 * keeps the block key and the control key apart. The ChaCha nonce stays an
 * 8-byte zero prefix plus the block id, so uniqueness follows from this key.
 */
export function deriveKeys(secret: Uint8Array, sessionId: Uint8Array): TrafficKeys {
  assertSession(secret)
  if (sessionId.length !== SESSION_ID_LEN) throw new Error("session id must be 16 bytes")
  return {
    aeadKey: Buffer.from(hkdfSync("sha256", secret, sessionId, AEAD_INFO, 32)),
    macKey: Buffer.from(hkdfSync("sha256", secret, sessionId, MAC_INFO, 32)),
  }
}

export function sealedLength(bodyLength: number): number {
  if (!Number.isInteger(bodyLength) || bodyLength < 0) throw new Error("body length must be a non-negative integer")
  return INNER_HEADER_LEN + bodyLength + TAG_LEN
}

/**
 * Fields that stay the same on every tessera of a block. The tessera index is
 * not one of them: one tag covers the joined ciphertext, and a shard moved to
 * another index reconstructs different bytes.
 */
export function blockAad(ctx: BlockContext): Buffer {
  if (ctx.sessionId.length !== SESSION_ID_LEN) throw new Error("session id must be 16 bytes")
  if (!Number.isInteger(ctx.blockId) || ctx.blockId < 0 || ctx.blockId > 0xffffffff) {
    throw new Error("block id does not fit in a u32")
  }
  if (!Number.isInteger(ctx.k) || ctx.k < 1 || ctx.k > 0xff) throw new Error("k does not fit in the header")
  if (!Number.isInteger(ctx.n) || ctx.n < 1 || ctx.n > 0xff) throw new Error("n does not fit in the header")
  if (!Number.isInteger(ctx.cipherLen) || ctx.cipherLen < 1 || ctx.cipherLen > 0xffff) {
    throw new Error("cipher length does not fit in the header")
  }
  if (!Number.isInteger(ctx.shardLen) || ctx.shardLen < 1 || ctx.shardLen > 0xffff) {
    throw new Error("shard length does not fit in the header")
  }
  const out = Buffer.alloc(BLOCK_AAD_LEN)
  out[0] = PROTOCOL_VERSION
  out[1] = FRAME_DATA
  out.set(ctx.sessionId, 2)
  out.writeUInt32BE(ctx.blockId, 18)
  out[22] = ctx.k
  out[23] = ctx.n
  out.writeUInt16BE(ctx.cipherLen, 24)
  out.writeUInt16BE(ctx.shardLen, 26)
  return out
}

export function mac16(key: Uint8Array, data: Uint8Array): Buffer {
  assertSession(key)
  return createHmac("sha256", key).update(data).digest().subarray(0, MAC_LEN)
}

export function macMatches(key: Uint8Array, data: Uint8Array, mac: Uint8Array): boolean {
  const expected = mac16(key, data)
  if (mac.length !== expected.length) return false
  return timingSafeEqual(expected, mac)
}

function nonceFor(blockId: number): Buffer {
  if (!Number.isInteger(blockId) || blockId < 0 || blockId > 0xffffffff) {
    throw new Error(`block id ${blockId} does not fit in a 12-byte ChaCha nonce`)
  }
  const nonce = Buffer.alloc(12)
  nonce.writeUInt32BE(blockId, 8)
  return nonce
}

function assertAad(aad: Uint8Array): void {
  if (aad.length !== BLOCK_AAD_LEN) throw new Error("block associated data is the wrong length")
}

/**
 * Encrypt one plaintext body. The nonce is a fixed prefix plus the block id.
 * Callers use a key from `deriveKeys`, so the same block id under another
 * session id is a different key.
 */
export function seal(
  aeadKey: Uint8Array,
  blockId: number,
  fin: boolean,
  body: Uint8Array,
  sentAtMs: number,
  aad: Uint8Array,
): Buffer {
  assertSession(aeadKey)
  assertAad(aad)
  const plain = Buffer.alloc(INNER_HEADER_LEN + body.length)
  plain[0] = fin ? 1 : 0
  plain.writeBigUInt64BE(BigInt(sentAtMs), 1)
  plain.set(body, INNER_HEADER_LEN)
  const cipher = createCipheriv("chacha20-poly1305", aeadKey, nonceFor(blockId), { authTagLength: TAG_LEN })
  cipher.setAAD(aad, { plaintextLength: plain.length })
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  return encrypted
}

export function open(
  aeadKey: Uint8Array,
  blockId: number,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): { fin: boolean; body: Buffer; sentAtMs: number } {
  assertSession(aeadKey)
  assertAad(aad)
  if (ciphertext.length < TAG_LEN + INNER_HEADER_LEN) {
    throw new Error("ciphertext too short")
  }
  const tag = ciphertext.subarray(ciphertext.length - TAG_LEN)
  const data = ciphertext.subarray(0, ciphertext.length - TAG_LEN)
  const decipher = createDecipheriv("chacha20-poly1305", aeadKey, nonceFor(blockId), {
    authTagLength: TAG_LEN,
  })
  decipher.setAuthTag(tag)
  decipher.setAAD(aad, { plaintextLength: data.length })
  const plain = Buffer.concat([decipher.update(data), decipher.final()])
  const sentAtMs = Number(plain.readBigUInt64BE(1))
  return {
    fin: ((plain[0] ?? 0) & 1) === 1,
    body: Buffer.from(plain.subarray(INNER_HEADER_LEN)),
    sentAtMs,
  }
}
