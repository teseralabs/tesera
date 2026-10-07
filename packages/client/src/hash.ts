import { sha256 } from "@noble/hashes/sha2.js"

/**
 * SHA-256 over the bytes in order, a chunk at a time, so nothing is retained to hash at the end.
 * This is an application-level digest of the whole stream. Tesera's own integrity is per block:
 * each block is authenticated on its own and in order, and a stream only ends at its final block.
 */
export function streamHash(): { update(chunk: Uint8Array): void; hex(): string } {
  const hash = sha256.create()
  return {
    update: (chunk) => {
      hash.update(chunk)
    },
    hex: () => {
      let out = ""
      for (const byte of hash.digest()) out += byte.toString(16).padStart(2, "0")
      return out
    },
  }
}
