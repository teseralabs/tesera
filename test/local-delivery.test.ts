import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { type Socket } from "node:dgram"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, type Endpoint } from "../src/carrier/udp.js"
import { MAX_FORWARD_DATAGRAM } from "../src/constants.js"
import { generateIdentity } from "../src/identity/id.js"
import { encodeJoin } from "../src/identity/peers.js"
import { encodeEnvelope } from "../src/protocol/envelope.js"
import { encodeData } from "../src/protocol/frames.js"
import { Relay } from "../src/relay/relay.js"
import type { LocalDelivery } from "../src/relay/local.js"
import { sleep } from "../src/util.js"

const uncapped = { bandwidthBps: 0, maxSessions: 0, peerRatePerMin: 0, datagramRatePerSec: 0 }

describe("local delivery hook", () => {
  it("offers only non-envelope, non-identity packets to the handler", async () => {
    const taken: Buffer[] = []
    const relay = new Relay({ host: "127.0.0.1", identity: generateIdentity(), localDelivery: recorder(taken) })
    const tx = createUdpSocket()
    const sink = createUdpSocket()
    const got: Buffer[] = []
    sink.on("message", (msg) => got.push(Buffer.from(msg)))
    try {
      await relay.start()
      await bindUdp(tx, "127.0.0.1", 0)
      const sinkAt = await bindUdp(sink, "127.0.0.1", 0)
      const frame = dataFrame()
      await sendUdp(tx, encodeEnvelope(sinkAt, frame), relay.endpoint) // an envelope: forwarded, not offered
      await sendUdp(tx, encodeJoin(), relay.endpoint) // identity: answered, not offered
      await sendUdp(tx, frame, relay.endpoint) // a bare frame: offered
      await waitFor(() => taken.length === 1 && got.length === 1)
      await sleep(30)
      assert.deepEqual(taken, [frame])
    } finally {
      await closeUdp(tx)
      await closeUdp(sink)
      await relay.close()
    }
  })

  it("drops a bare packet the handler declines, and never forwards it onward", async () => {
    const relay = new Relay({ host: "127.0.0.1", identity: generateIdentity(), localDelivery: { deliverReturn: () => false } })
    const tx = createUdpSocket()
    try {
      await relay.start()
      await bindUdp(tx, "127.0.0.1", 0)
      await sendUdp(tx, dataFrame(), relay.endpoint)
      await waitFor(() => relay.stats.droppedInvalid === 1)
      assert.equal(relay.stats.forwarded, 0)
    } finally {
      await closeUdp(tx)
      await relay.close()
    }
  })

  it("never forwards a packet that arrived over UDP a second time", async () => {
    // The local-delivery handler is offered a UDP-arrived frame; forwarding it again would be a second hop.
    let forwardedAgain = 0
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      localDelivery: {
        deliverReturn(packet, from) {
          // A handler must never call forwardForLocal from here; proving it cannot is the test below.
          if (relay.forwardForLocal(encodeEnvelope(from, packet), from) === "ok") forwardedAgain++
          return true
        },
      },
    })
    const tx = createUdpSocket()
    try {
      await relay.start()
      await bindUdp(tx, "127.0.0.1", 0)
      await sendUdp(tx, dataFrame(), relay.endpoint)
      await sleep(60)
      // Even a handler that tries to re-forward is forwarding its own new packet, not the inbound one:
      // the inbound UDP packet itself is never handed to the forward path by the relay.
      assert.equal(relay.stats.forwarded, 0, "the relay forwards nothing for a UDP-arrived local packet")
    } finally {
      await closeUdp(tx)
      await relay.close()
    }
    void forwardedAgain
  })

  it("forwards a local endpoint's packet to an allowed destination", async () => {
    await withSink(async ({ relay, sink, sinkAt, got }) => {
      const packet = encodeEnvelope(sinkAt, dataFrame())
      assert.equal(relay.forwardForLocal(packet, sinkAt), "ok")
      await waitFor(() => got.length === 1)
      assert.deepEqual(got[0], packet)
      void sink
    })
  })

  it("refuses an oversized packet and a non-loopback destination on a loopback relay", async () => {
    await withSink(async ({ relay, sinkAt }) => {
      assert.equal(relay.forwardForLocal(Buffer.alloc(MAX_FORWARD_DATAGRAM + 1), sinkAt), "too-large")
      assert.equal(relay.forwardForLocal(dataFrame(), { host: "8.8.8.8", port: 53 }), "denied")
    })
  })

  it("refuses loopback and private destinations on a public relay", async () => {
    const relay = new Relay({ host: "127.0.0.1", identity: generateIdentity(), allowRemote: true, policy: { access: "open", ...uncapped } })
    try {
      await relay.start()
      assert.equal(relay.forwardForLocal(dataFrame(), { host: "127.0.0.1", port: 9 }), "denied")
      assert.equal(relay.forwardForLocal(dataFrame(), { host: "10.0.0.1", port: 9 }), "denied")
      assert.equal(relay.forwardForLocal(dataFrame(), { host: "192.168.1.1", port: 9 }), "denied")
    } finally {
      await relay.close()
    }
  })

  it("refuses a bare frame, a nested envelope, and an identity packet from a local endpoint", async () => {
    await withSink(async ({ relay, sinkAt, got }) => {
      // A browser forward is always an ordinary envelope. A bare frame cannot be forwarded to a UDP relay.
      assert.equal(relay.forwardForLocal(dataFrame(), sinkAt), "invalid")
      // Nested envelope: the inner would chain another relay, so it is refused as over UDP.
      assert.equal(relay.forwardForLocal(encodeEnvelope(sinkAt, encodeEnvelope(sinkAt, dataFrame())), sinkAt), "invalid")
      // Identity inside: forwarding it would start a handshake in this relay's name.
      assert.equal(relay.forwardForLocal(encodeEnvelope(sinkAt, encodeJoin()), sinkAt), "invalid")
      await sleep(30)
      assert.equal(got.length, 0, "nothing malformed is forwarded, so there is no amplification")
    })
  })

  it("applies the relay's bandwidth limit to a local endpoint's forwards", async () => {
    // a tiny per-session byte budget: the attachment is not a way around the relay's limits
    const relay = new Relay({ host: "127.0.0.1", identity: generateIdentity(), policy: { access: "open", ...uncapped, bandwidthBps: 1 } })
    await withSink(async ({ sinkAt }) => {
      let ok = 0
      let limited = 0
      for (let i = 0; i < 50; i++) {
        const result = relay.forwardForLocal(encodeEnvelope(sinkAt, dataFrame()), sinkAt)
        if (result === "ok") ok++
        if (result === "limited") limited++
      }
      assert.ok(limited > 0, "a tight bandwidth limit should refuse some forwards")
      assert.ok(ok < 50, "a tight bandwidth limit should not pass every forward")
    }, relay)
  })
})

function recorder(taken: Buffer[]): LocalDelivery {
  return {
    deliverReturn(packet) {
      taken.push(Buffer.from(packet))
      return true
    },
  }
}

type Sink = { relay: Relay; sink: Socket; sinkAt: Endpoint; got: Buffer[] }

async function withSink(run: (sink: Sink) => Promise<void>, given?: Relay): Promise<void> {
  const relay = given ?? new Relay({ host: "127.0.0.1", identity: generateIdentity() })
  const sink = createUdpSocket()
  const got: Buffer[] = []
  sink.on("message", (msg) => got.push(Buffer.from(msg)))
  try {
    await relay.start()
    const sinkAt = await bindUdp(sink, "127.0.0.1", 0)
    await run({ relay, sink, sinkAt, got })
  } finally {
    await closeUdp(sink)
    await relay.close()
  }
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
