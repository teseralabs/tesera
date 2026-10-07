// Per-block costs of tesera's data path at the browser's parameters: k=2, n=3, a 973-byte shard,
// a 1921-byte block body. bench/build.mjs compiles this twice, once against node:crypto and once
// with the client's runtime (@noble and the Buffer polyfill), so the two can be compared.
import { decodeShards, encodeShards, joinShards, splitCiphertext } from "../../../src/coding/reedsolomon.js"
import { fullBlockBodySize } from "../../../src/constants.js"
import { blockAad, deriveKeys, mac16, open, seal, sealedLength } from "../../../src/crypto/session.js"
import { encodeEnvelope } from "../../../src/protocol/envelope.js"
import { decodeFrame, encodeAck, encodeData, encodeSample } from "../../../src/protocol/frames.js"

const K = 2
const N = 3
const SHARD = 973
const BODY = fullBlockBodySize(K, SHARD)

type Result = { name: string; perOpUs: number; opsPerSec: number; mbPerSec?: number }

function time(name: string, bytes: number, fn: (i: number) => void, minMs = 400): Result {
  for (let i = 0; i < 200; i++) fn(i)
  let ops = 0
  const started = performance.now()
  let now = started
  while (now - started < minMs) {
    for (let i = 0; i < 100; i++) fn(ops + i)
    ops += 100
    now = performance.now()
  }
  const perOpUs = ((now - started) * 1000) / ops
  const result: Result = { name, perOpUs: round(perOpUs), opsPerSec: Math.round(1e6 / perOpUs) }
  if (bytes > 0) result.mbPerSec = round(bytes / perOpUs)
  return result
}

const round = (value: number) => Math.round(value * 100) / 100

export function run(): { body: number; results: Result[] } {
  const secret = new Uint8Array(32).fill(7)
  const sessionId = Buffer.alloc(16, 3)
  const { aeadKey, macKey } = deriveKeys(secret, sessionId)
  const body = new Uint8Array(BODY)
  for (let i = 0; i < body.length; i++) body[i] = (i * 31) & 0xff
  const cipherLen = sealedLength(BODY)
  const shardLen = Math.ceil(cipherLen / K)
  const aad = (blockId: number) => blockAad({ sessionId, blockId, k: K, n: N, cipherLen, shardLen })
  const sealed = seal(aeadKey, 1, false, body, Date.now(), aad(1))
  const shards = encodeShards(splitCiphertext(sealed, K), K, N)
  const frames = shards.map((shard, index) =>
    encodeData({ kind: "data", sessionId, blockId: 1, tesseraIndex: index, k: K, n: N, cipherLen, payload: Buffer.from(shard) }),
  )
  const dest = { host: "127.0.0.1", port: 4242 }
  const ack = encodeAck({ kind: "ack", sessionId, blockId: 1 }, macKey)
  const sample = encodeSample({ kind: "sample", sessionId, blockId: 1, tesseraIndex: 0 }, macKey)
  const results: Result[] = []

  results.push(time("seal (ChaCha20-Poly1305, 1921 B body)", BODY, (i) => void seal(aeadKey, i, false, body, 0, aad(i))))
  results.push(time("open (ChaCha20-Poly1305, 1921 B body)", BODY, () => void open(aeadKey, 1, sealed, aad(1))))
  results.push(time("mac16 (HMAC-SHA256, 22 B control frame)", 0, () => void mac16(macKey, ack.subarray(0, 22))))
  results.push(time("encode 2-of-3 (one parity shard)", BODY, () => void encodeShards(splitCiphertext(sealed, K), K, N)))
  results.push(time("decode 2-of-3, both data shards", BODY, () => void joinShards(decodeShards([{ index: 0, data: shards[0]! }, { index: 1, data: shards[1]! }], K, N), cipherLen)))
  results.push(time("decode 2-of-3, data 0 + parity", BODY, () => void joinShards(decodeShards([{ index: 0, data: shards[0]! }, { index: 2, data: shards[2]! }], K, N), cipherLen)))
  results.push(time("encodeData + envelope (one tessera)", SHARD, (i) => void encodeEnvelope(dest, encodeData({ kind: "data", sessionId, blockId: i, tesseraIndex: 0, k: K, n: N, cipherLen, payload: Buffer.from(shards[0]!) }))))
  results.push(time("decodeFrame DATA (CRC32)", SHARD, () => void decodeFrame(frames[0]!, macKey)))
  results.push(time("encodeAck (MAC)", 0, (i) => void encodeAck({ kind: "ack", sessionId, blockId: i }, macKey)))
  results.push(time("decodeFrame ACK (MAC verify)", 0, () => void decodeFrame(ack, macKey)))
  results.push(time("decodeFrame SAMPLE (MAC verify)", 0, () => void decodeFrame(sample, macKey)))
  results.push(
    time("sender block: seal + encode + 3 frames + 3 envelopes", BODY, (i) => {
      const c = seal(aeadKey, i, false, body, 0, aad(i))
      const s = encodeShards(splitCiphertext(c, K), K, N)
      for (let t = 0; t < N; t++) encodeEnvelope(dest, encodeData({ kind: "data", sessionId, blockId: i, tesseraIndex: t, k: K, n: N, cipherLen, payload: Buffer.from(s[t]!) }))
    }),
  )
  results.push(
    time("receiver block: 2 DATA decodes + decode + open + 2 SAMPLE + 1 ACK", BODY, () => {
      const a = decodeFrame(frames[0]!, null)
      const b = decodeFrame(frames[1]!, null)
      if (!a || !b || a.kind !== "data" || b.kind !== "data") throw new Error("bad frame")
      const cipher = joinShards(decodeShards([{ index: 0, data: a.payload }, { index: 1, data: b.payload }], K, N), cipherLen)
      open(aeadKey, 1, cipher, aad(1))
      encodeEnvelope(dest, encodeSample({ kind: "sample", sessionId, blockId: 1, tesseraIndex: 0 }, macKey))
      encodeEnvelope(dest, encodeSample({ kind: "sample", sessionId, blockId: 1, tesseraIndex: 1 }, macKey))
      const frame = encodeAck({ kind: "ack", sessionId, blockId: 1 }, macKey)
      for (let r = 0; r < 3; r++) encodeEnvelope(dest, frame)
    }),
  )
  results.push(
    time("sender control: 2 SAMPLE + 3 ACK verifies", 0, () => {
      decodeFrame(sample, macKey)
      decodeFrame(sample, macKey)
      decodeFrame(ack, macKey)
      decodeFrame(ack, macKey)
      decodeFrame(ack, macKey)
    }),
  )
  return { body: BODY, results }
}
