import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, type Endpoint } from "../src/carrier/udp.js"
import { encodeEnvelope } from "../src/protocol/envelope.js"
import { encodeAck, encodeData } from "../src/protocol/frames.js"
import { generateIdentity } from "../src/identity/id.js"
import { Relay } from "../src/relay/relay.js"
import { generateSelfSigned, type WebTransportCert } from "../src/attach/cert.js"
import { WebTransportListener } from "../src/attach/listener.js"
import {
  ATTACH_PATH,
  CLAIM,
  CLAIM_OK,
  decodeAddress,
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  FRAME_HEADER_LEN,
  HELLO,
} from "../src/attach/framing.js"
import { sessionOf } from "../src/attach/attachments.js"
import { sleep } from "../src/util.js"

// The real WebTransport library is an optional native addon. Skip cleanly where it is not built.
let available = true
let WebTransportClient: new (url: string, opts: unknown) => WtClient
try {
  const lib = (await import("@fails-components/webtransport")) as unknown as {
    WebTransport: new (url: string, opts: unknown) => WtClient
    quicheLoaded?: Promise<unknown>
  }
  if (lib.quicheLoaded) await lib.quicheLoaded
  WebTransportClient = lib.WebTransport
} catch {
  available = false
  WebTransportClient = class {} as never
}

type WtClient = {
  ready: Promise<void>
  closed: Promise<unknown>
  close(info?: unknown): void
  createBidirectionalStream(): Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>
  datagrams: {
    maxDatagramSize: number
    readable: ReadableStream<Uint8Array>
    writable?: WritableStream<Uint8Array>
    createWritable?: () => WritableStream<Uint8Array>
  }
}

type Client = {
  attachment: Endpoint
  maxPacketSize: number
  received: { packet: Buffer; from: Endpoint }[]
  send: (packet: Uint8Array, to: Endpoint) => Promise<void>
  sendRaw: (bytes: Uint8Array) => Promise<void>
  hello: () => Promise<Endpoint | null>
  closed: Promise<void>
  close: () => void
}

async function connect(listener: WebTransportListener, cert: WebTransportCert, claimSession?: Uint8Array): Promise<Client> {
  const url = `https://${listener.endpoint.host}:${listener.endpoint.port}${ATTACH_PATH}`
  const wt = new WebTransportClient(url, { serverCertificateHashes: [{ algorithm: "sha-256", value: cert.hash }] })
  await wt.ready
  const attachment = decodeAddress((await control(wt, encodeControl(HELLO))).body)
  assert.ok(attachment, "hello reply carries the attachment address")
  if (claimSession) {
    const reply = await control(wt, encodeControl(CLAIM, claimSession))
    assert.equal(reply.body[0], CLAIM_OK, "claim accepted")
  }
  const writer = (wt.datagrams.createWritable ? wt.datagrams.createWritable() : wt.datagrams.writable)!.getWriter()
  const received: { packet: Buffer; from: Endpoint }[] = []
  void (async () => {
    const reader = wt.datagrams.readable.getReader()
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
      if (done || !value) return
      const frame = decodeFrame(value)
      if (frame) received.push({ packet: Buffer.from(frame.packet), from: frame.address })
    }
  })()
  return {
    attachment,
    maxPacketSize: wt.datagrams.maxDatagramSize - FRAME_HEADER_LEN,
    received,
    send: (packet, to) => writer.write(encodeFrame(to, packet)),
    sendRaw: (bytes) => writer.write(bytes),
    hello: async () => decodeAddress((await control(wt, encodeControl(HELLO))).body),
    closed: wt.closed.then(
      () => undefined,
      () => undefined,
    ),
    close: () => wt.close(),
  }
}

async function opens(listener: WebTransportListener, cert: WebTransportCert): Promise<boolean> {
  const url = `https://${listener.endpoint.host}:${listener.endpoint.port}${ATTACH_PATH}`
  const wt = new WebTransportClient(url, { serverCertificateHashes: [{ algorithm: "sha-256", value: cert.hash }] })
  wt.closed.catch(() => {})
  const opened = await wt.ready.then(
    () => true,
    () => false,
  )
  if (opened) wt.close()
  return opened
}

async function control(wt: WtClient, request: Uint8Array) {
  const stream = await wt.createBidirectionalStream()
  const writer = stream.writable.getWriter()
  await writer.write(request)
  await writer.close()
  const reader = stream.readable.getReader()
  const parts: Buffer[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(Buffer.from(value))
  }
  const reply = decodeControl(Buffer.concat(parts))
  assert.ok(reply, "a control reply is a valid control message")
  return reply
}

async function withRelay(
  run: (ctx: { relay: Relay; listener: WebTransportListener; cert: WebTransportCert }) => Promise<void>,
  opts: { advertise?: Endpoint[]; limits?: { idleMs: number }; sweepMs?: number } = {},
): Promise<void> {
  const cert = generateSelfSigned()
  const listener = new WebTransportListener({ host: "127.0.0.1", port: 0, cert, limits: opts.limits, sweepMs: opts.sweepMs })
  const relay = new Relay({
    host: "127.0.0.1",
    identity: generateIdentity(),
    localDelivery: listener.localDelivery,
    advertise: opts.advertise,
  })
  await relay.start()
  await listener.start(relay)
  try {
    await run({ relay, listener, cert })
  } finally {
    await listener.close()
    await relay.close()
  }
}

function dataFrame(sessionId = randomBytes(16)): { frame: Buffer; hex: string } {
  const frame = encodeData({ kind: "data", sessionId, blockId: 0, tesseraIndex: 0, k: 1, n: 1, cipherLen: 32, payload: randomBytes(32) })
  const hex = sessionOf(frame)
  assert.ok(hex)
  return { frame, hex }
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting")
    await sleep(10)
  }
}

describe("webtransport attachment listener", { skip: available ? false : "native WebTransport addon not available" }, () => {
  it("establishes an attachment, reports a packet size, and shuts down cleanly", async () => {
    await withRelay(async ({ relay, listener, cert }) => {
      const client = await connect(listener, cert)
      assert.deepEqual(client.attachment, relay.endpoint, "the attachment address is the relay's own UDP address")
      assert.ok(client.maxPacketSize > 900 && client.maxPacketSize < 1400, `packet size ${client.maxPacketSize} is sane`)
      await waitFor(() => listener.stats.attachments === 1)
      client.close()
      await waitFor(() => listener.attachments.size === 0)
    })
  })

  it("forwards a browser datagram through the relay core to an allowed UDP destination", async () => {
    await withRelay(async ({ listener, cert }) => {
      const sink = createUdpSocket()
      const got: Buffer[] = []
      sink.on("message", (msg) => got.push(Buffer.from(msg)))
      try {
        const sinkAt = await bindUdp(sink, "127.0.0.1", 0)
        const client = await connect(listener, cert)
        const envelope = encodeEnvelope(sinkAt, dataFrame().frame)
        await client.send(envelope, sinkAt)
        await waitFor(() => got.length === 1)
        assert.deepEqual(got[0], envelope, "the relay forwarded the browser's envelope unchanged, one hop")
        assert.equal(listener.stats.forwarded, 1)
        client.close()
      } finally {
        await closeUdp(sink)
      }
    })
  })

  it("delivers a UDP return frame back to the browser that claimed the session", async () => {
    await withRelay(async ({ relay, listener, cert }) => {
      const udp = createUdpSocket()
      try {
        await bindUdp(udp, "127.0.0.1", 0)
        const { frame, hex } = dataFrame()
        const client = await connect(listener, cert, Buffer.from(hex, "hex"))
        await waitFor(() => listener.attachments.sessions === 1)
        // A UDP relay forwards the bare inner frame to the attachment address, which is the relay's UDP port.
        await sendUdp(udp, frame, relay.endpoint)
        await waitFor(() => client.received.length === 1)
        assert.deepEqual(client.received[0]?.packet, frame, "the claimed browser receives the return frame")
        client.close()
      } finally {
        await closeUdp(udp)
      }
    })
  })

  it("drops a return frame for an unclaimed session and never misroutes it", async () => {
    await withRelay(async ({ relay, listener, cert }) => {
      const udp = createUdpSocket()
      try {
        await bindUdp(udp, "127.0.0.1", 0)
        const client = await connect(listener, cert) // claims nothing
        await waitFor(() => listener.stats.attachments === 1)
        await sendUdp(udp, dataFrame().frame, relay.endpoint)
        await sleep(100)
        assert.equal(client.received.length, 0)
        assert.ok(listener.stats.returnUnmatched >= 1)
        client.close()
      } finally {
        await closeUdp(udp)
      }
    })
  })

  it("refuses to forward to a destination the relay policy disallows", async () => {
    // A loopback relay forwards only to loopback: a public destination is refused, so it is no open proxy.
    await withRelay(async ({ listener, cert }) => {
      const client = await connect(listener, cert)
      const target = { host: "8.8.8.8", port: 53 }
      await client.send(encodeEnvelope(target, dataFrame().frame), target)
      await waitFor(() => (listener.stats.droppedForward["denied"] ?? 0) === 1)
      assert.equal(listener.stats.forwarded, 0, "nothing is forwarded to a disallowed destination")
      client.close()
    })
  })

  it("counts a malformed attach frame and forwards nothing", async () => {
    await withRelay(async ({ listener, cert }) => {
      const client = await connect(listener, cert)
      // Raw bytes too short to be a frame, and then a frame with an unknown version: both are dropped.
      await client.sendRaw(new Uint8Array([1, 2, 3]))
      const wrongVersion = encodeFrame({ host: "127.0.0.1", port: 9 }, dataFrame().frame)
      wrongVersion[0] = 99
      await client.sendRaw(wrongVersion)
      await waitFor(() => listener.stats.droppedMalformed >= 2)
      assert.equal(listener.stats.forwarded, 0, "a malformed frame never causes a forward")
      client.close()
    })
  })

  it("answers a hello with the relay's advertised address", async () => {
    const advertised = { host: "203.0.113.7", port: 4101 }
    await withRelay(
      async ({ listener, cert }) => {
        const client = await connect(listener, cert)
        assert.deepEqual(client.attachment, advertised)
        client.close()
      },
      { advertise: [advertised] },
    )
  })

  it("refuses to start on every interface without an advertised address", async () => {
    const listener = new WebTransportListener({ host: "127.0.0.1", port: 0, cert: generateSelfSigned() })
    const relay = new Relay({ host: "0.0.0.0", identity: generateIdentity(), localDelivery: listener.localDelivery })
    await relay.start()
    try {
      await assert.rejects(listener.start(relay), /--advertise/)
    } finally {
      await listener.close()
      await relay.close()
    }
  })

  it("keeps an attachment that only says hello, and sweeps it once it stops", async () => {
    await withRelay(
      async ({ listener, cert }) => {
        const client = await connect(listener, cert)
        for (let i = 0; i < 8; i++) {
          await sleep(100)
          await client.hello()
        }
        assert.equal(listener.attachments.size, 1, "repeated hellos keep it")
        await waitFor(() => listener.attachments.size === 0, 3000)
        client.close()
      },
      { limits: { idleMs: 400 }, sweepMs: 50 },
    )
  })

  it("carries both ends of one session through one relay and an ordinary UDP relay", async () => {
    await withRelay(async ({ relay, listener, cert }) => {
      const udpRelay = new Relay({ host: "127.0.0.1", identity: generateIdentity() })
      await udpRelay.start()
      try {
        const sessionId = randomBytes(16)
        const { frame: data, hex } = dataFrame(sessionId)
        const ack = encodeAck({ kind: "ack", sessionId, blockId: 0 }, randomBytes(32))
        const receiver = await connect(listener, cert, Buffer.from(hex, "hex"))
        const sender = await connect(listener, cert)
        assert.deepEqual(sender.attachment, receiver.attachment, "both ends have the same attachment address")
        // Each end addresses the other at that one address, through the UDP relay.
        await sender.send(encodeEnvelope(receiver.attachment, data), udpRelay.endpoint)
        await waitFor(() => receiver.received.length === 1)
        await receiver.send(encodeEnvelope(sender.attachment, ack), udpRelay.endpoint)
        await waitFor(() => sender.received.length === 1)
        await sleep(100)
        assert.deepEqual(receiver.received.map((r) => r.packet), [data], "the receiver gets only the data")
        assert.deepEqual(sender.received.map((r) => r.packet), [ack], "the sender gets only the ack")
        assert.deepEqual(sender.received[0]?.from, udpRelay.endpoint, "it came back from the UDP relay")
        assert.equal(udpRelay.stats.forwarded, 2)
        sender.close()
        receiver.close()
      } finally {
        await udpRelay.close()
      }
    })
  })

  it("does not forward a frame from an end another attachment holds, or a payload that isn't a frame", async () => {
    await withRelay(async ({ listener, cert }) => {
      const sink = createUdpSocket()
      const got: Buffer[] = []
      sink.on("message", (msg) => got.push(Buffer.from(msg)))
      try {
        const sinkAt = await bindUdp(sink, "127.0.0.1", 0)
        const sessionId = randomBytes(16)
        const { frame: data, hex } = dataFrame(sessionId)
        const ack = encodeAck({ kind: "ack", sessionId, blockId: 0 }, randomBytes(32))
        const receiver = await connect(listener, cert, Buffer.from(hex, "hex"))
        const sender = await connect(listener, cert)
        await sender.send(encodeEnvelope(sinkAt, data), sinkAt)
        await waitFor(() => got.length === 1)
        const third = await connect(listener, cert)
        await third.send(encodeEnvelope(sinkAt, data), sinkAt)
        await third.send(encodeEnvelope(sinkAt, ack), sinkAt)
        await third.send(encodeEnvelope(sinkAt, Buffer.from("not a tesera frame at all, just bytes")), sinkAt)
        await waitFor(() => (listener.stats.droppedForward["taken"] ?? 0) === 2 && (listener.stats.droppedForward["ignored"] ?? 0) === 1)
        await sleep(100)
        assert.equal(got.length, 1, "only the sender's own frame left the relay")
        sender.close()
        receiver.close()
        third.close()
      } finally {
        await closeUdp(sink)
      }
    })
  })

  it("never forwards a frame that arrived over UDP a second time", async () => {
    await withRelay(async ({ relay, listener, cert }) => {
      const udp = createUdpSocket()
      const sink = createUdpSocket()
      const got: Buffer[] = []
      sink.on("message", (msg) => got.push(Buffer.from(msg)))
      try {
        await bindUdp(udp, "127.0.0.1", 0)
        const sinkAt = await bindUdp(sink, "127.0.0.1", 0)
        const { frame, hex } = dataFrame()
        const client = await connect(listener, cert, Buffer.from(hex, "hex"))
        await waitFor(() => listener.attachments.sessions === 1)
        const before = { relay: relay.stats.forwarded, listener: listener.stats.forwarded }
        // A bare frame for an attached end goes to the attachment and nowhere else.
        await sendUdp(udp, frame, relay.endpoint)
        // A bare frame for no attached end is dropped.
        await sendUdp(udp, dataFrame().frame, relay.endpoint)
        // An envelope around an envelope would be a second hop, and is refused.
        await sendUdp(udp, encodeEnvelope(relay.endpoint, encodeEnvelope(sinkAt, frame)), relay.endpoint)
        await waitFor(() => client.received.length === 1)
        await sleep(150)
        assert.equal(got.length, 0, "nothing went on over UDP")
        assert.equal(relay.stats.forwarded, before.relay)
        assert.equal(listener.stats.forwarded, before.listener)
        assert.equal(client.received.length, 1)
        client.close()
      } finally {
        await closeUdp(udp)
        await closeUdp(sink)
      }
    })
  })

  it("switches to a new certificate on the same port", async () => {
    await withRelay(async ({ listener, cert }) => {
      const port = listener.endpoint.port
      const before = await connect(listener, cert)
      const next = generateSelfSigned()
      await listener.useCert(next)
      await before.closed
      assert.equal(listener.endpoint.port, port)
      assert.equal(listener.certHash.toString("hex"), next.hash.toString("hex"))
      assert.equal(await opens(listener, cert), false, "the old pin no longer connects")
      const after = await connect(listener, next)
      assert.ok(after.attachment)
      after.close()
    })
  })
})
