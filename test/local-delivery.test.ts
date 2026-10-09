import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { type Socket } from "node:dgram"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, type Endpoint } from "../src/carrier/udp.js"
import { MAX_FORWARD_DATAGRAM, UNVERIFIED_DEST_BYTES } from "../src/constants.js"
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

  it("hands a local endpoint's packet for an end attached here to local delivery without a UDP send", async () => {
    const offered: { packet: Buffer; from: Endpoint }[] = []
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      localDelivery: { deliverReturn: (packet, from) => (offered.push({ packet: Buffer.from(packet), from }), true) },
    })
    try {
      await relay.start()
      const socket = (relay as unknown as { socket: Socket }).socket
      let sends = 0
      const send = socket.send.bind(socket)
      socket.send = ((...args: Parameters<Socket["send"]>) => (sends++, send(...args))) as Socket["send"]
      const frame = dataFrame()
      assert.equal(relay.forwardForLocal(encodeEnvelope(relay.endpoint, frame), relay.endpoint), "ok")
      assert.deepEqual(offered, [{ packet: frame, from: relay.endpoint }])
      assert.equal(relay.stats.forwarded, 1)
      assert.equal(sends, 0)
    } finally {
      await relay.close()
    }
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

  it("charges a self-forwarded envelope once against the bandwidth budget", async () => {
    // The in-process handoff used to admit the same envelope a second time. A budget of one datagram
    // then returned "ok", delivered nothing, and counted a bandwidth drop.
    const bytes = encodeEnvelope({ host: "127.0.0.1", port: 1 }, dataFrame()).length
    const offered: Buffer[] = []
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      localDelivery: { deliverReturn: (packet) => (offered.push(Buffer.from(packet)), true) },
      policy: { access: "open", ...uncapped, bandwidthBps: bytes },
    })
    try {
      await relay.start()
      const first = relay.forwardForLocal(encodeEnvelope(relay.endpoint, dataFrame()), relay.endpoint)
      assert.equal(first, "ok")
      assert.equal(offered.length, 1)
      assert.equal(relay.stats.forwarded, 1)
      assert.equal(relay.stats.limitedBy.bandwidth, 0)
      assert.equal(relay.stats.droppedLimited, 0)
      const second = relay.forwardForLocal(encodeEnvelope(relay.endpoint, dataFrame()), relay.endpoint)
      assert.equal(second, "limited")
      assert.equal(offered.length, 1)
      assert.equal(relay.stats.limitedBy.bandwidth, 1)
      assert.equal(relay.stats.limitedBy.datagram, 0)
      assert.equal(relay.stats.droppedLimited, 1)
    } finally {
      await relay.close()
    }
  })

  it("does not count a limit when two self-forwards both fit the bandwidth budget", async () => {
    const bytes = encodeEnvelope({ host: "127.0.0.1", port: 1 }, dataFrame()).length
    const offered: Buffer[] = []
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      localDelivery: { deliverReturn: (packet) => (offered.push(Buffer.from(packet)), true) },
      policy: { access: "open", ...uncapped, bandwidthBps: bytes * 2 },
    })
    try {
      await relay.start()
      assert.equal(relay.forwardForLocal(encodeEnvelope(relay.endpoint, dataFrame()), relay.endpoint), "ok")
      assert.equal(relay.forwardForLocal(encodeEnvelope(relay.endpoint, dataFrame()), relay.endpoint), "ok")
      assert.equal(offered.length, 2)
      assert.equal(relay.stats.limitedBy.bandwidth, 0)
      assert.equal(relay.stats.droppedLimited, 0)
    } finally {
      await relay.close()
    }
  })

  it("charges a self-forward once against the unverified destination allowance", async () => {
    const offered: Buffer[] = []
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      allowRemote: true,
      advertise: [{ host: "1.2.3.4", port: 4101 }],
      localDelivery: { deliverReturn: (packet) => (offered.push(Buffer.from(packet)), true) },
      policy: { access: "open", ...uncapped },
    })
    try {
      await relay.start()
      const to = { host: "1.2.3.4", port: 4101 }
      const frame = dataFrame()
      const packet = encodeEnvelope(to, frame)
      assert.equal(relay.forwardForLocal(packet, to), "ok")
      assert.equal(offered.length, 1)
      assert.equal(relay.stats.limitedBy.destination, 0)
      assert.equal(relay.stats.droppedLimited, 0)
      const dests = (relay as unknown as { dests: { remaining(endpoint: Endpoint): number | null } }).dests
      assert.equal(dests.remaining(to), UNVERIFIED_DEST_BYTES - packet.length)
    } finally {
      await relay.close()
    }
  })

  it("still charges an envelope destination the self-forward did not name", async () => {
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      allowRemote: true,
      advertise: [{ host: "1.2.3.4", port: 4101 }],
      policy: { access: "open", ...uncapped },
    })
    try {
      await relay.start()
      const socket = (relay as unknown as { socket: Socket }).socket
      let sentTo: Endpoint | null = null
      socket.send = ((_msg: unknown, port: number, host: string) => {
        sentTo = { host, port }
      }) as Socket["send"]
      const to = { host: "1.2.3.4", port: 4101 }
      const elsewhere = { host: "8.8.8.8", port: 4101 }
      const frame = dataFrame()
      const packet = encodeEnvelope(elsewhere, frame)
      assert.equal(relay.forwardForLocal(packet, to), "ok")
      assert.deepEqual(sentTo, elsewhere)
      const dests = (relay as unknown as { dests: { remaining(endpoint: Endpoint): number | null } }).dests
      assert.equal(dests.remaining(to), UNVERIFIED_DEST_BYTES - packet.length)
      assert.equal(dests.remaining(elsewhere), UNVERIFIED_DEST_BYTES - frame.length)
      assert.equal(relay.stats.limitedBy.destination, 0)
    } finally {
      await relay.close()
    }
  })

  it("charges a self-forwarded envelope once against the datagram rate", async () => {
    const offered: Buffer[] = []
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      localDelivery: { deliverReturn: (packet) => (offered.push(Buffer.from(packet)), true) },
      policy: { access: "open", ...uncapped, datagramRatePerSec: 1 },
    })
    try {
      await relay.start()
      const first = relay.forwardForLocal(encodeEnvelope(relay.endpoint, dataFrame()), relay.endpoint)
      assert.equal(first, "ok")
      assert.equal(offered.length, 1)
      assert.equal(relay.stats.limitedBy.datagram, 0)
      assert.equal(relay.stats.droppedLimited, 0)
      const second = relay.forwardForLocal(encodeEnvelope(relay.endpoint, dataFrame()), relay.endpoint)
      assert.equal(second, "limited")
      assert.equal(offered.length, 1)
      assert.equal(relay.stats.limitedBy.datagram, 1)
      assert.equal(relay.stats.limitedBy.bandwidth, 0)
      assert.equal(relay.stats.droppedLimited, 1)
    } finally {
      await relay.close()
    }
  })

  it("does not report success when a self-forward is refused after admission", async () => {
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      localDelivery: { deliverReturn: () => false },
      policy: { access: "open", ...uncapped },
    })
    try {
      await relay.start()
      const result = relay.forwardForLocal(encodeEnvelope(relay.endpoint, dataFrame()), relay.endpoint)
      assert.equal(result, "invalid")
      assert.equal(relay.stats.forwarded, 0)
      assert.equal(relay.stats.droppedInvalid, 1)
    } finally {
      await relay.close()
    }
  })

  it("does not report success when the simulated network drops a self-forward", async () => {
    const offered: Buffer[] = []
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      adversity: { blackhole: true },
      localDelivery: { deliverReturn: (packet) => (offered.push(Buffer.from(packet)), true) },
      policy: { access: "open", ...uncapped },
    })
    try {
      await relay.start()
      const result = relay.forwardForLocal(encodeEnvelope(relay.endpoint, dataFrame()), relay.endpoint)
      assert.equal(result, "invalid")
      assert.equal(offered.length, 0)
      assert.equal(relay.stats.forwarded, 0)
      assert.equal(relay.stats.droppedBlackhole, 1)
    } finally {
      await relay.close()
    }
  })

  it("charges a forward to another relay once", async () => {
    const bytes = encodeEnvelope({ host: "127.0.0.1", port: 1 }, dataFrame()).length
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      policy: { access: "open", ...uncapped, bandwidthBps: bytes },
    })
    await withSink(async ({ sinkAt, got }) => {
      const first = relay.forwardForLocal(encodeEnvelope(sinkAt, dataFrame()), sinkAt)
      assert.equal(first, "ok")
      assert.equal(relay.stats.limitedBy.bandwidth, 0)
      const second = relay.forwardForLocal(encodeEnvelope(sinkAt, dataFrame()), sinkAt)
      assert.equal(second, "limited")
      assert.equal(relay.stats.limitedBy.bandwidth, 1)
      assert.equal(relay.stats.droppedLimited, 1)
      await waitFor(() => got.length === 1)
      await sleep(30)
      assert.equal(got.length, 1)
      assert.equal(relay.stats.limitedBy.bandwidth, 1)
    }, relay)
  })

  it("charges a datagram that arrives by UDP once", async () => {
    const bytes = encodeEnvelope({ host: "127.0.0.1", port: 1 }, dataFrame()).length
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      policy: { access: "open", ...uncapped, bandwidthBps: bytes },
    })
    const tx = createUdpSocket()
    const sink = createUdpSocket()
    const got: Buffer[] = []
    sink.on("message", (msg) => got.push(Buffer.from(msg)))
    try {
      await relay.start()
      await bindUdp(tx, "127.0.0.1", 0)
      const sinkAt = await bindUdp(sink, "127.0.0.1", 0)
      await sendUdp(tx, encodeEnvelope(sinkAt, dataFrame()), relay.endpoint)
      await sendUdp(tx, encodeEnvelope(sinkAt, dataFrame()), relay.endpoint)
      await waitFor(() => got.length === 1)
      await sleep(30)
      assert.equal(got.length, 1)
      assert.equal(relay.stats.limitedBy.bandwidth, 1)
      assert.equal(relay.stats.droppedLimited, 1)
    } finally {
      await closeUdp(tx)
      await closeUdp(sink)
      await relay.close()
    }
  })

  it("counts a delayed self-forward when the frame is delivered, not when it is queued", async () => {
    const offered: Buffer[] = []
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      adversity: { delayMs: 40 },
      localDelivery: { deliverReturn: (packet) => (offered.push(Buffer.from(packet)), true) },
      policy: { access: "open", ...uncapped },
    })
    try {
      await relay.start()
      const result = relay.forwardForLocal(encodeEnvelope(relay.endpoint, dataFrame()), relay.endpoint)
      assert.equal(result, "ok")
      assert.equal(offered.length, 0)
      assert.equal(relay.stats.forwarded, 0)
      assert.equal(relay.stats.droppedLimited, 0)
      await waitFor(() => offered.length === 1)
      assert.equal(relay.stats.forwarded, 1)
      assert.equal(relay.stats.droppedLimited, 0)
    } finally {
      await relay.close()
    }
  })

  it("does not count a delayed self-forward that the handler later declines", async () => {
    const relay = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      adversity: { delayMs: 30 },
      localDelivery: { deliverReturn: () => false },
      policy: { access: "open", ...uncapped },
    })
    try {
      await relay.start()
      const result = relay.forwardForLocal(encodeEnvelope(relay.endpoint, dataFrame()), relay.endpoint)
      assert.equal(result, "ok")
      assert.equal(relay.stats.forwarded, 0)
      await sleep(80)
      assert.equal(relay.stats.forwarded, 0)
      assert.equal(relay.stats.droppedInvalid, 1)
      assert.equal(relay.stats.droppedLimited, 0)
    } finally {
      await relay.close()
    }
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
