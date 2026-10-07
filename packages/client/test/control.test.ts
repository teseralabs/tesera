// The control plane from the client's side: a real `tesera api` (discovery and rendezvous) in this
// process, and tesera's in-memory network for the data plane. Every request and response the client
// exchanges with the control plane is recorded and searched for the secret, derived keys, and data.
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { after, before, describe, it } from "node:test"
import {
  httpControlPlane,
  joinTransfer,
  parseDirectory,
  shareTransfer,
  TeseraClient,
  TeseraError,
  type ControlPlane,
  type SinkWriter,
} from "../src/index.js"
import { memoryWorld, type MemoryWorld } from "./memory-transport.js"
import { native } from "./native.js"

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function collect() {
  const parts: Uint8Array[] = []
  const sink: SinkWriter = { write: (chunk) => void parts.push(chunk.slice()) }
  return { sink, bytes: () => Buffer.concat(parts) }
}

async function rejectsWith(promise: Promise<unknown>, code: string, reason?: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof TeseraError, `expected a TeseraError, got ${String(err)}`)
    assert.equal(err.code, code, err.message)
    if (reason) assert.equal(err.reason, reason, err.message)
    return true
  })
}

describe("parseDirectory", () => {
  const now = 1_800_000_000
  const id = "relay:aaaa"
  const hash = "ab".repeat(32)

  it("reads relays and their transports, ignoring what it doesn't know", () => {
    const dir = parseDirectory(
      {
        v: 1,
        expiresAt: now + 60,
        future: { ignored: true },
        relays: [
          {
            id,
            region: "ignored",
            transports: [
              { type: "quic-v9", endpoint: "x" },
              { type: "webtransport", url: "https://edge.example:4433", attach: 1, certificateHashes: [{ sha256: hash, notAfter: now + 10, extra: 1 }] },
              { type: "udp", host: "203.0.113.5", port: 4101 },
            ],
          },
        ],
      },
      now,
    )
    assert.deepEqual(dir, {
      expiresAt: now + 60,
      relays: [{ id, udp: { host: "203.0.113.5", port: 4101 }, webTransport: { url: "https://edge.example:4433", attach: 1, certificateHashes: [hash] } }],
    })
  })

  it("drops expired pins, and a WebTransport entry whose pins all expired", () => {
    const wt = (hashes: unknown[]) => ({ v: 1, expiresAt: now, relays: [{ id, transports: [{ type: "webtransport", url: "https://e.example", attach: 1, certificateHashes: hashes }] }] })
    assert.deepEqual(parseDirectory(wt([{ sha256: hash, notAfter: now - 1 }, { sha256: "cd".repeat(32), notAfter: now + 5 }]), now).relays[0]?.webTransport?.certificateHashes, ["cd".repeat(32)])
    assert.equal(parseDirectory(wt([{ sha256: hash, notAfter: now }]), now).relays.length, 0)
    assert.deepEqual(parseDirectory(wt([]), now).relays[0]?.webTransport?.certificateHashes, [], "no pins: a publicly trusted certificate")
  })

  it("leaves out entries it can't use or read", () => {
    const dir = parseDirectory(
      {
        v: 1,
        relays: [
          { id, transports: [{ type: "webtransport", url: "https://e.example", attach: 2, certificateHashes: [] }] },
          { id, transports: [{ type: "webtransport", url: "http://e.example", attach: 1, certificateHashes: [] }] },
          { id, transports: [{ type: "udp", host: "", port: 4101 }, { type: "udp", host: "h", port: 70000 }] },
          { id: "not-a-relay", transports: [{ type: "udp", host: "h", port: 1 }] },
          null,
          "x",
          { id, transports: "nope" },
        ],
      },
      now,
    )
    assert.deepEqual(dir.relays, [])
  })

  it("refuses another document version, and a document that isn't one", () => {
    assert.throws(() => parseDirectory({ v: 2, relays: [] }), (err: unknown) => err instanceof TeseraError && err.code === "incompatible")
    assert.throws(() => parseDirectory([]), (err: unknown) => err instanceof TeseraError && err.code === "control")
  })
})

describe("share and join through a control plane", () => {
  let world: MemoryWorld
  let relay: any
  let api: any
  let rooms: any
  let discovery: any
  let base = ""
  const logs: string[] = []
  const exchanged: string[] = []
  let control: ControlPlane

  /** A control plane client that records every request and response body, and every URL. */
  const recorded = (url: string) =>
    httpControlPlane(url, {
      fetch: async (input, init) => {
        exchanged.push(`${init?.method ?? "GET"} ${String(input)} ${JSON.stringify(init?.headers ?? {})} ${String(init?.body ?? "")}`)
        const response = await fetch(input, init)
        const text = await response.clone().text()
        exchanged.push(text)
        return response
      },
    })

  const start = async (limits: Record<string, number> = {}) => {
    const { listenPublicApi } = await native("api/public.js")
    const { Rendezvous } = await native("control/rendezvous.js")
    rooms = new Rendezvous(limits)
    api = await listenPublicApi("127.0.0.1", 0, {
      discovery,
      rendezvous: rooms,
      limits: { roomCreates: 1000, infoRequests: 100_000 },
      log: (event: string, fields: object) => logs.push(`${event} ${JSON.stringify(fields)}`),
    })
    base = `http://${api.endpoint.host}:${api.endpoint.port}`
    control = recorded(base)
  }

  before(async () => {
    world = await memoryWorld(3)
    const { Relay } = await native("relay/relay.js")
    const { generateIdentity } = await native("identity/id.js")
    const { Discovery } = await native("control/discovery.js")
    relay = new Relay({ host: "127.0.0.1", port: 0, identity: generateIdentity() })
    await relay.start()
    const listed = world.relays.map((r) => ({ id: generateIdentity().id, endpoint: r.endpoint }))
    discovery = new Discovery({ entries: [], udpRelays: async () => listed })
    await discovery.refresh()
    await start()
  })

  after(async () => {
    await api.close()
    await relay.close()
    await world.close()
  })

  const clients = () => ({ sender: new TeseraClient({ transport: world.transport() }), receiver: new TeseraClient({ transport: world.transport() }) })

  it("moves a transfer, with the secret and the data kept out of the control plane", async () => {
    const payload = randomBytes(600_000)
    const { sender, receiver } = clients()
    exchanged.length = 0
    const share = await shareTransfer(sender, control, payload, { hash: true })
    assert.match(share.room, /^[A-Za-z0-9_-]{22}$/)
    assert.equal(share.transfer.offer.relays.length, 3, "three paths from discovery, in the listed order")
    const out = collect()
    const incoming = await joinTransfer(receiver, control, { room: share.room, secret: share.secret, sink: out.sink, hash: true })
    const [sent, received] = await Promise.all([share.done, incoming.done])
    assert.equal(received.sha256, sha(payload))
    assert.equal(sent.sha256, sha(payload))

    const { deriveKeys } = await native("crypto/session.js")
    const keys = deriveKeys(Buffer.from(share.secret, "hex"), Buffer.from(share.transfer.offer.sessionId, "hex"))
    const haystack = [...exchanged, ...logs, JSON.stringify([...rooms.rooms.values()])].join("\n")
    const needles = {
      secret: share.secret,
      secretBase64: Buffer.from(share.secret, "hex").toString("base64"),
      aeadKey: keys.aeadKey.toString("hex"),
      macKey: keys.macKey.toString("hex"),
      plaintext: payload.subarray(1000, 1032).toString("hex"),
      plaintextBase64: payload.subarray(1000, 1032).toString("base64"),
    }
    for (const [name, needle] of Object.entries(needles)) assert.equal(haystack.includes(needle), false, `${name} reached the control plane`)
    // The scan finds what it looks for: the offer's session id did go through, as it should.
    assert.ok(haystack.includes(share.transfer.offer.sessionId))
    for (const line of logs) assert.equal(line.includes(share.room), false, "a log line names the room")
    assert.equal(rooms.size, 0, "the sender closed the room once it had the answer")
  })

  it("waits for a receiver that joins late", async () => {
    const payload = randomBytes(50_000)
    const { sender, receiver } = clients()
    const share = await shareTransfer(sender, control, payload)
    await sleep(1500)
    const out = collect()
    const incoming = await joinTransfer(receiver, control, { room: share.room, secret: share.secret, sink: out.sink })
    await Promise.all([share.done, incoming.done])
    assert.ok(out.bytes().equals(payload))
  })

  it("turns a receiver away after the sender cancels", async () => {
    const { sender, receiver } = clients()
    const share = await shareTransfer(sender, control, randomBytes(1000))
    share.cancel()
    await rejectsWith(share.done, "cancelled")
    await sleep(50)
    await rejectsWith(joinTransfer(receiver, control, { room: share.room, secret: share.secret, sink: collect().sink }), "control", "not_found")
  })

  it("lets a receiver cancel, and frees its connection", async () => {
    const world2 = world.transport()
    const { sender } = clients()
    const receiver = new TeseraClient({ transport: world2 })
    const share = await shareTransfer(sender, control, randomBytes(5_000_000))
    const incoming = await joinTransfer(receiver, control, { room: share.room, secret: share.secret, sink: collect().sink })
    incoming.cancel()
    await rejectsWith(incoming.done, "cancelled")
    share.cancel()
    await rejectsWith(share.done, "cancelled")
    assert.ok(await (async () => {
      for (let i = 0; i < 100 && world2.open() > 0; i++) await sleep(20)
      return world2.open() === 0
    })())
  })

  it("refuses an unknown room, and a malformed one", async () => {
    const { receiver } = clients()
    const secret = randomBytes(32).toString("hex")
    await rejectsWith(joinTransfer(receiver, control, { room: "A".repeat(22), secret, sink: collect().sink }), "control", "not_found")
    await rejectsWith(joinTransfer(receiver, control, { room: "../x", secret, sink: collect().sink }), "control")
    await rejectsWith(joinTransfer(receiver, control, { room: "A".repeat(22), secret: "nope", sink: collect().sink }), "invalid")
  })

  it("tells a second receiver the room was already answered", async () => {
    const payload = randomBytes(20_000)
    const { sender, receiver } = clients()
    const share = await shareTransfer(sender, control, payload)
    const incoming = await joinTransfer(receiver, control, { room: share.room, secret: share.secret, sink: collect().sink })
    const late = new TeseraClient({ transport: world.transport() })
    const second = joinTransfer(late, control, { room: share.room, secret: share.secret, sink: collect().sink })
    await rejectsWith(second, "control")
    await Promise.all([share.done, incoming.done])
  })

  it("refuses a stale answer for another session, and still takes the real one", async () => {
    const payload = randomBytes(20_000)
    const { sender, receiver } = clients()
    const share = await shareTransfer(sender, control, payload)
    const stale = { v: 1, sessionId: "f".repeat(32), receiver: { host: "127.0.0.1", port: 9 }, maxPacketSize: 1200 }
    const response = await fetch(`${base}/v1/rooms/${share.room}/answer`, { method: "POST", body: JSON.stringify(stale) })
    assert.equal(response.status, 409)
    const out = collect()
    const incoming = await joinTransfer(receiver, control, { room: share.room, secret: share.secret, sink: out.sink })
    await Promise.all([share.done, incoming.done])
    assert.ok(out.bytes().equals(payload))
  })

  it("refuses a malformed offer at the receiver", async () => {
    const { receiver } = clients()
    const created = await fetch(`${base}/v1/rooms`, { method: "POST", body: JSON.stringify({ v: 1, sessionId: "a".repeat(32), relays: "nope" }) })
    const { room } = (await created.json()) as { room: string }
    await rejectsWith(joinTransfer(receiver, control, { room, secret: randomBytes(32).toString("hex"), sink: collect().sink }), "invalid")
  })

  it("refuses a malformed answer at the sender", async () => {
    const { sender } = clients()
    const share = await shareTransfer(sender, control, randomBytes(1000))
    const bad = { v: 1, sessionId: share.transfer.offer.sessionId, maxPacketSize: 1200 }
    assert.equal((await fetch(`${base}/v1/rooms/${share.room}/answer`, { method: "POST", body: JSON.stringify(bad) })).status, 204)
    await rejectsWith(share.done, "invalid")
  })

  it("keeps transferring after the control plane goes away", async () => {
    const payload = randomBytes(8_000_000)
    const { sender, receiver } = clients()
    const share = await shareTransfer(sender, control, payload, { hash: true })
    const out = collect()
    const incoming = await joinTransfer(receiver, control, { room: share.room, secret: share.secret, sink: out.sink, hash: true })
    let finished = false
    void incoming.done.then(() => (finished = true))
    await api.close()
    assert.equal(finished, false, "the control plane closed while the transfer was still running")
    await rejectsWith(control.discover(), "control", "unreachable")
    const [, received] = await Promise.all([share.done, incoming.done])
    assert.equal(received.sha256, sha(payload))
    await start()
  })

  it("reports an unreachable control plane", async () => {
    const { sender } = clients()
    const gone = httpControlPlane("http://127.0.0.1:9")
    await rejectsWith(shareTransfer(sender, gone, randomBytes(10)), "control", "unreachable")
  })

  it("ends the wait when the room expires", async () => {
    await api.close()
    await start({ ttlMs: 1200 })
    const { sender, receiver } = clients()
    const share = await shareTransfer(sender, control, randomBytes(1000))
    await rejectsWith(share.done, "control")
    await rejectsWith(joinTransfer(receiver, control, { room: share.room, secret: share.secret, sink: collect().sink }), "control", "not_found")
    await api.close()
    await start()
  })
})
