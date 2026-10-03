import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp } from "../src/carrier/udp.js"
import {
  blockAad,
  deriveKeys,
  open,
  seal,
  sealedLength,
  type BlockContext,
} from "../src/crypto/session.js"
import { DATA_HEADER_LEN } from "../src/constants.js"
import { decodeFrame, encodeAck, encodeData } from "../src/protocol/frames.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { sleep } from "../src/util.js"

function context(sessionId: Buffer, blockId: number, body: Buffer, k = 1, n = 1): BlockContext {
  const cipherLen = sealedLength(body.length)
  return { sessionId, blockId, k, n, cipherLen, shardLen: Math.ceil(cipherLen / k) }
}

describe("per-sender keys", () => {
  it("derives different keys for each session id and keeps the control key apart", () => {
    const secret = randomBytes(32)
    const idA = randomBytes(16)
    const idB = randomBytes(16)
    const a = deriveKeys(secret, idA)
    const again = deriveKeys(secret, idA)
    const b = deriveKeys(secret, idB)
    assert.deepEqual(again, a)
    assert.notDeepEqual(a.aeadKey, b.aeadKey)
    assert.notDeepEqual(a.macKey, b.macKey)
    assert.notDeepEqual(a.aeadKey, a.macKey)
    assert.notDeepEqual(a.aeadKey, secret)
    assert.notDeepEqual(a.macKey, secret)
  })

  it("fails authentication when the session id changes before the key is derived", () => {
    const secret = randomBytes(32)
    const idA = randomBytes(16)
    const idB = randomBytes(16)
    const body = Buffer.from("alpha")
    const ctx = context(idA, 0, body)
    const keysA = deriveKeys(secret, idA)
    const cipher = seal(keysA.aeadKey, 0, false, body, 50, blockAad(ctx))

    const flipped = Buffer.from(idA)
    flipped[0] = (flipped[0] ?? 0) ^ 0xff
    const flippedKeys = deriveKeys(secret, flipped)
    const flippedAad = blockAad({ ...ctx, sessionId: flipped })
    assert.throws(() => open(flippedKeys.aeadKey, 0, cipher, flippedAad))
    assert.throws(() => open(keysA.aeadKey, 0, cipher, flippedAad))
    assert.throws(() => open(deriveKeys(secret, idB).aeadKey, 0, cipher, blockAad(ctx)))
    assert.deepEqual(open(keysA.aeadKey, 0, cipher, blockAad(ctx)).body, body)
  })

  it("lets two senders reuse block 0 under one secret", () => {
    const secret = randomBytes(32)
    const idA = randomBytes(16)
    const idB = randomBytes(16)
    const bodyA = Buffer.from("one")
    const bodyB = Buffer.from("two")
    const keysA = deriveKeys(secret, idA)
    const keysB = deriveKeys(secret, idB)
    const cipherA = seal(keysA.aeadKey, 0, false, bodyA, 10, blockAad(context(idA, 0, bodyA)))
    const cipherB = seal(keysB.aeadKey, 0, true, bodyB, 11, blockAad(context(idB, 0, bodyB)))
    assert.deepEqual(open(keysA.aeadKey, 0, cipherA, blockAad(context(idA, 0, bodyA))).body, bodyA)
    assert.deepEqual(open(keysB.aeadKey, 0, cipherB, blockAad(context(idB, 0, bodyB))).body, bodyB)
    assert.throws(() => open(keysA.aeadKey, 0, cipherB, blockAad(context(idB, 0, bodyB))))
    assert.throws(() => open(keysB.aeadKey, 0, cipherA, blockAad(context(idA, 0, bodyA))))
  })

  it("binds the block header in associated data", () => {
    const secret = randomBytes(32)
    const sessionId = randomBytes(16)
    const body = Buffer.from("bound")
    const ctx = context(sessionId, 4, body, 2, 3)
    const keys = deriveKeys(secret, sessionId)
    const aad = blockAad(ctx)
    const cipher = seal(keys.aeadKey, 4, false, body, 7, aad)
    const changes: BlockContext[] = [
      { ...ctx, blockId: 5 },
      { ...ctx, k: 3 },
      { ...ctx, n: 4 },
      { ...ctx, cipherLen: ctx.cipherLen + 1 },
      { ...ctx, shardLen: ctx.shardLen + 1 },
    ]
    for (const changed of changes) {
      assert.throws(() => open(keys.aeadKey, changed.blockId, cipher, blockAad(changed)))
    }
    const version = Buffer.from(aad)
    version[0] = (version[0] ?? 0) ^ 0xff
    assert.throws(() => open(keys.aeadKey, 4, cipher, version))
  })

  it("does not accept a control frame under the other key", () => {
    const secret = randomBytes(32)
    const idA = randomBytes(16)
    const idB = randomBytes(16)
    const keysA = deriveKeys(secret, idA)
    const keysB = deriveKeys(secret, idB)
    const ack = encodeAck({ kind: "ack", sessionId: idA, blockId: 0 }, keysA.macKey)
    assert.equal(decodeFrame(ack, keysA.macKey)?.kind, "ack")
    assert.equal(decodeFrame(ack, keysB.macKey), null)
    assert.equal(decodeFrame(ack, keysA.aeadKey), null)
    assert.equal(decodeFrame(ack, secret), null)
  })

  it("delivers one session and drops a second session id on the same secret", async () => {
    const secret = randomBytes(32)
    const idA = randomBytes(16)
    const idB = randomBytes(16)
    const first = Buffer.from("alpha")
    const second = Buffer.from("beta-other-session")
    const socket = createUdpSocket()
    const boundTx = await bindUdp(socket, "127.0.0.1", 0)
    const receiver = new TeseraReceiver({
      session: secret,
      relays: [boundTx],
      sender: boundTx,
    })
    const boundRx = await receiver.start()
    try {
      await sendUdp(socket, dataFrame(secret, idA, 0, first, true), boundRx)
      assert.deepEqual(await receiver.read(), first)
      await sendUdp(socket, dataFrame(secret, idB, 1, second, true), boundRx)
      await sleep(50)
      assert.equal(await receiver.read(), null)
      assert.equal(receiver.stats.outputBytes, first.length)
    } finally {
      await receiver.close()
      await closeUdp(socket)
    }
  })

  it("does not deliver a block whose session id was changed on the frame", async () => {
    const secret = randomBytes(32)
    const sessionId = randomBytes(16)
    const body = Buffer.from("kept")
    const frame = dataFrame(secret, sessionId, 0, body, true)
    const flipped = Buffer.from(sessionId)
    flipped[0] = (flipped[0] ?? 0) ^ 0xff
    const forged = encodeData({
      kind: "data",
      sessionId: flipped,
      blockId: 0,
      tesseraIndex: 0,
      k: 1,
      n: 1,
      cipherLen: sealedLength(body.length),
      payload: Buffer.from(frame.subarray(DATA_HEADER_LEN, frame.length - 4)),
    })
    const socket = createUdpSocket()
    const relay = await bindUdp(socket, "127.0.0.1", 0)
    const receiver = new TeseraReceiver({ session: secret, relays: [relay] })
    const boundRx = await receiver.start()
    try {
      await sendUdp(socket, forged, boundRx)
      await assert.rejects(receiver.read(), /integrity check/)
      assert.equal(receiver.stats.outputBytes, 0)
    } finally {
      await receiver.close()
      await closeUdp(socket)
    }
  })

  it("ignores a data frame that does not come from one of its relays", async () => {
    const secret = randomBytes(32)
    const sessionId = randomBytes(16)
    const body = Buffer.from("from a relay")
    const relaySocket = createUdpSocket()
    const strangerSocket = createUdpSocket()
    const relay = await bindUdp(relaySocket, "127.0.0.1", 0)
    await bindUdp(strangerSocket, "127.0.0.1", 0)
    const receiver = new TeseraReceiver({ session: secret, relays: [relay], sender: relay })
    const boundRx = await receiver.start()
    try {
      await sendUdp(strangerSocket, dataFrame(secret, randomBytes(16), 0, Buffer.from("stranger"), true), boundRx)
      await sleep(50)
      await sendUdp(relaySocket, dataFrame(secret, sessionId, 0, body, true), boundRx)
      assert.deepEqual(await receiver.read(), body)
      assert.equal(await receiver.read(), null)
    } finally {
      await receiver.close()
      await closeUdp(relaySocket)
      await closeUdp(strangerSocket)
    }
  })
})

function dataFrame(secret: Buffer, sessionId: Buffer, blockId: number, body: Buffer, fin: boolean): Buffer {
  const keys = deriveKeys(secret, sessionId)
  const ctx = context(sessionId, blockId, body)
  const cipher = seal(keys.aeadKey, blockId, fin, body, 1_000, blockAad(ctx))
  return encodeData({
    kind: "data",
    sessionId,
    blockId,
    tesseraIndex: 0,
    k: 1,
    n: 1,
    cipherLen: ctx.cipherLen,
    payload: Buffer.from(cipher),
  })
}
