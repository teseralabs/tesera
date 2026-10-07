import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto"

// The only module in the sender and receiver's path that reaches Node's crypto.
// Another runtime replaces this file. Calls stay synchronous, which rules out
// WebCrypto: it has no ChaCha20-Poly1305 and every call returns a promise.

export function randomBytes(length: number): Buffer {
  return nodeRandomBytes(length)
}

export function hkdfSha256(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, salt, info, length))
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest()
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

/** ChaCha20-Poly1305. Returns the ciphertext followed by the tag. */
export function chachaSeal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array, tagLength: number): Buffer {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: tagLength })
  cipher.setAAD(aad, { plaintextLength: plain.length })
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
}

/** Throws when the tag doesn't match. */
export function chachaOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array, tagLength: number): Buffer {
  const tag = sealed.subarray(sealed.length - tagLength)
  const data = sealed.subarray(0, sealed.length - tagLength)
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: tagLength })
  decipher.setAuthTag(tag)
  decipher.setAAD(aad, { plaintextLength: data.length })
  return Buffer.concat([decipher.update(data), decipher.final()])
}
