// Discovery and rendezvous over real attachment relays. Neither client is told a WebTransport URL or a
// certificate hash: both come from discovery, which reads each relay's signed statement.
//
//   sender --WebTransport--> relay A --UDP--> B, C, D --UDP--> relay A or E --WebTransport--> receiver
//                 control plane: tesera api with discovery and rendezvous, in this process
//
// The seed lists B, C, and D, and not A's UDP address, unless a test lists A as the live network does.
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { after, before, describe, it } from "node:test"
import {
  discoveryTransport,
  httpControlPlane,
  joinTransfer,
  shareTransfer,
  TeseraClient,
  type ClientTransport,
  type ControlPlane,
  type SinkWriter,
  type WebTransportConstructor,
} from "../src/index.js"
import { native } from "./native.js"

type Lib = { WebTransport: WebTransportConstructor; quicheLoaded: Promise<void> }
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
const loopback = { allowRemote: true, allowDest: ["127.0.0.0/8"], policy: { access: "open", bandwidthBps: 0, maxSessions: 0, peerRatePerMin: 0, datagramRatePerSec: 0 } }

type Entry = { relay: any; listener: any; id: string; url: string; statement: string }

function collect() {
  const parts: Uint8Array[] = []
  const sink: SinkWriter = { write: (chunk) => void parts.push(chunk.slice()) }
  return { sink, bytes: () => Buffer.concat(parts) }
}

describe("discovery and rendezvous over WebTransport attachment relays", { skip }, () => {
  let A: Entry
  let E: Entry
  let udp: any[] = []
  let udpIds: string[] = []
  /** What the seed lists: B, C, and D by default. */
  let seedTable: () => { id: string; endpoint: any }[] = () => []
  let entries: { relay: string; url: string; statement: string }[] = []
  let discovery: any
  let api: any
  let control: ControlPlane & { discovered: () => number }

  async function attachmentRelay(): Promise<Entry> {
    const { Relay } = await native("relay/relay.js")
    const { WebTransportListener } = await native("attach/listener.js")
    const { generateSelfSigned } = await native("attach/cert.js")
    const { signStatement } = await native("attach/statement.js")
    const { generateIdentity } = await native("identity/id.js")
    const identity = generateIdentity()
    const listener = new WebTransportListener({ host: "127.0.0.1", port: 0, cert: generateSelfSigned(), logLevel: "error" })
    const relay = new Relay({
      host: "127.0.0.1",
      identity,
      ...loopback,
      api: { host: "127.0.0.1", port: 0 },
      localDelivery: listener.localDelivery,
      transportStatements: () => {
        const cert = listener.certificate
        return [signStatement(identity, { attach: 1, certificates: [{ sha256: cert.hash.toString("hex"), notAfter: Math.floor(cert.notAfter / 1000) }] })]
      },
    })
    await relay.start()
    const at = await listener.start(relay)
    const local = relay.apiEndpoint
    return { relay, listener, id: identity.id, url: `https://127.0.0.1:${at.port}`, statement: `http://${local.host}:${local.port}/v1/transports` }
  }

  const entryOf = (at: Entry) => ({ relay: at.id, url: at.url, statement: at.statement })
  const defaultSeed = () => udp.map((relay, i) => ({ id: udpIds[i]!, endpoint: relay.endpoint }))
  const same = (a: { host: string; port: number }, b: { host: string; port: number }) => a.host === b.host && a.port === b.port

  /** Lists `count` of B, C, and D after A, which carries UDP too, as the live seed lists its relays. */
  async function seedWithA(count: number) {
    seedTable = () => [{ id: A.id, endpoint: A.relay.endpoint }, ...defaultSeed().slice(0, count)]
    await discovery.refresh()
  }

  async function restoreSeed() {
    seedTable = defaultSeed
    await discovery.refresh()
  }

  /**
   * Sends `size` bytes and, a third of the way in, closes the UDP relay `pick` chooses from the
   * offer. A relay that is no path, or is the sender's or receiver's attachment relay, fails the test.
   */
  async function transferKilling(size: number, pick: (paths: { host: string; port: number }[]) => { host: string; port: number }, join: { avoidSenderEntry?: boolean } = {}) {
    const payload = randomBytes(size)
    let killed: { host: string; port: number } | null = null
    let paths: { host: string; port: number }[] = []
    let attachments: { host: string; port: number }[] = []
    const share = await shareTransfer(new TeseraClient({ transport: transport() }), control, payload, {
      hash: true,
      onProgress: (p) => {
        if (killed || p.bytes <= payload.length / 3) return
        killed = pick(paths)
        assert.ok(paths.some((path) => same(path, killed!)), "the killed relay is a path in the offer")
        assert.ok(!attachments.some((end) => same(end, killed!)), "the killed relay is not an attachment relay")
        const index = udp.findIndex((relay) => same(relay.endpoint, killed!))
        assert.ok(index >= 0, "the killed relay is one of B, C, and D")
        void udp[index].close()
      },
    })
    paths = share.transfer.offer.relays
    const incoming = await joinTransfer(new TeseraClient({ transport: transport() }), control, { room: share.room, secret: share.secret, sink: collect().sink, hash: true, ...join })
    attachments = [share.transfer.offer.sender, incoming.answer.receiver]
    const [sent, received] = await Promise.all([share.done, incoming.done])
    assert.ok(killed, "a relay was killed")
    assert.equal(received.sha256, sha(payload))
    assert.equal(sent.sha256, sha(payload))
    const index = udp.findIndex((relay) => same(relay.endpoint, killed!))
    udp[index] = await udpRelay()
    await discovery.refresh()
    return { paths, sender: share.transfer.offer.sender, receiver: incoming.answer.receiver, k: share.transfer.offer.k, n: share.transfer.offer.n }
  }

  async function udpRelay() {
    const { Relay } = await native("relay/relay.js")
    const relay = new Relay({ host: "127.0.0.1", ...loopback })
    await relay.start()
    return relay
  }

  async function startApi() {
    const { listenPublicApi } = await native("api/public.js")
    api = await listenPublicApi("127.0.0.1", 0, { discovery, limits: { roomCreates: 1000 } })
    const plane = httpControlPlane(`http://${api.endpoint.host}:${api.endpoint.port}`)
    let discovered = 0
    control = {
      ...plane,
      discover: (signal) => {
        discovered++
        return plane.discover(signal)
      },
      discovered: () => discovered,
    }
  }

  const transport = (opts: { connectTimeoutMs?: number } = {}): ClientTransport =>
    discoveryTransport(control, { WebTransport: lib!.WebTransport, ...opts })

  before(async () => {
    const { Discovery } = await native("control/discovery.js")
    const { generateIdentity } = await native("identity/id.js")
    A = await attachmentRelay()
    E = await attachmentRelay()
    udp = [await udpRelay(), await udpRelay(), await udpRelay()]
    udpIds = udp.map(() => generateIdentity().id)
    entries = [entryOf(A), entryOf(E)]
    seedTable = defaultSeed
    discovery = new Discovery({ entries, udpRelays: async () => seedTable() })
    await discovery.refresh()
    await startApi()
  })

  after(async () => {
    await api?.close()
    for (const at of [A, E]) {
      await at?.listener.close()
      await at?.relay.close()
    }
    for (const relay of udp) await relay.close().catch(() => {})
  })

  let senderTransport: ClientTransport
  let receiverTransport: ClientTransport

  it("transfers with every WebTransport detail from discovery, both ends on the first listed relay", async () => {
    senderTransport = transport()
    receiverTransport = transport()
    const before = control.discovered()
    const payload = randomBytes(3_000_000)
    const share = await shareTransfer(new TeseraClient({ transport: senderTransport }), control, payload, { hash: true })
    assert.deepEqual(share.transfer.offer.sender, A.relay.endpoint, "the sender took the first listed entry")
    // A has no UDP listing here, so the paths are the other 3, in listed order.
    assert.deepEqual(share.transfer.offer.relays, udp.map((relay) => relay.endpoint))
    const out = collect()
    const incoming = await joinTransfer(new TeseraClient({ transport: receiverTransport }), control, { room: share.room, secret: share.secret, sink: out.sink, hash: true })
    assert.deepEqual(incoming.answer.receiver, A.relay.endpoint, "the receiver shares the sender's relay")
    const [sent, received] = await Promise.all([share.done, incoming.done])
    assert.equal(received.sha256, sha(payload))
    assert.equal(sent.sha256, sha(payload))
    // One read each: the sender's transport connects with the directory the share just read.
    assert.equal(control.discovered() - before, 2)
  })

  it("transfers when discovery lists only one WebTransport entry", async () => {
    entries.splice(1)
    await discovery.refresh()
    try {
      const listed = (await control.discover()) as { relays: { transports: { type: string }[] }[] }
      assert.equal(listed.relays.filter((r) => r.transports.some((t) => t.type === "webtransport")).length, 1)
      const payload = randomBytes(2_000_000)
      const share = await shareTransfer(new TeseraClient({ transport: transport() }), control, payload, { hash: true })
      const incoming = await joinTransfer(new TeseraClient({ transport: transport() }), control, { room: share.room, secret: share.secret, sink: collect().sink, hash: true })
      const [sent, received] = await Promise.all([share.done, incoming.done])
      assert.equal(received.sha256, sha(payload))
      assert.equal(sent.sha256, sha(payload))
    } finally {
      entries.push(entryOf(E))
      await discovery.refresh()
    }
  })

  it("puts the receiver on another entry when it asks for one", async () => {
    const payload = randomBytes(2_000_000)
    const share = await shareTransfer(new TeseraClient({ transport: transport() }), control, payload, { hash: true })
    const incoming = await joinTransfer(new TeseraClient({ transport: transport() }), control, {
      room: share.room,
      secret: share.secret,
      sink: collect().sink,
      hash: true,
      avoidSenderEntry: true,
    })
    assert.deepEqual(incoming.answer.receiver, E.relay.endpoint)
    const [, received] = await Promise.all([share.done, incoming.done])
    assert.equal(received.sha256, sha(payload))
  })

  it("recovers when a UDP relay in the offer dies mid-transfer", async () => {
    const { paths } = await transferKilling(4_000_000, (listed) => listed[1]!)
    assert.equal(paths.length, 3)
  })

  it("codes across A, B, and C on a network of 3, and survives B or C dying", async () => {
    await seedWithA(2)
    try {
      for (const which of [0, 1]) {
        const { paths, sender, k, n } = await transferKilling(3_000_000, (listed) => listed[which]!)
        assert.deepEqual([k, n], [2, 3])
        assert.deepEqual(sender, A.relay.endpoint)
        assert.deepEqual(paths.slice(2), [A.relay.endpoint], "A is a path only after B and C")
        assert.equal(paths.length, 3)
      }
    } finally {
      await restoreSeed()
    }
  })

  it("leaves the attachment relay out when B, C, and D are listed with it", async () => {
    await seedWithA(3)
    try {
      const expected = udp.map((relay) => relay.endpoint)
      const { paths } = await transferKilling(2_000_000, (listed) => listed[2]!)
      assert.deepEqual(paths, expected, "B, C, and D in listed order")
    } finally {
      await restoreSeed()
    }
  })

  it("keeps a valid transfer with the receiver on another entry, and the entries off the paths", async () => {
    await seedWithA(3)
    try {
      const { paths, sender, receiver } = await transferKilling(2_000_000, (listed) => listed[0]!, { avoidSenderEntry: true })
      assert.deepEqual(sender, A.relay.endpoint)
      assert.deepEqual(receiver, E.relay.endpoint)
      assert.ok(!paths.some((path) => same(path, A.relay.endpoint) || same(path, E.relay.endpoint)))
    } finally {
      await restoreSeed()
    }
  })

  it("fetches discovery again when its cached certificate hashes went stale", async () => {
    const { generateSelfSigned } = await native("attach/cert.js")
    await A.listener.useCert(generateSelfSigned())
    await E.listener.useCert(generateSelfSigned())
    await discovery.refresh()
    const before = control.discovered()
    const payload = randomBytes(200_000)
    const share = await shareTransfer(new TeseraClient({ transport: senderTransport }), control, payload, { hash: true })
    const incoming = await joinTransfer(new TeseraClient({ transport: receiverTransport }), control, { room: share.room, secret: share.secret, sink: collect().sink, hash: true })
    const [, received] = await Promise.all([share.done, incoming.done])
    assert.equal(received.sha256, sha(payload))
    // shareTransfer reads discovery fresh for relays, and the sender's transport keeps that read.
    // The receiver's transport reads it once more after its pinned hash failed.
    assert.equal(control.discovered() - before, 2)
  })

  it("moves past a listed entry that is down", async () => {
    const X = await attachmentRelay()
    entries.unshift(entryOf(X))
    await discovery.refresh()
    await X.listener.close()
    await X.relay.close()
    const payload = randomBytes(200_000)
    const share = await shareTransfer(new TeseraClient({ transport: transport({ connectTimeoutMs: 2000 }) }), control, payload, { hash: true })
    assert.deepEqual(share.transfer.offer.sender, A.relay.endpoint)
    const incoming = await joinTransfer(new TeseraClient({ transport: transport({ connectTimeoutMs: 2000 }) }), control, { room: share.room, secret: share.secret, sink: collect().sink, hash: true })
    assert.deepEqual(incoming.answer.receiver, A.relay.endpoint)
    const [, received] = await Promise.all([share.done, incoming.done])
    assert.equal(received.sha256, sha(payload))
    entries.shift()
    await discovery.refresh()
  })

  it("can route paths through the attachment relays themselves", async () => {
    const payload = randomBytes(500_000)
    const relays = [A.relay.endpoint, udp[0].endpoint, E.relay.endpoint]
    const share = await shareTransfer(new TeseraClient({ transport: transport() }), control, payload, { hash: true, relays })
    const incoming = await joinTransfer(new TeseraClient({ transport: transport() }), control, { room: share.room, secret: share.secret, sink: collect().sink, hash: true })
    const [, received] = await Promise.all([share.done, incoming.done])
    assert.equal(received.sha256, sha(payload))
  })

  it("finishes a transfer after the control plane goes away", async () => {
    const payload = randomBytes(6_000_000)
    const share = await shareTransfer(new TeseraClient({ transport: transport() }), control, payload, { hash: true })
    const incoming = await joinTransfer(new TeseraClient({ transport: transport() }), control, { room: share.room, secret: share.secret, sink: collect().sink, hash: true })
    let finished = false
    void incoming.done.then(() => (finished = true))
    await api.close()
    assert.equal(finished, false)
    const [, received] = await Promise.all([share.done, incoming.done])
    assert.equal(received.sha256, sha(payload))
    await startApi()
  })

  // Last, because it closes A. Losing the relay a browser attaches through ends that browser's
  // connection, which coding across paths can't repair.
  it("stops when the shared attachment relay A dies, though A is also a path", async () => {
    await seedWithA(2)
    const payload = randomBytes(4_000_000)
    let killed = false
    const share = await shareTransfer(new TeseraClient({ transport: transport() }), control, payload, {
      hash: true,
      onProgress: (p) => {
        if (killed || p.bytes <= payload.length / 3) return
        killed = true
        void A.listener.close().then(() => A.relay.close())
      },
    })
    assert.ok(share.transfer.offer.relays.some((path) => same(path, A.relay.endpoint)), "A is a path")
    const incoming = await joinTransfer(new TeseraClient({ transport: transport() }), control, { room: share.room, secret: share.secret, sink: collect().sink, hash: true, idleMs: 3_000 })
    const outcomes = await Promise.allSettled([share.done, incoming.done])
    assert.ok(killed)
    assert.deepEqual(outcomes.map((o) => o.status), ["rejected", "rejected"])
  })
})
