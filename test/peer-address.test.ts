import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { type Socket } from "node:dgram"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, type Endpoint } from "../src/carrier/udp.js"
import { blockAad, deriveKeys, seal, sealedLength } from "../src/crypto/session.js"
import { FRAME_SAMPLE } from "../src/constants.js"
import { decodeEnvelope } from "../src/protocol/envelope.js"
import { encodeData, peekRelayFrame } from "../src/protocol/frames.js"
import { addressPerRelay } from "../src/transport/address.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { TeseraSender } from "../src/transport/sender.js"
import { sleep } from "../src/util.js"

const relays: Endpoint[] = [
  { host: "127.0.0.1", port: 4101 },
  { host: "127.0.0.1", port: 4102 },
  { host: "127.0.0.1", port: 4103 },
]

describe("peer address per relay", () => {
  it("repeats one address for every relay, as callers pass today", () => {
    const one = { host: "127.0.0.1", port: 9000 }
    assert.deepEqual(addressPerRelay(one, relays), [one, one, one])
  })

  it("keeps one address per relay in relay order", () => {
    const list = [
      { host: "127.0.0.1", port: 9001 },
      { host: "127.0.0.1", port: 9002 },
      { host: "127.0.0.1", port: 9003 },
    ]
    assert.deepEqual(addressPerRelay(list, relays), list)
  })

  it("refuses a list that doesn't match the relays", () => {
    assert.throws(() => addressPerRelay([{ host: "127.0.0.1", port: 9001 }], relays), /one peer address per relay/)
    assert.throws(
      () => new TeseraSender({ session: Buffer.alloc(32, 1), receiver: [], relays }),
      /one peer address per relay/,
    )
  })

  it("puts each relay's receiver address in the envelopes the sender gives that relay", async () => {
    await withTaps(async (taps) => {
      const receivers = taps.map((_, index) => ({ host: "127.0.0.1", port: 9100 + index }))
      const sender = new TeseraSender({
        session: Buffer.alloc(32, 2),
        receiver: receivers,
        relays: taps.map((tap) => tap.endpoint),
        retxAfterMs: 20,
      })
      await sender.start()
      try {
        await sender.write(randomBytes(100))
        void sender.end().catch(() => {})
        await waitFor(() => taps.every((tap) => tap.packets.length > 0))
      } finally {
        await sender.close()
      }
      taps.forEach((tap, index) => {
        for (const packet of tap.packets) assert.deepEqual(decodeEnvelope(packet)?.dest, receivers[index])
      })
    })
  })

  it("answers a tessera with a SAMPLE and an ACK on its relay, to that relay's sender address", async () => {
    await withTaps(async (taps) => {
      const secret = Buffer.alloc(32, 3)
      const senders = taps.map((_, index) => ({ host: "127.0.0.1", port: 9200 + index }))
      const receiver = new TeseraReceiver({ session: secret, relays: taps.map((tap) => tap.endpoint), sender: senders })
      const at = await receiver.start()
      try {
        await sendUdp(taps[1]!.socket, dataFrame(secret, randomBytes(16), Buffer.from("hello")), at)
        await waitFor(() => taps[1]!.packets.some((p) => kindOf(p) === "ack"))
        assert.ok(taps[1]!.packets.some((p) => kindOf(p) === "sample"))
        assert.equal(taps[0]!.packets.length, 0)
        assert.equal(taps[2]!.packets.length, 0)
      } finally {
        await receiver.close()
      }
      taps.forEach((tap, index) => {
        for (const packet of tap.packets) assert.deepEqual(decodeEnvelope(packet)?.dest, senders[index])
      })
    })
  })

  it("keeps setSender working with one address", async () => {
    await withTaps(async (taps) => {
      const secret = Buffer.alloc(32, 4)
      const sender = { host: "127.0.0.1", port: 9300 }
      const receiver = new TeseraReceiver({ session: secret, relays: taps.map((tap) => tap.endpoint) })
      const at = await receiver.start()
      receiver.setSender(sender)
      try {
        await sendUdp(taps[0]!.socket, dataFrame(secret, randomBytes(16), Buffer.from("hi")), at)
        await waitFor(() => taps[0]!.packets.some((p) => kindOf(p) === "ack"))
      } finally {
        await receiver.close()
      }
      assert.ok(taps[0]!.packets.length > 0)
      for (const tap of taps) for (const packet of tap.packets) assert.deepEqual(decodeEnvelope(packet)?.dest, sender)
    })
  })
})

type Tap = { socket: Socket; endpoint: Endpoint; packets: Buffer[] }

async function withTaps(run: (taps: Tap[]) => Promise<void>): Promise<void> {
  const taps: Tap[] = []
  try {
    for (let i = 0; i < 3; i++) {
      const socket = createUdpSocket()
      const packets: Buffer[] = []
      socket.on("message", (msg) => packets.push(Buffer.from(msg)))
      taps.push({ socket, endpoint: await bindUdp(socket, "127.0.0.1", 0), packets })
    }
    await run(taps)
  } finally {
    for (const tap of taps) await closeUdp(tap.socket)
  }
}

function kindOf(packet: Buffer): string | null {
  const inner = decodeEnvelope(packet)?.inner
  if (!inner) return null
  if (inner[1] === FRAME_SAMPLE) return "sample"
  return peekRelayFrame(inner)?.kind ?? null
}

function dataFrame(secret: Buffer, sessionId: Buffer, body: Buffer): Buffer {
  const keys = deriveKeys(secret, sessionId)
  const cipherLen = sealedLength(body.length)
  const ctx = { sessionId, blockId: 0, k: 1, n: 1, cipherLen, shardLen: cipherLen }
  const payload = seal(keys.aeadKey, 0, true, body, 1_000, blockAad(ctx))
  return encodeData({ kind: "data", sessionId, blockId: 0, tesseraIndex: 0, k: 1, n: 1, cipherLen, payload })
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting")
    await sleep(5)
  }
}
