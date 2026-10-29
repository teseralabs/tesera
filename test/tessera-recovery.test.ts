import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp } from "../src/carrier/udp.js"
import { encodeShards, splitCiphertext } from "../src/coding/reedsolomon.js"
import { MAX_AHEAD } from "../src/constants.js"
import { blockAad, deriveKeys, seal, sealedLength } from "../src/crypto/session.js"
import { decodeFrame, encodeData, type DataFrame } from "../src/protocol/frames.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { sleep } from "../src/util.js"

describe("corrupted tessera recovery", () => {
  it("delivers the block when one tessera fails its checksum", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("checksum survives")
    const frames = blockFrames(secret, 0, body, true, 2, 3)
    const smashed = Buffer.from(frames[0] ?? Buffer.alloc(0))
    smashed[10] = (smashed[10] ?? 0) ^ 0xff
    const { receiver, send } = await start(secret)
    try {
      await send(smashed)
      await send(frames[1] ?? Buffer.alloc(0))
      await send(frames[2] ?? Buffer.alloc(0))
      assert.deepEqual(await receiver.read(), body)
    } finally {
      await receiver.close()
    }
  })

  it("keeps a valid parameter set when another tessera disagrees on k, n, or length", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("parameters disagree")
    const frames = blockFrames(secret, 0, body, true, 2, 3)
    const honest = data(frames[0] ?? Buffer.alloc(0))
    const otherCode = encodeData({
      ...honest,
      k: 1,
      n: 1,
      tesseraIndex: 0,
      cipherLen: honest.payload.length,
      payload: Buffer.alloc(honest.payload.length, 7),
    })
    const otherLength = encodeData({ ...honest, cipherLen: honest.cipherLen - 1 })
    const { receiver, send } = await start(secret)
    try {
      await send(otherCode)
      await send(frames[0] ?? Buffer.alloc(0))
      await send(otherLength)
      for (const frame of frames.slice(1)) await send(frame)
      assert.deepEqual(await receiver.read(), body)
    } finally {
      await receiver.close()
    }
  })

  it("drops a frame whose code is not the one pinned from the offer", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("pinned code")
    const frames = blockFrames(secret, 0, body, true, 2, 3)
    const honest = data(frames[0] ?? Buffer.alloc(0))
    const otherCode = encodeData({
      ...honest,
      k: 1,
      n: 1,
      tesseraIndex: 0,
      cipherLen: honest.payload.length,
      payload: Buffer.alloc(honest.payload.length, 9),
    })
    const { receiver, send } = await start(secret, { k: 2, n: 3 })
    try {
      await send(otherCode)
      await send(otherCode)
      for (const frame of frames) await send(frame)
      assert.deepEqual(await receiver.read(), body)
    } finally {
      await receiver.close()
    }
  })

  it("reconstructs from the other tesserae when one shard is corrupt", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("leave one out")
    const frames = blockFrames(secret, 0, body, true, 2, 3)
    const { receiver, send } = await start(secret)
    try {
      await send(corrupt(frames[0] ?? Buffer.alloc(0)))
      await send(frames[1] ?? Buffer.alloc(0))
      await send(frames[2] ?? Buffer.alloc(0))
      assert.deepEqual(await receiver.read(), body)
    } finally {
      await receiver.close()
    }
  })

  it("accepts one replacement of a corrupt shard", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("replaced")
    const frames = blockFrames(secret, 0, body, true, 1, 1)
    const good = frames[0] ?? Buffer.alloc(0)
    const { receiver, send } = await start(secret)
    try {
      await send(corrupt(good))
      await send(good)
      assert.deepEqual(await receiver.read(), body)
    } finally {
      await receiver.close()
    }
  })

  it("fails the integrity check when the same bad shard arrives twice", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("confirmed bad")
    const bad = corrupt(blockFrames(secret, 0, body, true, 1, 1)[0] ?? Buffer.alloc(0))
    const { receiver, send } = await start(secret)
    try {
      await send(bad)
      await send(bad)
      await assert.rejects(receiver.read(), /failed integrity check/)
      assert.equal(receiver.stats.outputBytes, 0)
    } finally {
      await receiver.close()
    }
  })

  it("fails the integrity check when every combination is bad", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("nothing left")
    const bad = blockFrames(secret, 0, body, true, 2, 3).map(corrupt)
    const { receiver, send } = await start(secret)
    try {
      for (const frame of bad) await send(frame)
      for (const frame of bad) await send(frame)
      await assert.rejects(receiver.read(), /failed integrity check/)
      assert.equal(receiver.stats.outputBytes, 0)
    } finally {
      await receiver.close()
    }
  })

  it("ignores a block past the receive window", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("in window")
    const { receiver, send } = await start(secret)
    try {
      for (const frame of blockFrames(secret, MAX_AHEAD + 1, Buffer.from("too far"), true, 1, 1)) await send(frame)
      for (const frame of blockFrames(secret, 0, body, true, 1, 1)) await send(frame)
      assert.deepEqual(await receiver.read(), body)
      assert.equal(receiver.stats.blocksDecoded, 1)
    } finally {
      await receiver.close()
    }
  })

  it("keeps the honest shards when other lengths are interleaved", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("interleaved lengths")
    const frames = blockFrames(secret, 0, body, true, 2, 3)
    const { receiver, send } = await start(secret)
    try {
      for (let i = 0; i < frames.length; i++) {
        await send(otherLength(frames[i] ?? Buffer.alloc(0), i + 1))
        await send(frames[i] ?? Buffer.alloc(0))
      }
      assert.deepEqual(await receiver.read(), body)
    } finally {
      await receiver.close()
    }
  })

  it("keeps an honest set that has started when later lengths flood the block", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("length flood")
    const frames = blockFrames(secret, 0, body, true, 2, 3)
    const { receiver, send } = await start(secret)
    try {
      await send(frames[0] ?? Buffer.alloc(0))
      for (let cipherLen = 1; cipherLen <= 8; cipherLen++) await send(otherLength(frames[0] ?? Buffer.alloc(0), cipherLen))
      for (const frame of frames) await send(frame)
      assert.deepEqual(await receiver.read(), body)
    } finally {
      await receiver.close()
    }
  })

  it("drops a third length when two other lengths already fill the block", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("slots full")
    const frames = blockFrames(secret, 0, body, true, 2, 3)
    const { receiver, send } = await start(secret)
    let settled = false
    const pending = receiver.read().then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    try {
      await send(otherLength(frames[0] ?? Buffer.alloc(0), 1))
      await send(otherLength(frames[0] ?? Buffer.alloc(0), 2))
      for (const frame of frames) await send(frame)
      await sleep(100)
      assert.equal(settled, false)
      assert.equal(receiver.stats.outputBytes, 0)
      assert.equal(receiver.stats.blocksDecoded, 0)
    } finally {
      await receiver.close()
      await pending
    }
  })

  it("drops a frame whose code is not the pinned one, even between honest shards", async () => {
    const secret = randomBytes(32)
    const body = Buffer.from("pinned between junk")
    const frames = blockFrames(secret, 0, body, true, 2, 3)
    const honest = data(frames[0] ?? Buffer.alloc(0))
    const otherCode = encodeData({
      ...honest,
      k: 1,
      n: 1,
      tesseraIndex: 0,
      cipherLen: honest.payload.length,
      payload: Buffer.alloc(honest.payload.length, 4),
    })
    const { receiver, send } = await start(secret, { k: 2, n: 3 })
    try {
      for (const frame of frames) {
        await send(otherCode)
        await send(frame)
      }
      assert.deepEqual(await receiver.read(), body)
    } finally {
      await receiver.close()
    }
  })
})

async function start(secret: Buffer, coding?: { k: number; n: number }): Promise<{ receiver: TeseraReceiver; send: (packet: Buffer) => Promise<void> }> {
  const socket = createUdpSocket()
  const relay = await bindUdp(socket, "127.0.0.1", 0)
  const receiver = new TeseraReceiver({
    session: secret,
    relays: [relay],
    ...(coding ? { coding } : {}),
  })
  const bound = await receiver.start()
  const send = async (packet: Buffer) => {
    await sendUdp(socket, packet, bound)
  }
  const close = receiver.close.bind(receiver)
  receiver.close = async () => {
    await close()
    await closeUdp(socket)
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

function data(frame: Buffer): DataFrame {
  const decoded = decodeFrame(frame, null)
  if (!decoded || decoded.kind !== "data") throw new Error("expected a data frame")
  return decoded
}

function corrupt(frame: Buffer): Buffer {
  const decoded = data(frame)
  const payload = Buffer.from(decoded.payload)
  payload[0] = (payload[0] ?? 0) ^ 0xff
  return encodeData({ ...decoded, payload })
}

function otherLength(frame: Buffer, cipherLen: number): Buffer {
  return encodeData({ ...data(frame), cipherLen, tesseraIndex: 0 })
}
