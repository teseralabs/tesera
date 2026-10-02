import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  CRC_LEN,
  DATA_HEADER_LEN,
  ENVELOPE_LEN,
  FRAME_ACK,
  FRAME_DATA,
  FRAME_NACK,
  FRAME_SAMPLE,
  MAX_FORWARD_DATAGRAM,
  MAX_N,
  MAX_SHARD,
  PROTOCOL_VERSION,
} from "../src/constants.js"
import { mac16 } from "../src/crypto/session.js"
import {
  decodeProof,
  decodeQuery,
  encodeProof,
  encodeQuery,
  generateIdentity,
  isIdentityPacket,
  verifyProof,
} from "../src/identity/id.js"
import {
  decodeAgain,
  decodeLookup,
  decodeResume,
  decodeTable,
  encodeAgain,
  encodeJoin,
  encodeLookup,
  encodeResume,
  encodeTable,
  isJoin,
} from "../src/identity/peers.js"
import { decodeRecord, encodeRecord, encodeRecordAsk, isRecordAsk, officialClaims } from "../src/identity/record.js"
import { decodeSnapshot, decodeSnapshotQuery, decodeUsage, encodeSnapshot, encodeSnapshotQuery, encodeUsage } from "../src/identity/stats.js"
import { crc32 } from "../src/protocol/crc32.js"
import { decodeEnvelope, encodeEnvelope } from "../src/protocol/envelope.js"
import { decodeFrame, encodeAck, encodeNack, encodeSample } from "../src/protocol/frames.js"
import { isStructuralTesera } from "../src/relay/structural.js"

const sessionId = Buffer.alloc(16, 0x11)
const key = Buffer.alloc(32, 0x22)

describe("network parsers", () => {
  it("rejects empty input, truncation, and unknown versions without throwing", () => {
    const samples = validPackets()
    const junk = [Buffer.alloc(0), Buffer.alloc(1), Buffer.alloc(5), Buffer.from("TESR"), Buffer.from("TSID")]
    for (const packet of [...junk, ...samples]) {
      for (let length = 0; length < packet.length; length++) quiet(packet.subarray(0, length))
      quiet(packet)
    }
    const huge = Buffer.alloc(65535, 0xff)
    for (const length of [0, 1, 6, 11, 22, 38, 1144, 1145, huge.length]) quiet(huge.subarray(0, length))
    for (const packet of randomPackets(160, 0x5eed)) quiet(packet)
  })

  it("rejects a data frame at each coding and length boundary", () => {
    const fit = dataFrame({ payload: Buffer.alloc(MAX_SHARD), cipherLen: MAX_SHARD })
    assert.equal(fit.length, MAX_FORWARD_DATAGRAM - ENVELOPE_LEN)
    assert.equal(decodeFrame(fit, null)?.kind, "data")
    assert.equal(decodeFrame(dataFrame({ payload: Buffer.alloc(MAX_SHARD + 1), cipherLen: 1 }), null), null)
    assert.equal(decodeFrame(dataFrame({ payload: Buffer.alloc(0), cipherLen: 1 }), null), null)
    assert.equal(decodeFrame(dataFrame({ cipherLen: 0 }), null), null)
    assert.equal(decodeFrame(dataFrame({ cipherLen: 5 }), null), null)
    assert.equal(decodeFrame(dataFrame({ cipherLen: 0xffff }), null), null)
    assert.equal(decodeFrame(dataFrame({ k: 0 }), null), null)
    assert.equal(decodeFrame(dataFrame({ n: 0 }), null), null)
    assert.equal(decodeFrame(dataFrame({ k: 2, n: 1 }), null), null)
    assert.equal(decodeFrame(dataFrame({ k: 255, n: 255 }), null), null)
    assert.equal(decodeFrame(dataFrame({ n: MAX_N + 1 }), null), null)
    assert.equal(decodeFrame(dataFrame({ n: MAX_N, tesseraIndex: MAX_N }), null), null)
    assert.equal(decodeFrame(dataFrame({ tesseraIndex: 255 }), null), null)
    assert.equal(decodeFrame(dataFrame({ n: MAX_N, tesseraIndex: MAX_N - 1, k: 1 }), null)?.kind, "data")
    assert.equal(decodeFrame(dataFrame({ blockId: 0xffffffff }), null)?.kind, "data")
    assert.equal(decodeFrame(dataFrame({ version: 0 }), null), null)
    assert.equal(decodeFrame(dataFrame({ version: 1 }), null), null)
    assert.equal(decodeFrame(dataFrame({ version: 255 }), null), null)
    assert.equal(decodeFrame(dataFrame({ type: 0 }), null), null)
    assert.equal(decodeFrame(dataFrame({ type: 9 }), null), null)

    const honest = dataFrame({})
    for (let i = 0; i < honest.length; i++) {
      const flipped = Buffer.from(honest)
      flipped[i] = (flipped[i] ?? 0) ^ 0xff
      assert.equal(decodeFrame(flipped, key), null)
    }
    const declared = Buffer.from(honest)
    declared.writeUInt16BE(8, 27)
    declared.writeUInt32BE(crc32(declared.subarray(0, declared.length - CRC_LEN)), declared.length - CRC_LEN)
    assert.equal(decodeFrame(declared, null), null)
  })

  it("rejects a control frame with a bad mac, length, or type", () => {
    const ack = encodeAck({ kind: "ack", sessionId, blockId: 4 }, key)
    const nack = encodeNack({ kind: "nack", sessionId, blockId: 4, missing: [0, 1] }, key)
    const sample = encodeSample({ kind: "sample", sessionId, blockId: 4, tesseraIndex: 3 }, key)
    assert.equal(decodeFrame(ack, key)?.kind, "ack")
    assert.equal(decodeFrame(nack, key)?.kind, "nack")
    assert.equal(decodeFrame(sample, key)?.kind, "sample")
    assert.equal(decodeFrame(ack, null), null)
    assert.equal(decodeFrame(ack, Buffer.alloc(32, 0x33)), null)
    for (const frame of [ack, nack, sample]) {
      for (let length = 0; length < frame.length; length++) assert.equal(decodeFrame(frame.subarray(0, length), key), null)
      for (let i = 0; i < frame.length; i++) {
        const flipped = Buffer.from(frame)
        flipped[i] = (flipped[i] ?? 0) ^ 0xff
        assert.equal(decodeFrame(flipped, key), null)
      }
    }
    assert.equal(decodeFrame(control(FRAME_NACK, Buffer.from([33, 0, 1])), key), null)
    assert.equal(decodeFrame(control(FRAME_ACK, Buffer.from([0])), key), null)
    assert.equal(decodeFrame(control(FRAME_SAMPLE, Buffer.alloc(0)), key), null)
    const wide = control(FRAME_SAMPLE, Buffer.from([255]))
    const decoded = decodeFrame(wide, key)
    assert.equal(decoded?.kind, "sample")
    if (decoded?.kind === "sample") assert.equal(decoded.tesseraIndex, 255)
  })

  it("rejects a TESR envelope that is short, mis-versioned, or port 0", () => {
    const packet = encodeEnvelope({ host: "1.2.3.4", port: 4101 }, Buffer.from("inner"))
    assert.equal(decodeEnvelope(packet)?.dest.port, 4101)
    for (let length = 0; length < ENVELOPE_LEN; length++) assert.equal(decodeEnvelope(packet.subarray(0, length)), null)
    for (let i = 0; i < ENVELOPE_LEN; i++) {
      const flipped = Buffer.from(packet)
      flipped[i] = (flipped[i] ?? 0) ^ 0xff
      quiet(flipped)
    }
    const version = Buffer.from(packet)
    version[4] = 1
    assert.equal(decodeEnvelope(version), null)
    const port = Buffer.from(packet)
    port.writeUInt16BE(0, 9)
    assert.equal(decodeEnvelope(port), null)
    const broadcast = encodeEnvelope({ host: "255.255.255.255", port: 1 }, Buffer.alloc(0))
    assert.equal(decodeEnvelope(broadcast)?.dest.host, "255.255.255.255")
    assert.equal(broadcast.length, ENVELOPE_LEN)
  })

  it("rejects truncated and mutated identity messages", () => {
    const id = generateIdentity()
    const challenge = Buffer.alloc(16, 0x44)
    const packets = [
      encodeQuery(challenge),
      encodeProof(id, challenge),
      encodeJoin(),
      encodeLookup(challenge),
      encodeAgain(challenge, Buffer.alloc(16, 0x55)),
      encodeResume(challenge, Buffer.alloc(16, 0x66)),
      encodeUsage(id, 1, 2, 3),
      encodeSnapshotQuery(challenge),
      encodeSnapshot(id, challenge, { relays: 1, bytes: 2, transfers: 3 }),
      encodeTable(id, challenge, [{ id: id.id, endpoint: { host: "8.8.8.8", port: 4101 } }]),
    ]
    for (const packet of packets) {
      for (let length = 0; length < packet.length; length++) {
        const cut = packet.subarray(0, length)
        assert.equal(decodeQuery(cut), null)
        assert.equal(decodeLookup(cut), null)
        assert.equal(decodeAgain(cut), null)
        assert.equal(decodeResume(cut), null)
        assert.equal(decodeTable(cut), null)
        assert.equal(decodeUsage(cut), null)
        assert.equal(decodeSnapshot(cut), null)
        assert.equal(isJoin(cut), false)
        quiet(cut)
      }
    }
    const lookup = encodeLookup(challenge)
    assert.ok(decodeLookup(lookup)?.equals(challenge))
    const kind = Buffer.from(lookup)
    kind[5] = 99
    assert.equal(isIdentityPacket(kind), false)
    assert.equal(decodeLookup(kind), null)
    const version = Buffer.from(lookup)
    version[4] = 1
    assert.equal(decodeLookup(version), null)
    const again = encodeAgain(challenge, Buffer.alloc(16, 0x55))
    assert.equal(decodeResume(again), null)
    assert.equal(decodeAgain(encodeResume(challenge, Buffer.alloc(16, 0x66))), null)

    const table = encodeTable(id, challenge, [{ id: generateIdentity().id, endpoint: { host: "1.1.1.1", port: 9 } }])
    assert.equal(decodeTable(table)?.peers.length, 1)
    for (const at of [6, 40, table.length - 1]) {
      const flipped = Buffer.from(table)
      flipped[at] = (flipped[at] ?? 0) ^ 0xff
      assert.equal(decodeTable(flipped), null)
    }
    const proof = encodeProof(id, challenge)
    const badProof = Buffer.from(proof)
    badProof[badProof.length - 1] = (badProof[badProof.length - 1] ?? 0) ^ 0xff
    const parsed = decodeProof(badProof)
    assert.ok(parsed)
    assert.equal(verifyProof(parsed), false)
    assert.equal(decodeProof(badProof.subarray(0, badProof.length - 1)), null)
  })
})

function quiet(packet: Uint8Array): void {
  const mac = key
  const calls = [
    () => decodeEnvelope(packet),
    () => decodeFrame(packet, null),
    () => decodeFrame(packet, mac),
    () => isIdentityPacket(packet),
    () => decodeQuery(packet),
    () => decodeProof(packet),
    () => isJoin(packet),
    () => decodeLookup(packet),
    () => decodeAgain(packet),
    () => decodeResume(packet),
    () => decodeTable(packet),
    () => decodeUsage(packet),
    () => decodeSnapshotQuery(packet),
    () => decodeSnapshot(packet),
    () => isRecordAsk(packet),
    () => decodeRecord(packet),
    () => isStructuralTesera(packet),
  ]
  for (const call of calls) {
    let value: unknown
    try {
      value = call()
    } catch (err) {
      assert.fail(`parser threw on ${packet.length} bytes: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!value || typeof value !== "object") continue
    if ("payload" in value && Buffer.isBuffer(value.payload)) assert.ok(value.payload.length <= MAX_SHARD)
    if ("peers" in value && Array.isArray(value.peers)) assert.ok(value.peers.length <= 31)
    if ("name" in value && typeof value.name === "string") assert.ok(Buffer.byteLength(value.name) <= 64)
    if ("addresses" in value && Array.isArray(value.addresses)) assert.ok(value.addresses.length <= 4)
    if ("inner" in value && Buffer.isBuffer(value.inner)) assert.ok(value.inner.length <= packet.length)
  }
}

function validPackets(): Buffer[] {
  const id = generateIdentity()
  const challenge = Buffer.alloc(16, 0x44)
  return [
    encodeEnvelope({ host: "8.8.8.8", port: 4101 }, dataFrame({})),
    dataFrame({}),
    encodeAck({ kind: "ack", sessionId, blockId: 1 }, key),
    encodeNack({ kind: "nack", sessionId, blockId: 1, missing: [0] }, key),
    encodeSample({ kind: "sample", sessionId, blockId: 1, tesseraIndex: 0 }, key),
    encodeQuery(challenge),
    encodeJoin(),
    encodeLookup(challenge),
    encodeAgain(challenge, Buffer.alloc(16, 1)),
    encodeResume(challenge, Buffer.alloc(16, 2)),
    encodeTable(id, challenge, []),
    encodeUsage(id, 1, 0, 0),
    encodeSnapshotQuery(challenge),
    encodeSnapshot(id, challenge, { relays: 1, bytes: 0, transfers: 0 }),
    encodeRecordAsk(),
    encodeRecord(id, officialClaims({ addresses: [{ host: "8.8.8.8", port: 4101 }], name: "", ttlSec: 3600 }), 1n, 1_700_000_000),
  ]
}

function dataFrame(opts: {
  version?: number
  type?: number
  blockId?: number
  tesseraIndex?: number
  k?: number
  n?: number
  cipherLen?: number
  payload?: Buffer
}): Buffer {
  const payload = opts.payload ?? Buffer.from([1, 2, 3, 4])
  const out = Buffer.alloc(DATA_HEADER_LEN + payload.length + CRC_LEN)
  out[0] = opts.version ?? PROTOCOL_VERSION
  out[1] = opts.type ?? FRAME_DATA
  out.set(sessionId, 2)
  out.writeUInt32BE(opts.blockId ?? 1, 18)
  out[22] = opts.tesseraIndex ?? 0
  out[23] = opts.k ?? 1
  out[24] = opts.n ?? 1
  out.writeUInt16BE(opts.cipherLen ?? Math.min(payload.length, 0xffff), 25)
  out.writeUInt16BE(payload.length, 27)
  out.set(payload, DATA_HEADER_LEN)
  out.writeUInt32BE(crc32(out.subarray(0, out.length - CRC_LEN)), out.length - CRC_LEN)
  return out
}

function control(type: number, body: Buffer): Buffer {
  const unsigned = Buffer.alloc(22 + body.length)
  unsigned[0] = PROTOCOL_VERSION
  unsigned[1] = type
  unsigned.set(sessionId, 2)
  unsigned.writeUInt32BE(4, 18)
  unsigned.set(body, 22)
  return Buffer.concat([unsigned, mac16(key, unsigned)])
}

function randomPackets(count: number, seed: number): Buffer[] {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  const out: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const length = next() % 300
    const packet = Buffer.alloc(length)
    for (let b = 0; b < length; b++) packet[b] = next() & 0xff
    out.push(packet)
  }
  out.push(Buffer.alloc(MAX_FORWARD_DATAGRAM + 1))
  const huge = Buffer.alloc(8192)
  huge.set(Buffer.from("TSID"))
  huge[4] = PROTOCOL_VERSION
  huge[5] = 4
  out.push(huge)
  return out
}
