import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { crc32 } from "../src/protocol/crc32.js"
import { encodeEnvelope, decodeEnvelope } from "../src/protocol/envelope.js"
import { decodeFrame, encodeAck, encodeData, encodeNack, encodeSample } from "../src/protocol/frames.js"
import { blockAad, formatSession, open, parseSession, seal, sealedLength } from "../src/crypto/session.js"

describe("frames", () => {
  it("uses the standard CRC-32 check value", () => {
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926)
  })

  it("round-trips data frames and rejects damage", () => {
    const frame = encodeData({
      kind: "data",
      sessionId: randomBytes(16),
      blockId: 4,
      tesseraIndex: 1,
      k: 2,
      n: 3,
      cipherLen: 16,
      payload: randomBytes(8),
    })
    const key = randomBytes(32)
    const decoded = decodeFrame(frame, key)
    assert.equal(decoded?.kind, "data")
    if (decoded?.kind !== "data") return
    assert.equal(decoded.blockId, 4)
    assert.equal(decoded.tesseraIndex, 1)
    assert.equal(decoded.cipherLen, 16)
    const damaged = Buffer.from(frame)
    damaged[30] = (damaged[30] ?? 0) ^ 0xff
    assert.equal(decodeFrame(damaged, key), null)
  })

  it("authenticates ack and nack frames", () => {
    const key = randomBytes(32)
    const sessionId = randomBytes(16)
    const ack = encodeAck({ kind: "ack", sessionId, blockId: 9 }, key)
    const decodedAck = decodeFrame(ack, key)
    assert.deepEqual(decodedAck, { kind: "ack", sessionId, blockId: 9 })
    assert.equal(decodeFrame(ack, randomBytes(32)), null)

    const nack = encodeNack({ kind: "nack", sessionId, blockId: 3, missing: [0, 2] }, key)
    assert.deepEqual(decodeFrame(nack, key), { kind: "nack", sessionId, blockId: 3, missing: [0, 2] })
    const sample = encodeSample({ kind: "sample", sessionId, blockId: 3, tesseraIndex: 1 }, key)
    assert.deepEqual(decodeFrame(sample, key), { kind: "sample", sessionId, blockId: 3, tesseraIndex: 1 })
    assert.equal(decodeFrame(sample, randomBytes(32)), null)
    const flipped = Buffer.from(nack)
    flipped[18] = (flipped[18] ?? 0) ^ 0xff
    assert.equal(decodeFrame(flipped, key), null)
  })

  it("round-trips relay envelopes", () => {
    const inner = Buffer.from("tessera")
    const packet = encodeEnvelope({ host: "127.0.0.1", port: 4000 }, inner)
    const decoded = decodeEnvelope(packet)
    assert.deepEqual(decoded?.dest, { host: "127.0.0.1", port: 4000 })
    assert.deepEqual(decoded?.inner, inner)
    assert.equal(decodeEnvelope(Buffer.from("nope")), null)
  })

  it("parses a session label and rejects a bare secret", () => {
    const raw = randomBytes(32)
    const text = formatSession(raw)
    assert.equal(text, `session:${raw.toString("hex")}`)
    assert.deepEqual(parseSession(text.toUpperCase()), raw)
    assert.throws(() => parseSession(raw.toString("hex")))
    assert.throws(() => parseSession("session:abcd"))
  })

  it("rejects a block id mismatch and a bad key", () => {
    const key = randomBytes(32)
    const body = Buffer.from("abc")
    const sessionId = randomBytes(16)
    const cipherLen = sealedLength(body.length)
    const aad = blockAad({ sessionId, blockId: 3, k: 1, n: 1, cipherLen, shardLen: cipherLen })
    const cipher = seal(key, 3, false, body, 50, aad)
    assert.deepEqual(open(key, 3, cipher, aad).body, body)
    assert.throws(() => open(key, 4, cipher, aad))
    assert.throws(() => open(randomBytes(32), 3, cipher, aad))
  })
})
