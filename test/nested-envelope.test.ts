import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { type Socket } from "node:dgram"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, type Endpoint } from "../src/carrier/udp.js"
import { PROTOCOL_VERSION } from "../src/constants.js"
import { encodeEnvelope, startsEnvelope } from "../src/protocol/envelope.js"
import { encodeAck, encodeData } from "../src/protocol/frames.js"
import { Relay } from "../src/relay/relay.js"
import { sleep } from "../src/util.js"

describe("nested envelopes", () => {
  it("forwards an envelope that holds a DATA frame or an ACK", async () => {
    await withRelay(async ({ relay, tx, sinkEndpoint, received }) => {
      const data = dataFrame()
      await sendUdp(tx, encodeEnvelope(sinkEndpoint, data), relay.endpoint)
      await waitFor(() => received.length === 1)
      assert.deepEqual(received[0], data)

      const ack = encodeAck({ kind: "ack", sessionId: randomBytes(16), blockId: 3 }, randomBytes(32))
      await sendUdp(tx, encodeEnvelope(sinkEndpoint, ack), relay.endpoint)
      await waitFor(() => received.length === 2)
      assert.deepEqual(received[1], ack)
      assert.equal(relay.stats.forwarded, 2)
      assert.equal(relay.stats.droppedInvalid, 0)
    })
  })

  it("drops an envelope inside an envelope without forwarding it", async () => {
    await withRelay(async ({ relay, tx, sinkEndpoint, received }) => {
      let forwarded = 0
      relay.onForward = () => {
        forwarded++
      }
      const nested = encodeEnvelope(sinkEndpoint, encodeEnvelope(sinkEndpoint, dataFrame()))
      await sendUdp(tx, nested, relay.endpoint)
      await barrier(relay, tx, sinkEndpoint, received)
      assert.equal(forwarded, 1)
      assert.equal(received.length, 1)
      assert.equal(relay.stats.droppedInvalid, 1)
      assert.equal(relay.stats.forwarded, 1)
    })
  })

  it("drops deeper nesting", async () => {
    await withRelay(async ({ relay, tx, sinkEndpoint, received }) => {
      let packet = dataFrame()
      for (let depth = 0; depth < 4; depth++) packet = encodeEnvelope(sinkEndpoint, packet)
      await sendUdp(tx, packet, relay.endpoint)
      await barrier(relay, tx, sinkEndpoint, received)
      assert.equal(received.length, 1)
      assert.equal(relay.stats.droppedInvalid, 1)
    })
  })

  it("drops an inner envelope from another protocol version, which an older relay would forward", async () => {
    await withRelay(async ({ relay, tx, sinkEndpoint, received }) => {
      const inner = encodeEnvelope(sinkEndpoint, dataFrame())
      inner[4] = PROTOCOL_VERSION - 1
      await sendUdp(tx, encodeEnvelope(sinkEndpoint, inner), relay.endpoint)
      await barrier(relay, tx, sinkEndpoint, received)
      assert.equal(received.length, 1)
      assert.equal(relay.stats.droppedInvalid, 1)
    })
  })

  it("still forwards other inner bytes it can't parse, as before", async () => {
    await withRelay(async ({ relay, tx, sinkEndpoint, received }) => {
      const junk = Buffer.from("TES-not-an-envelope")
      await sendUdp(tx, encodeEnvelope(sinkEndpoint, junk), relay.endpoint)
      await waitFor(() => received.length === 1)
      assert.deepEqual(received[0], junk)
      assert.equal(relay.stats.droppedInvalid, 0)
    })
  })

  it("never mistakes a frame for an envelope", () => {
    assert.equal(startsEnvelope(dataFrame()), false)
    assert.equal(startsEnvelope(encodeAck({ kind: "ack", sessionId: randomBytes(16), blockId: 0 }, randomBytes(32))), false)
    assert.equal(startsEnvelope(Buffer.from("TES")), false)
    assert.equal(startsEnvelope(encodeEnvelope({ host: "127.0.0.1", port: 9 }, Buffer.alloc(0))), true)
  })
})

type Harness = {
  relay: Relay
  tx: Socket
  sinkEndpoint: Endpoint
  received: Buffer[]
}

async function withRelay(run: (harness: Harness) => Promise<void>): Promise<void> {
  const relay = new Relay({ host: "127.0.0.1" })
  const tx = createUdpSocket()
  const sink = createUdpSocket()
  const received: Buffer[] = []
  sink.on("message", (msg) => received.push(Buffer.from(msg)))
  try {
    await relay.start()
    await bindUdp(tx, "127.0.0.1", 0)
    const sinkEndpoint = await bindUdp(sink, "127.0.0.1", 0)
    await run({ relay, tx, sinkEndpoint, received })
  } finally {
    await closeUdp(tx)
    await closeUdp(sink)
    await relay.close()
  }
}

/** Send one normal envelope after the packet under test and wait for it, so an earlier forward would already be here. */
async function barrier(relay: Relay, tx: Socket, sink: Endpoint, received: Buffer[]): Promise<void> {
  const before = received.length
  await sendUdp(tx, encodeEnvelope(sink, dataFrame()), relay.endpoint)
  await waitFor(() => received.length > before)
  await sleep(30)
}

function dataFrame(): Buffer {
  return encodeData({
    kind: "data",
    sessionId: randomBytes(16),
    blockId: 0,
    tesseraIndex: 0,
    k: 1,
    n: 1,
    cipherLen: 64,
    payload: randomBytes(64),
  })
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting")
    await sleep(5)
  }
}
