// The client's src/crypto/primitives.ts: the same functions, algorithms and outputs, without node:crypto.
// Web Crypto has no ChaCha20-Poly1305 and answers only with promises, and tesera's session code is
// synchronous, so this uses @noble, which is audited and has no dependencies of its own.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js"
import { equalBytes } from "@noble/ciphers/utils.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import type * as Native from "../../../../src/crypto/primitives.js"

const POLY1305_TAG = 16
/** getRandomValues fills at most this many bytes per call. */
const RANDOM_CHUNK = 65536

export function randomBytes(length: number): Buffer {
  const out = Buffer.alloc(length)
  for (let at = 0; at < length; at += RANDOM_CHUNK) {
    globalThis.crypto.getRandomValues(out.subarray(at, Math.min(length, at + RANDOM_CHUNK)))
  }
  return out
}

export function hkdfSha256(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Buffer {
  return Buffer.from(hkdf(sha256, secret, salt, info, length))
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Buffer {
  return Buffer.from(hmac(sha256, key, data))
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && equalBytes(a, b)
}

/** ChaCha20-Poly1305. Returns the ciphertext followed by the tag. */
export function chachaSeal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array, tagLength: number): Buffer {
  if (tagLength !== POLY1305_TAG) throw new Error("ChaCha20-Poly1305 tag must be 16 bytes")
  return Buffer.from(chacha20poly1305(key, nonce, aad).encrypt(plain))
}

/** Throws when the tag doesn't match. */
export function chachaOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array, tagLength: number): Buffer {
  if (tagLength !== POLY1305_TAG) throw new Error("ChaCha20-Poly1305 tag must be 16 bytes")
  return Buffer.from(chacha20poly1305(key, nonce, aad).decrypt(sealed))
}

// Fails to type-check if this file stops matching the native primitives it replaces.
type Matches<T extends typeof Native> = T
export type PrimitivesMatchNative = Matches<typeof import("./primitives.js")>
