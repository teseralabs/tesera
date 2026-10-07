import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { signStatement, STATEMENT_TTL_SEC, type PinnedCertificate } from "../src/attach/statement.js"
import { Discovery, DISCOVERY_MAX_AGE_SEC, parseEntries, type EntryConfig } from "../src/control/discovery.js"
import { generateIdentity, type Identity } from "../src/identity/id.js"

const hash = (n: number) => n.toString(16).padStart(64, "0")

function setup(opts: { certificates?: PinnedCertificate[]; signer?: Identity } = {}) {
  const relay = generateIdentity()
  const clock = { now: 1_800_000_000_000 }
  const nowSec = () => Math.floor(clock.now / 1000)
  const certificates = opts.certificates ?? [{ sha256: hash(1), notAfter: nowSec() + 86_400 }]
  const fetched: string[] = []
  const served: { body: unknown; fail: boolean } = { body: null, fail: false }
  const sign = () => ({ statements: [signStatement(opts.signer ?? relay, { attach: 1, certificates }, nowSec())] })
  served.body = sign()
  const entry: EntryConfig = { relay: relay.id, url: "https://edge.example:4433", statement: "http://127.0.0.1:9/v1/transports" }
  const udp = [{ id: relay.id, endpoint: { host: "203.0.113.5", port: 4101 } }, { id: generateIdentity().id, endpoint: { host: "203.0.113.6", port: 4101 } }]
  const discovery = new Discovery({
    entries: [entry],
    udpRelays: async () => udp,
    fetchJson: async (url) => {
      fetched.push(url)
      if (served.fail) throw new Error("down")
      return served.body
    },
    now: () => clock.now,
  })
  return { relay, clock, nowSec, discovery, served, sign, fetched, udp, certificates }
}

describe("discovery entries file", () => {
  const id = generateIdentity().id

  it("reads entries", () => {
    const entries = parseEntries(JSON.stringify({ entries: [{ relay: id, url: "https://edge.example:4433/", statement: "http://127.0.0.1:4190/v1/transports" }] }))
    assert.deepEqual(entries, [{ relay: id, url: "https://edge.example:4433", statement: "http://127.0.0.1:4190/v1/transports" }])
  })

  it("refuses a bad entry", () => {
    const ok = { relay: id, url: "https://edge.example:4433", statement: "http://127.0.0.1:1/v1/transports" }
    for (const bad of [
      "nope",
      "{}",
      JSON.stringify({ entries: [{ ...ok, relay: "relay:nope" }] }),
      JSON.stringify({ entries: [{ ...ok, url: "http://edge.example:4433" }] }),
      JSON.stringify({ entries: [{ ...ok, url: "https://edge.example:4433/tesera/attach/1" }] }),
      JSON.stringify({ entries: [{ ...ok, statement: "file:///etc/passwd" }] }),
    ]) {
      assert.throws(() => parseEntries(bad))
    }
  })
})

describe("discovery", () => {
  it("lists a relay's WebTransport entry and its UDP address under one id", async () => {
    const { discovery, relay, certificates, udp, nowSec } = setup()
    await discovery.refresh()
    const doc = discovery.document()
    assert.equal(doc.v, 1)
    assert.equal(doc.relays.length, 2)
    assert.deepEqual(doc.relays[0], {
      id: relay.id,
      transports: [
        { type: "webtransport", url: "https://edge.example:4433", attach: 1, certificateHashes: certificates },
        { type: "udp", host: "203.0.113.5", port: 4101 },
      ],
    })
    assert.deepEqual(doc.relays[1], { id: udp[1]!.id, transports: [{ type: "udp", host: "203.0.113.6", port: 4101 }] })
    assert.equal(doc.expiresAt, nowSec() + DISCOVERY_MAX_AGE_SEC)
  })

  it("leaves out an entry whose statement another key signed", async () => {
    const { discovery } = setup({ signer: generateIdentity() })
    await discovery.refresh()
    const doc = discovery.document()
    assert.equal(doc.relays.flatMap((r) => r.transports).some((t) => t.type === "webtransport"), false)
  })

  it("keeps the last verified statement through a failed fetch, until it expires", async () => {
    const { discovery, served, clock } = setup()
    await discovery.refresh()
    served.fail = true
    clock.now += 60_000
    await discovery.refresh()
    assert.ok(discovery.document().relays[0]?.transports.some((t) => t.type === "webtransport"))
    clock.now += STATEMENT_TTL_SEC * 1000
    await discovery.refresh()
    assert.equal(discovery.document().relays[0]?.transports.some((t) => t.type === "webtransport"), false)
  })

  it("publishes the current and next certificate together, and drops an expired one", async () => {
    const now = Math.floor(1_800_000_000_000 / 1000)
    const certificates = [{ sha256: hash(1), notAfter: now + 120 }, { sha256: hash(2), notAfter: now + 86_400 }]
    const { discovery, clock } = setup({ certificates })
    await discovery.refresh()
    let wt = discovery.document().relays[0]?.transports[0]
    assert.equal(wt?.type, "webtransport")
    assert.deepEqual(wt.type === "webtransport" && wt.certificateHashes, certificates)
    assert.equal(discovery.document().expiresAt, now + 120, "a client asks again before a listed pin expires")
    clock.now += 121_000
    wt = discovery.document().relays[0]?.transports[0]
    assert.deepEqual(wt?.type === "webtransport" && wt.certificateHashes, [certificates[1]])
  })

  it("skips a statement it can't verify for one that verifies, and refetches on refresh", async () => {
    const { discovery, served, sign, fetched } = setup()
    const signed = sign().statements[0]!
    served.body = { statements: [{ statement: "e30", signature: "AA" }, signed] }
    await discovery.refresh()
    await discovery.refresh()
    assert.equal(fetched.length, 2)
    assert.ok(discovery.document().relays[0]?.transports.some((t) => t.type === "webtransport"))
  })

  it("still lists UDP relays when the seed table can't be read on a later refresh", async () => {
    const relay = generateIdentity()
    let fail = false
    const discovery = new Discovery({
      entries: [],
      udpRelays: async () => {
        if (fail) throw new Error("seed down")
        return [{ id: relay.id, endpoint: { host: "203.0.113.5", port: 4101 } }]
      },
    })
    await discovery.refresh()
    fail = true
    await discovery.refresh()
    assert.equal(discovery.document().relays.length, 1)
  })
})
