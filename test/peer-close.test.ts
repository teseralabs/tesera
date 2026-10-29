import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { sentBy } from "../src/attach/attachments.js"
import { bindUdp, closeUdp, createUdpSocket, sendUdp } from "../src/carrier/udp.js"
import { encodeShards, splitCiphertext } from "../src/coding/reedsolomon.js"
import { blockAad, deriveKeys, seal, sealedLength } from "../src/crypto/session.js"
import { decodeEnvelope } from "../src/protocol/envelope.js"
import { decodeClose, decodeFrame, encodeClose, encodeData } from "../src/protocol/frames.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { TeseraSender } from "../src/transport/sender.js"
import { sleep } from "../src/util.js"

describe("peer close", () => {
  it("authenticates a close and leaves data, ack, nack, and sample frames alone", () => {
    const key = randomBytes(32)
    const sessionId = randomBytes(16)
    const fromSender = encodeClose("sender", sessionId, "cancel", key)
    const fromReceiver = encodeClose("receiver", sessionId, "end", key)
    assert.equal(decodeFrame(fromSender, key), null)
    assert.equal(decodeFrame(fromReceiver, key), null)
    assert.deepEqual(decodeClose(fromSender, key), { kind: "close", sessionId, reason: "cancel", from: "sender" })
    assert.deepEqual(decodeClose(fromReceiver, key), { kind: "close", sessionId, reason: "end", from: "receiver" })
    const flipped = Buffer.from(fromSender)
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff
    assert.equal(decodeClose(flipped, key), null)
    assert.equal(decodeClose(fromSender, randomBytes(32)), null)
    assert.equal(decodeClose(fromSender, null), null)
    const ack = encodeClose("receiver", sessionId, "cancel", key)
    assert.equal(ack.length, 39)
    assert.equal(ack[1], 2)
    assert.equal(sentBy(fromSender), "sending")
    assert.equal(sentBy(fromReceiver), "receiving")
  })

  it("stops the receiver when the sender cancels, and ignores a second copy", async () => {
    const secret = randomBytes(32)
    const sessionId = randomBytes(16)
    const { receiver, send } = await start(secret, sessionId)
    try {
      const keys = deriveKeys(secret, sessionId)
      const close = encodeClose("sender", sessionId, "cancel", keys.macKey)
      await send(close)
      await send(close)
      await assert.rejects(receiver.read(), /the sender cancelled the transfer/)
      await assert.rejects(receiver.read(), /the sender cancelled the transfer/)
    } finally {
      await receiver.close()
    }
  })

  it("ignores a forged close, the wrong direction, and another session, then delivers the file", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("still intact")
    const frames = blockFrames(secret, 0, body, true, 1, 1)
    const honest = decodeFrame(frames[0] ?? Buffer.alloc(0), null)
    if (!honest || honest.kind !== "data") throw new Error("expected a data frame")
    const keys = deriveKeys(secret, honest.sessionId)
    const forged = Buffer.from(encodeClose("sender", honest.sessionId, "cancel", keys.macKey))
    forged[forged.length - 1] = (forged[forged.length - 1] ?? 0) ^ 0xff
    const reflected = encodeClose("receiver", honest.sessionId, "cancel", keys.macKey)
    const otherId = randomBytes(16)
    const other = encodeClose("sender", otherId, "cancel", deriveKeys(secret, otherId).macKey)
    const { receiver, send } = await start(secret, honest.sessionId)
    try {
      await send(forged)
      await send(reflected)
      await send(other)
      await send(frames[0] ?? Buffer.alloc(0))
      assert.deepEqual(await receiver.read(), body)
      assert.equal(await receiver.read(), null)
    } finally {
      await receiver.close()
    }
  })

  it("keeps a local failure when a close arrives after it", async () => {
    const secret = randomBytes(32)
    const sessionId = randomBytes(16)
    const { receiver, send } = await start(secret, sessionId)
    try {
      receiver.fail(new Error("block 0 failed integrity check: tag mismatch"))
      await send(encodeClose("sender", sessionId, "cancel", deriveKeys(secret, sessionId).macKey))
      await assert.rejects(receiver.read(), /failed integrity check/)
    } finally {
      await receiver.close()
    }
  })

  it("ignores a close that arrives after the stream has finished", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("already done")
    const frames = blockFrames(secret, 0, body, true, 1, 1)
    const honest = decodeFrame(frames[0] ?? Buffer.alloc(0), null)
    if (!honest || honest.kind !== "data") throw new Error("expected a data frame")
    const { receiver, send } = await start(secret, honest.sessionId)
    try {
      await send(frames[0] ?? Buffer.alloc(0))
      assert.deepEqual(await receiver.read(), body)
      assert.equal(await receiver.read(), null)
      await send(encodeClose("sender", honest.sessionId, "cancel", deriveKeys(secret, honest.sessionId).macKey))
      await sleep(20)
      assert.equal(await receiver.read(), null)
    } finally {
      await receiver.close()
    }
  })

  it("lets a second close wait until the notice has been handed off", async () => {
    const secret = randomBytes(32)
    const sessionId = randomBytes(16)
    const relay = { host: "127.0.0.1", port: 1 }
    const peer = { host: "127.0.0.1", port: 2 }
    const opened = slowTransport()
    const receiver = new TeseraReceiver({
      session: secret,
      sessionId,
      relays: [relay],
      sender: peer,
      transport: async () => opened.transport,
    })
    await receiver.start()
    const first = receiver.close("cancel")
    void receiver.close().then(() => opened.drop())
    await first
    const env = decodeEnvelope(opened.sent[0] ?? Buffer.alloc(0))
    const close = env && decodeClose(env.inner, deriveKeys(secret, sessionId).macKey)
    assert.equal(close && close.reason, "cancel")
    assert.equal(close && close.from, "receiver")
  })

  it("finishes a close when the transport never takes the notice", async () => {
    const relay = { host: "127.0.0.1", port: 1 }
    const peer = { host: "127.0.0.1", port: 2 }
    const senderSide = stuckTransport()
    const sender = new TeseraSender({
      session: randomBytes(32),
      relays: [relay],
      receiver: peer,
      k: 1,
      n: 1,
      transport: async () => senderSide.transport,
    })
    await sender.start()
    const receiverSide = stuckTransport()
    const receiver = new TeseraReceiver({
      session: randomBytes(32),
      sessionId: randomBytes(16),
      relays: [relay],
      sender: peer,
      transport: async () => receiverSide.transport,
    })
    await receiver.start()
    const t0 = Date.now()
    await Promise.all([sender.close("cancel"), receiver.close("cancel")])
    const took = Date.now() - t0
    assert.equal(senderSide.attempts(), 1)
    assert.equal(receiverSide.attempts(), 1)
    assert.ok(took < 3_000, `close took ${took} ms`)
    assert.ok(senderSide.closed() && receiverSide.closed(), "the transport is closed after the notice is abandoned")
  })

  it("stops the sender when the receiver cancels, and ignores the sender's own notice", async () => {
    const secret = randomBytes(32)
    const relaySocket = createUdpSocket()
    const relay = await bindUdp(relaySocket, "127.0.0.1", 0)
    const receiverSocket = createUdpSocket()
    const receiverAt = await bindUdp(receiverSocket, "127.0.0.1", 0)
    const sender = new TeseraSender({ session: secret, relays: [relay], receiver: receiverAt, k: 1, n: 1, idleMs: 5_000 })
    await sender.start()
    const keys = deriveKeys(secret, sender.sessionId)
    const own = encodeClose("sender", sender.sessionId, "cancel", keys.macKey)
    const peer = encodeClose("receiver", sender.sessionId, "cancel", keys.macKey)
    try {
      await sendUdp(relaySocket, own, sender.endpoint)
      await sleep(30)
      await sender.write(Buffer.from("partial"))
      await sendUdp(relaySocket, peer, sender.endpoint)
      await sleep(30)
      await assert.rejects(sender.write(Buffer.from("more")), /the receiver cancelled the transfer/)
      await sendUdp(relaySocket, peer, sender.endpoint)
      await assert.rejects(sender.write(Buffer.from("again")), /the receiver cancelled the transfer/)
    } finally {
      await sender.close()
      await closeUdp(relaySocket)
      await closeUdp(receiverSocket)
    }
  })
})

function slowTransport(): { transport: { endpoint: { host: string; port: number }; maxPacketSize: number; send: (packet: Uint8Array) => Promise<void>; close: () => Promise<void> }; sent: Buffer[]; drop: () => void } {
  const sent: Buffer[] = []
  let dropped = false
  return {
    sent,
    drop: () => {
      dropped = true
    },
    transport: {
      endpoint: { host: "127.0.0.1", port: 9 },
      maxPacketSize: 1200,
      async send(packet: Uint8Array) {
        await sleep(40)
        if (dropped) throw new Error("closed")
        sent.push(Buffer.from(packet))
      },
      async close() {},
    },
  }
}

/** A transport whose send never resolves, like a WebTransport writer that stays full. */
function stuckTransport(): { transport: { endpoint: { host: string; port: number }; maxPacketSize: number; send: () => Promise<void>; close: () => Promise<void> }; attempts: () => number; closed: () => boolean } {
  let attempts = 0
  let closed = false
  return {
    attempts: () => attempts,
    closed: () => closed,
    transport: {
      endpoint: { host: "127.0.0.1", port: 9 },
      maxPacketSize: 1200,
      send() {
        attempts++
        return new Promise<void>(() => {})
      },
      async close() {
        closed = true
      },
    },
  }
}

async function start(
  secret: Buffer,
  sessionId: Buffer,
): Promise<{ receiver: TeseraReceiver; send: (packet: Buffer) => Promise<void> }> {
  const socket = createUdpSocket()
  const relay = await bindUdp(socket, "127.0.0.1", 0)
  const senderSocket = createUdpSocket()
  const senderAt = await bindUdp(senderSocket, "127.0.0.1", 0)
  const receiver = new TeseraReceiver({ session: secret, sessionId, relays: [relay] })
  receiver.setSender(senderAt)
  const bound = await receiver.start()
  const send = async (packet: Buffer) => {
    await sendUdp(socket, packet, bound)
  }
  const close = receiver.close.bind(receiver)
  receiver.close = async () => {
    await close()
    await closeUdp(socket)
    await closeUdp(senderSocket)
  }
  return { receiver, send }
}

function blockFrames(secret: Buffer, blockId: number, body: Buffer, fin: boolean, k: number, n: number): Buffer[] {
  const sessionId = randomBytes(16)
  const keys = deriveKeys(secret, sessionId)
  const cipherLen = sealedLength(body.length)
  const shardLen = Math.ceil(cipherLen / k)
  const cipher = seal(keys.aeadKey, blockId, fin, body, 1_000, blockAad({ sessionId, blockId, k, n, cipherLen, shardLen }))
  const shards = encodeShards(splitCiphertext(cipher, k), k, n)
  return shards.map((payload, tesseraIndex) =>
    encodeData({
      kind: "data",
      sessionId,
      blockId,
      tesseraIndex,
      k,
      n,
      cipherLen,
      payload: Buffer.from(payload),
    }),
  )
}
