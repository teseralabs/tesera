// The client's WebTransport transport against tesera's production attachment listener:
//
//   TeseraClient --WebTransport--> relay A (attachment) --UDP--> relays B, C, D --UDP--> relay E (attachment) --WebTransport--> TeseraClient
//
// The relays and listeners are the native build from the repository's dist. The WebTransport client is
// @fails-components/webtransport, the optional dependency the relay already uses for its listener.
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { after, before, describe, it } from "node:test"
import { TeseraClient, TeseraError, webTransport, type Endpoint, type SinkWriter, type WebTransportConstructor } from "../src/index.js"
import { native } from "./native.js"

type Lib = { WebTransport: WebTransportConstructor; Http3Server: any; quicheLoaded: Promise<void> }
let lib: Lib | null = null
const optional = "@fails-components/webtransport"
try {
  lib = (await import(optional)) as unknown as Lib
  await lib.quicheLoaded
} catch {
  lib = null
}
const skip = lib ? false : "the optional @fails-components/webtransport package is not installed"

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const loopback = { allowRemote: true, allowDest: ["127.0.0.0/8"], policy: { access: "open", bandwidthBps: 0, maxSessions: 0, peerRatePerMin: 0, datagramRatePerSec: 0 } }

type Attachment = { relay: any; listener: any; url: string }
let A: Attachment
let E: Attachment
let udp: any[] = []
let certificateHash = ""

async function attachmentRelay(cert: unknown): Promise<Attachment> {
  const { Relay } = await native("relay/relay.js")
  const { WebTransportListener } = await native("attach/listener.js")
  const { generateIdentity } = await native("identity/id.js")
  const listener = new WebTransportListener({ host: "127.0.0.1", port: 0, cert, logLevel: "error" })
  const relay = new Relay({ host: "127.0.0.1", identity: generateIdentity(), ...loopback, localDelivery: listener.localDelivery })
  await relay.start()
  const at = await listener.start(relay)
  return { relay, listener, url: `https://127.0.0.1:${at.port}` }
}

function client(attachment: Attachment, opts: { certificateHash?: string } = {}) {
  if (!lib) throw new Error("no webtransport")
  return new TeseraClient({
    transport: webTransport({ url: attachment.url, certificateHash: opts.certificateHash ?? certificateHash, WebTransport: lib.WebTransport }),
  })
}

function collect() {
  const parts: Uint8Array[] = []
  let aborted = false
  const sink: SinkWriter = {
    write: (chunk) => {
      parts.push(chunk.slice())
    },
    abort: () => {
      aborted = true
    },
  }
  return { sink, bytes: () => Buffer.concat(parts), aborted: () => aborted }
}

async function settled(check: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await sleep(25)
  }
  return check()
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof TeseraError, `expected a TeseraError, got ${String(err)}`)
    assert.equal(err.code, code, err.message)
    return true
  })
}

const relays = (): Endpoint[] => udp.map((relay) => relay.endpoint)

describe("WebTransport through production attachment relays", { skip }, () => {
  before(async () => {
    const { generateSelfSigned } = await native("attach/cert.js")
    const cert = generateSelfSigned()
    certificateHash = cert.hash.toString("hex")
    A = await attachmentRelay(cert)
    E = await attachmentRelay(cert)
    const { Relay } = await native("relay/relay.js")
    udp = []
    for (let i = 0; i < 3; i++) {
      const relay = new Relay({ host: "127.0.0.1", ...loopback })
      await relay.start()
      udp.push(relay)
    }
  })

  after(async () => {
    for (const at of [A, E]) {
      await at?.listener.close()
      await at?.relay.close()
    }
    for (const relay of udp) await relay.close().catch(() => {})
  })

  it("transfers a stream end to end and fits shards to the attachments", async () => {
    const payload = randomBytes(2_000_000)
    const out = collect()
    const outgoing = await client(A).send(payload, { relays: relays(), hash: true })
    // The offer and the secret are what the receiver needs; only the offer may cross a relay.
    assert.deepEqual(outgoing.offer.sender, A.relay.endpoint)
    const incoming = await client(E).receive({ offer: outgoing.offer, secret: outgoing.secret, sink: out.sink, hash: true })
    assert.deepEqual(incoming.answer.receiver, E.relay.endpoint)
    const [sent, received] = await Promise.all([outgoing.start(incoming.answer), incoming.done])
    assert.equal(received.sha256, sha(payload))
    assert.equal(sent.sha256, sha(payload))
    assert.ok(out.bytes().equals(payload))
    const datagram = outgoing.diagnostics()["datagramSize"] ?? Infinity
    assert.ok(datagram <= Math.min(outgoing.diagnostics()["maxPacketSize"] ?? 0, incoming.answer.maxPacketSize))
  })

  it("recovers when a UDP relay dies mid-transfer", async () => {
    const payload = randomBytes(3_000_000)
    const out = collect()
    let killed = false
    const victim = udp[2]
    const outgoing = await client(A).send(payload, {
      relays: relays(),
      hash: true,
      onProgress: (p) => {
        if (!killed && p.bytes > payload.length / 3) {
          killed = true
          void victim.close()
        }
      },
    })
    const incoming = await client(E).receive({ offer: outgoing.offer, secret: outgoing.secret, sink: out.sink, hash: true })
    const [, received] = await Promise.all([outgoing.start(incoming.answer), incoming.done])
    assert.ok(killed)
    assert.equal(received.sha256, sha(payload))
    const { Relay } = await native("relay/relay.js")
    udp[2] = new Relay({ host: "127.0.0.1", ...loopback })
    await udp[2].start()
  })

  it("refuses a second claim on a live session with a claim error", async () => {
    const outgoing = await client(A).send(randomBytes(1000), { relays: relays() })
    const first = await client(E).receive({ offer: outgoing.offer, secret: outgoing.secret, sink: collect().sink })
    await rejectsWith(client(E).receive({ offer: outgoing.offer, secret: outgoing.secret, sink: collect().sink }), "claim")
    first.cancel()
    outgoing.cancel()
    await rejectsWith(first.done, "cancelled")
  })

  it("releases the attachment and its claim when a receiver cancels", async () => {
    // Earlier receivers linger briefly for late acknowledgements before they detach.
    assert.ok(await settled(() => E.listener.attachments.size === 0, 8000))
    const before = 0
    const out = collect()
    const outgoing = await client(A).send(randomBytes(4_000_000), { relays: relays() })
    const incoming = await client(E).receive({ offer: outgoing.offer, secret: outgoing.secret, sink: out.sink })
    assert.equal(E.listener.attachments.size, before + 1)
    void outgoing.start(incoming.answer).catch(() => {})
    await sleep(150)
    incoming.cancel()
    await rejectsWith(incoming.done, "cancelled")
    assert.ok(out.aborted())
    assert.ok(await settled(() => E.listener.attachments.size === before), "the attachment stayed")
    // The session is free again: a new receiver may claim it.
    const again = await client(E).receive({ offer: outgoing.offer, secret: outgoing.secret, sink: collect().sink })
    again.cancel()
    outgoing.cancel()
    assert.ok(await settled(() => A.listener.attachments.size === 0 && E.listener.attachments.size === 0))
  })

  it("connects when one of several pinned hashes matches", async () => {
    if (!lib) return
    const transport = webTransport({ url: A.url, certificateHash: ["00".repeat(32), certificateHash], WebTransport: lib.WebTransport })
    const outgoing = await new TeseraClient({ transport }).send(randomBytes(10), { relays: relays() })
    outgoing.cancel()
  })

  it("stays attached while waiting, by saying hello", async () => {
    if (!lib) return
    const { Relay } = await native("relay/relay.js")
    const { WebTransportListener } = await native("attach/listener.js")
    const { generateSelfSigned } = await native("attach/cert.js")
    const { generateIdentity } = await native("identity/id.js")
    const cert = generateSelfSigned()
    const listener = new WebTransportListener({ host: "127.0.0.1", port: 0, cert, logLevel: "error", limits: { idleMs: 500 }, sweepMs: 50 })
    const relay = new Relay({ host: "127.0.0.1", identity: generateIdentity(), ...loopback, localDelivery: listener.localDelivery })
    await relay.start()
    const at = await listener.start(relay)
    try {
      const url = `https://127.0.0.1:${at.port}`
      const hash = cert.hash.toString("hex")
      const kept = await new TeseraClient({ transport: webTransport({ url, certificateHash: hash, WebTransport: lib.WebTransport, keepaliveMs: 150 }) }).send(randomBytes(10), { relays: relays() })
      const dropped = await new TeseraClient({ transport: webTransport({ url, certificateHash: hash, WebTransport: lib.WebTransport, keepaliveMs: 60_000 }) }).send(randomBytes(10), { relays: relays() })
      await sleep(1500)
      await rejectsWith(dropped.done, "connection")
      assert.equal(listener.attachments.size, 1, "only the connection that said hello is still attached")
      kept.cancel()
      await rejectsWith(kept.done, "cancelled")
    } finally {
      await listener.close()
      await relay.close()
    }
  })

  it("fails to connect with the wrong certificate hash", async () => {
    await rejectsWith(client(A, { certificateHash: "00".repeat(32) }).send(randomBytes(10), { relays: relays() }), "connection")
  })

  it("reports a runtime without WebTransport as unsupported", async () => {
    const plain = new TeseraClient({ transport: webTransport({ url: A.url }) })
    await rejectsWith(plain.send(randomBytes(10), { relays: relays() }), "unsupported")
  })

  it("refuses a relay that answers another attach version", async () => {
    if (!lib) return
    const { generateSelfSigned } = await native("attach/cert.js")
    const { ATTACH_PATH } = await native("attach/framing.js")
    const cert = generateSelfSigned()
    const server = new lib.Http3Server({ host: "127.0.0.1", port: 0, secret: "x".repeat(32), cert: cert.cert, privKey: cert.privKey })
    server.startServer()
    await server.ready
    void (async () => {
      const sessions = (await server.sessionStream(ATTACH_PATH)).getReader()
      for (;;) {
        const { value: session, done } = await sessions.read()
        if (done) return
        await session.ready
        const streams = session.incomingBidirectionalStreams.getReader()
        const { value: stream } = await streams.read()
        if (!stream) continue
        const writer = stream.writable.getWriter()
        await writer.write(new Uint8Array([9, 1, 127, 0, 0, 1, 0, 80]))
        await writer.close()
      }
    })()
    const other = new TeseraClient({
      transport: webTransport({ url: `https://127.0.0.1:${server.address().port}`, certificateHash: cert.hash.toString("hex"), WebTransport: lib.WebTransport }),
    })
    await rejectsWith(other.send(randomBytes(10), { relays: relays() }), "incompatible")
    server.stopServer()
  })
})
