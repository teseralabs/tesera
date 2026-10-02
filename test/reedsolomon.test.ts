import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { gfInv, gfMul, gfPow, invertMatrix } from "../src/coding/gf256.js"
import { decodeShards, encodeShards, joinShards, splitCiphertext } from "../src/coding/reedsolomon.js"
import { blockAad, open, seal, sealedLength } from "../src/crypto/session.js"

function combinations(n: number, k: number): number[][] {
  const out: number[][] = []
  const walk = (start: number, acc: number[]): void => {
    if (acc.length === k) {
      out.push([...acc])
      return
    }
    for (let i = start; i < n; i++) {
      acc.push(i)
      walk(i + 1, acc)
      acc.pop()
    }
  }
  walk(0, [])
  return out
}

function roundTrip(k: number, n: number, shardLen: number): void {
  const data = Array.from({ length: k }, () => randomBytes(shardLen))
  const encoded = encodeShards(data, k, n)
  assert.equal(encoded.length, n)
  for (let i = 0; i < k; i++) {
    assert.deepEqual(Buffer.from(encoded[i] ?? Buffer.alloc(0)), Buffer.from(data[i] ?? Buffer.alloc(0)))
  }
  for (const subset of combinations(n, k)) {
    const parts = subset.map((index) => {
      const shard = encoded[index]
      if (!shard) throw new Error("missing shard")
      return { index, data: shard }
    })
    const decoded = decodeShards(parts, k, n)
    for (let i = 0; i < k; i++) {
      assert.deepEqual(Buffer.from(decoded[i] ?? Buffer.alloc(0)), Buffer.from(data[i] ?? Buffer.alloc(0)))
    }
  }
}

describe("gf256", () => {
  it("matches the AES field", () => {
    assert.equal(gfPow(2, 8), 0x1d)
    for (let a = 1; a < 256; a++) assert.equal(gfMul(a, gfInv(a)), 1)
    assert.equal(gfMul(0, 5), 0)
    assert.equal(gfPow(0, 0), 1)
    assert.throws(() => invertMatrix([[0]]))
  })
})

describe("reed-solomon", () => {
  it("reconstructs every k-subset", () => {
    roundTrip(1, 1, 32)
    roundTrip(1, 3, 16)
    roundTrip(2, 3, 64)
    roundTrip(2, 3, 1024)
    roundTrip(3, 5, 48)
    roundTrip(4, 6, 24)
  })

  it("keeps AEAD intact when any sufficient subset survives", () => {
    const key = randomBytes(32)
    const body = randomBytes(100)
    const sessionId = randomBytes(16)
    const cipherLen = sealedLength(body.length)
    const shardLen = Math.ceil(cipherLen / 2)
    const aad = blockAad({ sessionId, blockId: 7, k: 2, n: 3, cipherLen, shardLen })
    const cipher = seal(key, 7, true, body, 1234, aad)
    const encoded = encodeShards(splitCiphertext(cipher, 2), 2, 3)
    const decoded = decodeShards(
      [
        { index: 1, data: encoded[1] ?? Buffer.alloc(0) },
        { index: 2, data: encoded[2] ?? Buffer.alloc(0) },
      ],
      2,
      3,
    )
    const restored = joinShards(decoded, cipher.length)
    const opened = open(key, 7, restored, aad)
    assert.equal(opened.fin, true)
    assert.equal(opened.sentAtMs, 1234)
    assert.deepEqual(opened.body, body)

    const bad = Uint8Array.from(encoded[0] ?? Buffer.alloc(0))
    bad[0] = (bad[0] ?? 0) ^ 0xff
    const garbage = joinShards(
      decodeShards(
        [
          { index: 0, data: bad },
          { index: 1, data: encoded[1] ?? Buffer.alloc(0) },
        ],
        2,
        3,
      ),
      cipher.length,
    )
    assert.throws(() => open(key, 7, garbage, aad))
  })
})
