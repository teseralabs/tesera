import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, type Endpoint } from "../src/carrier/udp.js"
import { decodeShards, encodeShards, joinShards, splitCiphertext } from "../src/coding/reedsolomon.js"
import {
  ENVELOPE_LEN,
  MAX_AHEAD,
  MAX_FORWARD_DATAGRAM,
  MAX_SHARD,
  UNVERIFIED_DEST_BYTES,
  UNVERIFIED_DEST_MAX,
  UNVERIFIED_DEST_TTL_MS,
} from "../src/constants.js"
import { blockAad, deriveKeys, open, seal, sealedLength } from "../src/crypto/session.js"
import { generateIdentity } from "../src/identity/id.js"
import { decodeAgain, decodeTable, encodeLookup, encodeResume } from "../src/identity/peers.js"
import { encodeEnvelope } from "../src/protocol/envelope.js"
import { crc32 } from "../src/protocol/crc32.js"
import { encodeData } from "../src/protocol/frames.js"
import { DestBudget } from "../src/relay/dest-budget.js"
import { DENIED_DESTINATIONS, destinationAllowed, parseCidr } from "../src/relay/dest.js"
import { Relay } from "../src/relay/relay.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { TeseraSender } from "../src/transport/sender.js"
import { sleep } from "../src/util.js"

describe("destination allowance", () => {
  it("refuses protected ranges unless the named CIDR covers that address", () => {
    for (const cidr of DENIED_DESTINATIONS) {
      const parsed = parseCidr(cidr)
      const first = intToIp(parsed.base)
      const last = intToIp((parsed.base | (~parsed.mask >>> 0)) >>> 0)
      assert.equal(destinationAllowed(first, []), false, first)
      assert.equal(destinationAllowed(last, []), false, last)
    }
    const allow = [parseCidr("10.1.0.0/16")]
    assert.equal(destinationAllowed("10.1.2.3", allow), true)
    assert.equal(destinationAllowed("10.2.0.1", allow), false)
    assert.equal(destinationAllowed("192.168.0.1", allow), false)
    assert.equal(destinationAllowed("8.8.8.8", []), true)
  })

  it("keeps 8192 bytes, 256 entries, and a 60 second lifetime", () => {
    assert.equal(UNVERIFIED_DEST_BYTES, 8192)
    assert.equal(UNVERIFIED_DEST_MAX, 256)
    assert.equal(UNVERIFIED_DEST_TTL_MS, 60_000)
    const dest: Endpoint = { host: "1.2.3.4", port: 4101 }
    const budget = new DestBudget()
    const t = 10_000
    assert.equal(budget.spend(dest, UNVERIFIED_DEST_BYTES, t), true)
    assert.equal(budget.remaining(dest, t), 0)
    assert.equal(budget.spend(dest, 1, t + UNVERIFIED_DEST_TTL_MS - 1), false)
    assert.equal(budget.remaining(dest, t + UNVERIFIED_DEST_TTL_MS - 1), 0)
    assert.equal(budget.spend(dest, UNVERIFIED_DEST_BYTES, t + UNVERIFIED_DEST_TTL_MS - 1 + UNVERIFIED_DEST_TTL_MS), true)
    const again: Endpoint = { host: "1.2.3.4", port: 4102 }
    assert.equal(budget.spend(again, 4096, t), true)
    assert.equal(budget.spend(again, 4096, t + 1), true)
    assert.equal(budget.remaining(again, t + 1), 0)
    assert.equal(budget.spend(again, 1, t + 1), false)

    const capped = new DestBudget()
    const first: Endpoint = { host: "9.9.9.1", port: 1 }
    assert.equal(capped.spend(first, 100, 1), true)
    for (let i = 1; i < UNVERIFIED_DEST_MAX; i++) {
      assert.equal(capped.spend({ host: "9.9.9.1", port: i + 1 }, 1, 1), true)
    }
    assert.equal(capped.size, UNVERIFIED_DEST_MAX)
    assert.equal(capped.spend({ host: "9.9.9.2", port: 1 }, 1, 1), false)
    assert.equal(capped.remaining(first, 1), UNVERIFIED_DEST_BYTES - 100)
  })
})

describe("forwarding limits", () => {
  it("drops protected destinations, a ninth kilobyte, and anything past 1144 bytes", async () => {
    const relay = new Relay({ allowRemote: true, host: "127.0.0.1" })
    const tx = createUdpSocket()
    let forwarded = 0
    relay.onForward = () => {
      forwarded++
    }
    try {
      await relay.start()
      await bindUdp(tx, "127.0.0.1", 0)
      for (const host of ["10.0.0.1", "192.168.0.1", "169.254.1.1", "100.64.1.1", "224.0.0.1", "255.255.255.255"]) {
        await sendUdp(tx, encodeEnvelope({ host, port: 9 }, Buffer.alloc(32)), relay.endpoint)
      }
      await sleep(30)
      assert.equal(forwarded, 0)
      assert.equal(relay.stats.droppedDenied, 6)

      const dest: Endpoint = { host: "1.2.3.4", port: 4101 }
      for (let i = 0; i < 8; i++) await sendUdp(tx, encodeEnvelope(dest, Buffer.alloc(1024, i)), relay.endpoint)
      await waitFor(() => forwarded === 8)
      await sendUdp(tx, encodeEnvelope(dest, Buffer.alloc(1024, 9)), relay.endpoint)
      await sendUdp(tx, encodeEnvelope(dest, Buffer.alloc(1024, 10)), relay.endpoint)
      await sleep(30)
      assert.equal(forwarded, 8)

      const edge = Buffer.alloc(MAX_FORWARD_DATAGRAM - ENVELOPE_LEN)
      await sendUdp(tx, encodeEnvelope({ host: "1.2.3.5", port: 4101 }, edge), relay.endpoint)
      await waitFor(() => forwarded === 9)
      const over = Buffer.alloc(MAX_FORWARD_DATAGRAM + 1)
      over.set(Buffer.from("TESR"))
      await sendUdp(tx, over, relay.endpoint)
      const blob = Buffer.alloc(8192)
      blob.set(Buffer.from("TSID"))
      blob[4] = 2
      blob[5] = 3
      await sendUdp(tx, blob, relay.endpoint)
      await sleep(30)
      assert.equal(forwarded, 9)
      assert.ok(relay.stats.droppedInvalid >= 1)
    } finally {
      await closeUdp(tx)
      await relay.close()
    }
  })

  it("allows one CIDR without opening the other protected ranges", async () => {
    const relay = new Relay({ allowRemote: true, host: "127.0.0.1", allowDest: ["10.1.0.0/16"] })
    const tx = createUdpSocket()
    let forwarded = 0
    relay.onForward = () => {
      forwarded++
    }
    try {
      await relay.start()
      await bindUdp(tx, "127.0.0.1", 0)
      await sendUdp(tx, encodeEnvelope({ host: "10.1.2.3", port: 9 }, Buffer.alloc(16)), relay.endpoint)
      await sendUdp(tx, encodeEnvelope({ host: "10.2.0.1", port: 9 }, Buffer.alloc(16)), relay.endpoint)
      await sendUdp(tx, encodeEnvelope({ host: "192.168.0.1", port: 9 }, Buffer.alloc(16)), relay.endpoint)
      await waitFor(() => forwarded === 1)
      await sleep(20)
      assert.equal(forwarded, 1)
      assert.equal(relay.stats.droppedDenied, 2)
    } finally {
      await closeUdp(tx)
      await relay.close()
    }
  })

  it("accepts a valid tesera datagram only from the same host and port", async () => {
    const relay = new Relay({ allowRemote: true, host: "127.0.0.1", allowDest: ["127.0.0.0/8"] })
    const tx = createUdpSocket()
    const destSock = createUdpSocket()
    const other = createUdpSocket()
    let forwarded = 0
    relay.onForward = () => {
      forwarded++
    }
    try {
      await relay.start()
      await bindUdp(tx, "127.0.0.1", 0)
      await bindUdp(destSock, "127.0.0.1", 0)
      await bindUdp(other, "127.0.0.1", 0)
      const local: Endpoint = { host: "127.0.0.1", port: destSock.address().port }
      for (let i = 0; i < 8; i++) await sendUdp(tx, encodeEnvelope(local, Buffer.alloc(1024, i)), relay.endpoint)
      await waitFor(() => forwarded === 8)
      await sendUdp(destSock, Buffer.from([1, 2, 3]), relay.endpoint)
      await sendUdp(other, encodeLookup(randomBytes(16)), relay.endpoint)
      await sleep(20)
      await sendUdp(tx, encodeEnvelope(local, Buffer.alloc(1024, 9)), relay.endpoint)
      await sleep(30)
      assert.equal(forwarded, 8)
      await sendUdp(destSock, encodeLookup(randomBytes(16)), relay.endpoint)
      await sleep(20)
      await sendUdp(tx, encodeEnvelope(local, Buffer.alloc(32)), relay.endpoint)
      await waitFor(() => forwarded === 9)
    } finally {
      await closeUdp(tx)
      await closeUdp(destSock)
      await closeUdp(other)
      await relay.close()
    }
  })
})

describe("peer-table handshake", () => {
  it("returns a table only after the same socket sends the nonce back", async () => {
    const relay = new Relay({ host: "127.0.0.1", identity: generateIdentity() })
    const asker = createUdpSocket()
    const other = createUdpSocket()
    const asked: Buffer[] = []
    const elsewhere: Buffer[] = []
    asker.on("message", (msg) => asked.push(Buffer.from(msg)))
    other.on("message", (msg) => elsewhere.push(Buffer.from(msg)))
    try {
      await relay.start()
      await bindUdp(asker, "127.0.0.1", 0)
      await bindUdp(other, "127.0.0.1", 0)
      const challenge = randomBytes(16)
      await sendUdp(asker, encodeLookup(challenge), relay.endpoint)
      await waitFor(() => asked.length >= 1)
      const again = decodeAgain(asked[0] ?? Buffer.alloc(0))
      assert.ok(again)
      assert.equal(asked.length, 1)
      assert.equal(asked[0]?.length, 38)
      assert.equal(decodeTable(asked[0] ?? Buffer.alloc(0)), null)
      await sleep(40)
      assert.equal(asked.filter((msg) => decodeTable(msg)).length, 0)

      await sendUdp(other, encodeResume(challenge, again.nonce), relay.endpoint)
      await sleep(30)
      assert.equal(asked.filter((msg) => decodeTable(msg)).length, 0)
      assert.equal(elsewhere.filter((msg) => decodeTable(msg)).length, 0)

      await sendUdp(asker, encodeResume(challenge, again.nonce), relay.endpoint)
      await waitFor(() => asked.some((msg) => decodeTable(msg) !== null))
      assert.ok(decodeTable(asked.find((msg) => decodeTable(msg)) ?? Buffer.alloc(0)))
    } finally {
      await closeUdp(asker)
      await closeUdp(other)
      await relay.close()
    }
  })

  it("does not return a table for the wrong nonce", async () => {
    const relay = new Relay({ host: "127.0.0.1", identity: generateIdentity() })
    const asker = createUdpSocket()
    const asked: Buffer[] = []
    asker.on("message", (msg) => asked.push(Buffer.from(msg)))
    try {
      await relay.start()
      await bindUdp(asker, "127.0.0.1", 0)
      const challenge = randomBytes(16)
      await sendUdp(asker, encodeLookup(challenge), relay.endpoint)
      await waitFor(() => asked.length >= 1)
      assert.ok(decodeAgain(asked[0] ?? Buffer.alloc(0)))
      await sendUdp(asker, encodeResume(challenge, randomBytes(16)), relay.endpoint)
      await sleep(40)
      assert.equal(asked.filter((msg) => decodeTable(msg)).length, 0)
    } finally {
      await closeUdp(asker)
      await relay.close()
    }
  })

  it("counts the nonce reply and the table against the datagram and bandwidth budgets", async () => {
    const byDatagram = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      policy: { access: "open", bandwidthBps: 0, maxSessions: 0, peerRatePerMin: 0, datagramRatePerSec: 1 },
    })
    const byBandwidth = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      policy: { access: "open", bandwidthBps: 40, maxSessions: 0, peerRatePerMin: 0, datagramRatePerSec: 0 },
    })
    try {
      await assertBudgetDropsTable(byDatagram)
      await assertBudgetDropsTable(byBandwidth)
    } finally {
      await byDatagram.close()
      await byBandwidth.close()
    }
  })
})

describe("receiver state", () => {
  it("does not keep state for a packet that fails the structural or window check", async () => {
    const secret = randomBytes(32)
    const tx = createUdpSocket()
    const boundTx = await bindUdp(tx, "127.0.0.1", 0)
    const receiver = new TeseraReceiver({ session: secret, relays: [boundTx], sender: boundTx, maxAhead: MAX_AHEAD })
    const boundRx = await receiver.start()
    const goodId = randomBytes(16)
    try {
      const junk = [
        Buffer.alloc(0),
        Buffer.alloc(64, 0xff),
        randomBytes(300),
        dataFrame(secret, randomBytes(16), MAX_AHEAD + 1, Buffer.from("late"), true),
        dataFrame(secret, randomBytes(16), 0xffffffff, Buffer.from("max"), true),
        structuralFrame({ k: 0, n: 1 }),
        structuralFrame({ k: 2, n: 1 }),
        structuralFrame({ n: 33 }),
        structuralFrame({ tesseraIndex: 5, n: 1 }),
        structuralFrame({ cipherLen: 0xffff, payload: Buffer.alloc(4) }),
        structuralFrame({ payload: Buffer.alloc(MAX_SHARD + 1), cipherLen: 1 }),
      ]
      for (const packet of junk) await sendUdp(tx, packet, boundRx)
      await sleep(30)
      assert.equal(receiver.stats.acksSent, 0)
      assert.equal(receiver.stats.maxBufferedBlocks, 0)
      assert.equal(receiver.stats.outputBytes, 0)
      await sendUdp(tx, dataFrame(secret, goodId, 0, Buffer.from("ok"), true), boundRx)
      assert.deepEqual(await receiver.read(), Buffer.from("ok"))
    } finally {
      await receiver.close()
      await closeUdp(tx)
    }
  })

  it("does not deliver plaintext when a tessera index is swapped", async () => {
    const secret = randomBytes(32)
    const sessionId = randomBytes(16)
    const body = Buffer.from("plaintext-ok")
    const k = 2
    const n = 2
    const blockId = 1
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
    assert.throws(() => open(keys.aeadKey, blockId, joinShards(swapped, cipherLen), aad))

    const tx = createUdpSocket()
    const boundTx = await bindUdp(tx, "127.0.0.1", 0)
    const receiver = new TeseraReceiver({ session: secret, relays: [boundTx], sender: boundTx })
    const boundRx = await receiver.start()
    let failed = false
    receiver.onPeerFail = () => {
      failed = true
    }
    try {
      await sendUdp(tx, shardFrame(sessionId, blockId, 1, k, n, cipherLen, shards[0] ?? Buffer.alloc(0)), boundRx)
      await sendUdp(tx, shardFrame(sessionId, blockId, 0, k, n, cipherLen, shards[1] ?? Buffer.alloc(0)), boundRx)
      await waitFor(() => failed || receiver.stats.outputBytes > 0)
      assert.equal(receiver.stats.outputBytes, 0)
      assert.equal(failed, true)
    } finally {
      await receiver.close()
      await closeUdp(tx)
    }
  })
})

describe("retransmission", () => {
  it("sends the stored frame again", async () => {
    const relay = new Relay({ host: "127.0.0.1" })
    const frames: Buffer[] = []
    relay.onForward = (inner) => {
      frames.push(Buffer.from(inner))
    }
    try {
      await relay.start()
      const sender = new TeseraSender({
        session: randomBytes(32),
        receiver: { host: "127.0.0.1", port: 9 },
        relays: [relay.endpoint],
        k: 1,
        n: 1,
        shardSize: 64,
        retxAfterMs: 30,
        tickMs: 10,
        deadlineMs: 1_000,
        maxSends: 4,
      })
      await sender.start()
      const finished = sender
        .write(Buffer.from("hi"))
        .then(() => sender.end())
        .catch(() => {})
      try {
        await waitFor(() => sender.stats.tesseraRetransmissions >= 1 && frames.length >= 2)
        assert.deepEqual(frames[0], frames[1])
      } finally {
        await sender.close()
        await finished
      }
    } finally {
      await relay.close()
    }
  })
})

async function assertBudgetDropsTable(relay: Relay): Promise<void> {
  const sock = createUdpSocket()
  const got: Buffer[] = []
  sock.on("message", (msg) => got.push(Buffer.from(msg)))
  try {
    await relay.start()
    await bindUdp(sock, "127.0.0.1", 0)
    const challenge = randomBytes(16)
    await sendUdp(sock, encodeLookup(challenge), relay.endpoint)
    await waitFor(() => got.length >= 1)
    const again = decodeAgain(got[0] ?? Buffer.alloc(0))
    assert.ok(again)
    await sendUdp(sock, encodeResume(challenge, again.nonce), relay.endpoint)
    await sleep(40)
    assert.equal(got.filter((msg) => decodeTable(msg)).length, 0)
    assert.ok(relay.stats.droppedLimited >= 1)
  } finally {
    await closeUdp(sock)
  }
}

function dataFrame(secret: Buffer, sessionId: Buffer, blockId: number, body: Buffer, fin: boolean): Buffer {
  const keys = deriveKeys(secret, sessionId)
  const cipherLen = sealedLength(body.length)
  const ctx = { sessionId, blockId, k: 1, n: 1, cipherLen, shardLen: cipherLen }
  const payload = seal(keys.aeadKey, blockId, fin, body, 1_000, blockAad(ctx))
  return encodeData({ kind: "data", sessionId, blockId, tesseraIndex: 0, k: 1, n: 1, cipherLen, payload })
}

function structuralFrame(opts: { k?: number; n?: number; tesseraIndex?: number; cipherLen?: number; payload?: Buffer }): Buffer {
  const payload = opts.payload ?? Buffer.alloc(4)
  const out = Buffer.alloc(29 + payload.length + 4)
  out[0] = 2
  out[1] = 1
  out.set(Buffer.alloc(16, 3), 2)
  out.writeUInt32BE(1, 18)
  out[22] = opts.tesseraIndex ?? 0
  out[23] = opts.k ?? 1
  out[24] = opts.n ?? 1
  out.writeUInt16BE(opts.cipherLen ?? 1, 25)
  out.writeUInt16BE(payload.length, 27)
  out.set(payload, 29)
  out.writeUInt32BE(crc32(out.subarray(0, out.length - 4)), out.length - 4)
  return out
}

function shardFrame(
  sessionId: Buffer,
  blockId: number,
  tesseraIndex: number,
  k: number,
  n: number,
  cipherLen: number,
  payload: Uint8Array,
): Buffer {
  return encodeData({
    kind: "data",
    sessionId,
    blockId,
    tesseraIndex,
    k,
    n,
    cipherLen,
    payload: Buffer.from(payload),
  })
}

function intToIp(value: number): string {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now()
  while (!ready()) {
    if (Date.now() - start > 1500) throw new Error("timed out")
    await sleep(5)
  }
}
