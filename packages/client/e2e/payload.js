// A deterministic byte stream from a seed, the same in the browser and in Node, so the harness can
// know the expected bytes and digest of a transfer without the page ever sending it the file.
// xorshift128: fast, and not meant to be secure.

export function payload(seed, size) {
  let x = seed >>> 0 || 1
  let y = 362436069
  let z = 521288629
  let w = 88675123
  let left = size
  return {
    /** The next `max` bytes or fewer, or null at the end. `max` must be a multiple of 4. */
    next(max) {
      if (left <= 0) return null
      const length = Math.min(max, left)
      const words = new Uint32Array(Math.ceil(length / 4))
      for (let i = 0; i < words.length; i++) {
        const t = x ^ (x << 11)
        x = y
        y = z
        z = w
        w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0
        words[i] = w
      }
      left -= length
      return new Uint8Array(words.buffer, 0, length)
    },
  }
}
