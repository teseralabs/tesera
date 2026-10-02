import { assertCode } from "../constants.js"
import { gfMul, gfPow, invertMatrix } from "./gf256.js"

const CACHE = new Map<string, CodingMatrix>()

export class CodingMatrix {
  readonly rows: number[][]
  private readonly inverses = new Map<string, number[][]>()

  constructor(readonly k: number, readonly n: number) {
    assertCode(k, n)
    const vandermonde: number[][] = []
    for (let r = 0; r < n; r++) {
      const row: number[] = []
      for (let c = 0; c < k; c++) row.push(gfPow(r + 1, c))
      vandermonde.push(row)
    }
    const top = vandermonde.slice(0, k).map((row) => row.slice())
    const topInv = invertMatrix(top)
    this.rows = vandermonde.map((row) => {
      const out: number[] = []
      for (let c = 0; c < k; c++) {
        let sum = 0
        for (let t = 0; t < k; t++) sum ^= gfMul(row[t] ?? 0, topInv[t]?.[c] ?? 0)
        out.push(sum)
      }
      return out
    })
    for (let r = 0; r < k; r++) {
      for (let c = 0; c < k; c++) {
        const expected = r === c ? 1 : 0
        if (this.rows[r]?.[c] !== expected) {
          throw new Error("Reed-Solomon matrix was not systematic")
        }
      }
    }
  }

  inverseFor(indices: number[]): number[][] {
    const key = indices.join(",")
    const cached = this.inverses.get(key)
    if (cached) return cached
    const sub = indices.map((index) => {
      const row = this.rows[index]
      if (!row) throw new Error(`tessera index ${index} is outside the code`)
      return row.slice()
    })
    const inverse = invertMatrix(sub)
    this.inverses.set(key, inverse)
    return inverse
  }
}

export function getMatrix(k: number, n: number): CodingMatrix {
  const key = `${k}x${n}`
  const cached = CACHE.get(key)
  if (cached) return cached
  const created = new CodingMatrix(k, n)
  CACHE.set(key, created)
  return created
}

export function encodeShards(data: Uint8Array[], k: number, n: number): Uint8Array[] {
  if (data.length !== k) throw new Error(`expected ${k} data shards, got ${data.length}`)
  const first = data[0]
  if (!first) throw new Error("missing data shard")
  const shardLen = first.length
  for (const shard of data) {
    if (shard.length !== shardLen) throw new Error("data shards differ in length")
  }
  const matrix = getMatrix(k, n)
  const out: Uint8Array[] = data.map((shard) => Uint8Array.from(shard))
  for (let r = k; r < n; r++) {
    const row = matrix.rows[r]
    if (!row) throw new Error("missing coding row")
    const shard = new Uint8Array(shardLen)
    for (let c = 0; c < k; c++) {
      const factor = row[c] ?? 0
      if (factor === 0) continue
      const src = data[c]
      if (!src) throw new Error("missing data shard")
      if (factor === 1) {
        for (let b = 0; b < shardLen; b++) shard[b] = (shard[b] ?? 0) ^ (src[b] ?? 0)
      } else {
        for (let b = 0; b < shardLen; b++) shard[b] = (shard[b] ?? 0) ^ gfMul(factor, src[b] ?? 0)
      }
    }
    out.push(shard)
  }
  return out
}

export function decodeShards(
  parts: Array<{ index: number; data: Uint8Array }>,
  k: number,
  n: number,
): Uint8Array[] {
  if (parts.length < k) throw new Error(`need ${k} shards, got ${parts.length}`)
  const unique = new Map<number, Uint8Array>()
  for (const part of parts) {
    if (part.index < 0 || part.index >= n) throw new Error("tessera index out of range")
    if (!unique.has(part.index)) unique.set(part.index, part.data)
  }
  if (unique.size < k) throw new Error("not enough distinct shards")

  const systematic: Uint8Array[] = []
  let haveSystematic = true
  for (let i = 0; i < k; i++) {
    const shard = unique.get(i)
    if (!shard) {
      haveSystematic = false
      break
    }
    systematic.push(shard)
  }
  if (haveSystematic) return systematic.map((shard) => Uint8Array.from(shard))

  const chosen = [...unique.entries()].sort((a, b) => a[0] - b[0]).slice(0, k)
  const shardLen = chosen[0]?.[1].length
  if (shardLen === undefined) throw new Error("not enough distinct shards")
  for (const [, data] of chosen) {
    if (data.length !== shardLen) throw new Error("shard length mismatch")
  }
  const indices = chosen.map(([index]) => index)
  const inverse = getMatrix(k, n).inverseFor(indices)
  const out: Uint8Array[] = []
  for (let r = 0; r < k; r++) {
    const row = inverse[r]
    if (!row) throw new Error("missing inverse row")
    const shard = new Uint8Array(shardLen)
    for (let c = 0; c < k; c++) {
      const factor = row[c] ?? 0
      if (factor === 0) continue
      const src = chosen[c]?.[1]
      if (!src) throw new Error("missing shard")
      if (factor === 1) {
        for (let b = 0; b < shardLen; b++) shard[b] = (shard[b] ?? 0) ^ (src[b] ?? 0)
      } else {
        for (let b = 0; b < shardLen; b++) shard[b] = (shard[b] ?? 0) ^ gfMul(factor, src[b] ?? 0)
      }
    }
    out.push(shard)
  }
  return out
}

export function splitCiphertext(cipher: Uint8Array, k: number): Uint8Array[] {
  if (k < 1) throw new Error("k must be positive")
  const shardLen = Math.ceil(cipher.length / k)
  const padded = new Uint8Array(shardLen * k)
  padded.set(cipher)
  const shards: Uint8Array[] = []
  for (let i = 0; i < k; i++) {
    shards.push(padded.subarray(i * shardLen, (i + 1) * shardLen))
  }
  return shards
}

export function joinShards(dataShards: Uint8Array[], cipherLen: number): Uint8Array {
  const shardLen = dataShards[0]?.length
  if (shardLen === undefined) throw new Error("no shards")
  const padded = new Uint8Array(shardLen * dataShards.length)
  for (let i = 0; i < dataShards.length; i++) {
    const shard = dataShards[i]
    if (!shard || shard.length !== shardLen) throw new Error("shard length mismatch")
    padded.set(shard, i * shardLen)
  }
  if (cipherLen > padded.length) throw new Error("cipher length exceeds reconstructed bytes")
  return padded.subarray(0, cipherLen)
}
