import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import { decodeShards, encodeShards, joinShards, splitCiphertext } from "../src/coding/reedsolomon.js"
import { blockAad, deriveKeys, open, seal, sealedLength } from "../src/crypto/session.js"
import { encodeAck } from "../src/protocol/frames.js"

type VectorFile = {
  inputs: {
    sessionSecret: string
    sessionId: string
    otherSessionId: string
    blockId: number
    k: number
    n: number
    fin: boolean
    sentAtMs: number
    plaintext: string
  }
  expected: {
    aeadKey: string
    macKey: string
    otherAeadKey: string
    otherMacKey: string
    aad: string
    ciphertext: string
    ackFrame: string
    controlMac: string
  }
}

describe("v2 protocol vectors", () => {
  it("matches the fixed hkdf, aad, ciphertext, and control mac", async () => {
    const file = JSON.parse(
      await readFile(new URL("../../test/vectors/v2.json", import.meta.url), "utf8"),
    ) as VectorFile
    const secret = Buffer.from(file.inputs.sessionSecret, "hex")
    const sessionId = Buffer.from(file.inputs.sessionId, "hex")
    const otherId = Buffer.from(file.inputs.otherSessionId, "hex")
    const body = Buffer.from(file.inputs.plaintext, "hex")
    const keys = deriveKeys(secret, sessionId)
    const other = deriveKeys(secret, otherId)
    assert.equal(keys.aeadKey.toString("hex"), file.expected.aeadKey)
    assert.equal(keys.macKey.toString("hex"), file.expected.macKey)
    assert.equal(other.aeadKey.toString("hex"), file.expected.otherAeadKey)
    assert.equal(other.macKey.toString("hex"), file.expected.otherMacKey)
    assert.notDeepEqual(keys.aeadKey, other.aeadKey)
    assert.notDeepEqual(keys.macKey, other.macKey)
    assert.notDeepEqual(keys.aeadKey, keys.macKey)

    const cipherLen = sealedLength(body.length)
    const shardLen = Math.ceil(cipherLen / file.inputs.k)
    const aad = blockAad({
      sessionId,
      blockId: file.inputs.blockId,
      k: file.inputs.k,
      n: file.inputs.n,
      cipherLen,
      shardLen,
    })
    assert.equal(aad.toString("hex"), file.expected.aad)
    const cipher = seal(keys.aeadKey, file.inputs.blockId, file.inputs.fin, body, file.inputs.sentAtMs, aad)
    assert.equal(cipher.toString("hex"), file.expected.ciphertext)
    assert.deepEqual(open(keys.aeadKey, file.inputs.blockId, cipher, aad).body, body)
    assert.throws(() => open(other.aeadKey, file.inputs.blockId, cipher, aad))
    assert.throws(() => open(keys.macKey, file.inputs.blockId, cipher, aad))
    const ctx = {
      sessionId,
      blockId: file.inputs.blockId,
      k: file.inputs.k,
      n: file.inputs.n,
      cipherLen,
      shardLen,
    }
    const changed = [
      { ...ctx, blockId: ctx.blockId + 1 },
      { ...ctx, k: 1 },
      { ...ctx, n: 4 },
      { ...ctx, cipherLen: ctx.cipherLen + 1 },
      { ...ctx, shardLen: ctx.shardLen + 1 },
      { ...ctx, sessionId: otherId },
    ]
    for (const next of changed) {
      assert.throws(() => open(keys.aeadKey, next.blockId, cipher, blockAad(next)))
    }
    const version = Buffer.from(aad)
    version[0] = (version[0] ?? 0) ^ 0xff
    assert.throws(() => open(keys.aeadKey, file.inputs.blockId, cipher, version))
    const frameType = Buffer.from(aad)
    frameType[1] = (frameType[1] ?? 0) ^ 0xff
    assert.throws(() => open(keys.aeadKey, file.inputs.blockId, cipher, frameType))

    const ack = encodeAck({ kind: "ack", sessionId, blockId: file.inputs.blockId }, keys.macKey)
    assert.equal(ack.toString("hex"), file.expected.ackFrame)
    assert.equal(ack.subarray(ack.length - 16).toString("hex"), file.expected.controlMac)
    const wrong = encodeAck({ kind: "ack", sessionId, blockId: file.inputs.blockId }, other.macKey)
    assert.notEqual(wrong.toString("hex"), file.expected.ackFrame)
    const underAead = encodeAck({ kind: "ack", sessionId, blockId: file.inputs.blockId }, keys.aeadKey)
    assert.notEqual(underAead.toString("hex"), file.expected.ackFrame)
  })

  it("rejects a block whose tessera index was swapped", () => {
    const secret = Buffer.from("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "hex")
    const sessionId = Buffer.from("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf", "hex")
    const body = Buffer.from("plaintext-ok")
    const blockId = 3
    const k = 2
    const n = 2
    const keys = deriveKeys(secret, sessionId)
    const cipherLen = sealedLength(body.length)
    const shardLen = Math.ceil(cipherLen / k)
    const aad = blockAad({ sessionId, blockId, k, n, cipherLen, shardLen })
    const cipher = seal(keys.aeadKey, blockId, true, body, 1_000, aad)
    const shards = encodeShards(splitCiphertext(cipher, k), k, n)
    const swapped = decodeShards(
      [
        { index: 1, data: shards[0] ?? Buffer.alloc(0) },
        { index: 0, data: shards[1] ?? Buffer.alloc(0) },
      ],
      k,
      n,
    )
    const joined = joinShards(swapped, cipherLen)
    assert.notDeepEqual(Buffer.from(joined), cipher)
    assert.throws(() => open(keys.aeadKey, blockId, joined, aad))
    assert.deepEqual(open(keys.aeadKey, blockId, cipher, aad).body, body)
  })
})
