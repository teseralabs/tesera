const TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let bit = 0; bit < 8; bit++) {
    c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  }
  TABLE[i] = c >>> 0
}

/** IEEE CRC-32. Detects accidental datagram damage; it is not an authenticator. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0
    c = (TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}
