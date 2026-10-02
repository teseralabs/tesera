import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { after, before, describe, it } from "node:test"
import { PROTOCOL_VERSION } from "../src/constants.js"
import { listenPublicApi, type PublicApi } from "../src/api/public.js"
import { SOFTWARE_VERSION } from "../src/identity/record.js"
import { recordDocument } from "../src/identity/record.js"
import { formatSession } from "../src/crypto/session.js"
import { generateIdentity } from "../src/identity/id.js"
import { Relay } from "../src/relay/relay.js"
import { sleep } from "../src/util.js"

describe("public api", () => {
  let relay: Relay
  let api: PublicApi
  let base: string

  before(async () => {
    relay = new Relay({ host: "127.0.0.1", port: 0, identity: generateIdentity() })
    const seed = await relay.start()
    api = await listenPublicApi("127.0.0.1", 0, { discover: seed, advertise: "127.0.0.1" })
    base = `http://${api.endpoint.host}:${api.endpoint.port}`
  })

  after(async () => {
    await api.close()
    await relay.close()
  })

  it("describes the api at the root", async () => {
    const response = await fetch(`${base}/`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/)
    const body = (await response.json()) as {
      name: string
      software: string
      wire: number
      endpoints: { send: string; receive: string; record: string; stats: string; peers: string }
      docs: string
    }
    assert.equal(body.name, "tesera public api")
    assert.equal(body.software, SOFTWARE_VERSION)
    assert.equal(body.wire, PROTOCOL_VERSION)
    assert.deepEqual(body.endpoints, {
      send: "POST /v0/send",
      receive: "POST /v0/receive",
      record: "GET /v0/record",
      stats: "GET /v0/stats",
      peers: "GET /v0/peers",
    })
    assert.equal(body.docs, "https://tesera.net/api.html")
    assert.equal("relays" in body, false)
  })

  it("rejects GET /v0/receive instead of waiting for a transfer", async () => {
    const response = await fetch(`${base}/v0/receive`, {
      headers: { "x-tesera-session": formatSession(randomBytes(32)) },
    })
    assert.equal(response.status, 405)
    assert.equal(((await response.json()) as { error: string }).error, "method")
  })

  it("returns the seed snapshot and the relays it introduces", async () => {
    const stats = await fetch(`${base}/v0/stats`)
    assert.equal(stats.status, 200)
    const snapshot = (await stats.json()) as { relays: number; bytes: number; transfers: number }
    assert.equal(snapshot.relays, 1)
    assert.equal(snapshot.bytes, 0)
    assert.equal(snapshot.transfers, 0)
    const peers = await fetch(`${base}/v0/peers`)
    assert.equal(peers.status, 200)
    const directory = (await peers.json()) as { relays: { id: string; host: string; port: number }[] }
    assert.equal(directory.relays.length, 1)
    assert.match(directory.relays[0]?.id ?? "", /^relay:/)
    assert.equal(directory.relays[0]?.host, relay.endpoint.host)
    assert.equal(directory.relays[0]?.port, relay.endpoint.port)
  })

  it("returns the seed record decoded from the signed packet", async () => {
    const response = await fetch(`${base}/v0/record`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { packet: string; record: { id: string; seq: string } }
    const doc = recordDocument(Buffer.from(body.packet, "base64"))
    assert.ok(doc)
    assert.deepEqual(body.record, doc.record)
    assert.equal(body.record.seq, "1")
    assert.equal("bytes" in body, false)
  })

  it("moves bytes when the caller leaves relays unset", async () => {
    const session = formatSession(randomBytes(32))
    const payload = Buffer.from("hello from the api")
    const headers = { "x-tesera-session": session, "x-tesera-deadline-ms": "8000" }
    const [received, sent] = await Promise.all([
      fetch(`${base}/v0/receive`, { method: "POST", headers }),
      fetch(`${base}/v0/send`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/octet-stream" },
        body: payload,
      }),
    ])
    assert.equal(sent.status, 200)
    assert.equal(received.status, 200)
    const stats = (await sent.json()) as { bytes: number; relays: number; tesserae: number; acks: number }
    assert.equal(stats.bytes, payload.length)
    assert.equal(stats.relays, 1)
    assert.ok(stats.tesserae >= 1)
    assert.ok(stats.acks >= 1)
    assert.equal(Buffer.from(await received.arrayBuffer()).toString(), payload.toString())
    assert.equal(received.headers.get("x-tesera-bytes"), String(payload.length))
    assert.equal(received.headers.get("cache-control"), "no-store")
    assert.equal(sent.headers.get("cache-control"), "no-store")
  })

  it("uses relays the caller names", async () => {
    const session = formatSession(randomBytes(32))
    const payload = Buffer.from("named relay")
    const headers = {
      "x-tesera-session": session,
      "x-tesera-relays": `${relay.endpoint.host}:${relay.endpoint.port}`,
      "x-tesera-deadline-ms": "8000",
      "x-tesera-k": "1",
      "x-tesera-n": "1",
    }
    const [received, sent] = await Promise.all([
      fetch(`${base}/v0/receive`, { method: "POST", headers }),
      fetch(`${base}/v0/send`, { method: "POST", headers, body: payload }),
    ])
    assert.equal(sent.status, 200)
    assert.equal(received.status, 200)
    assert.equal(Buffer.from(await received.arrayBuffer()).toString(), payload.toString())
  })

  it("rejects a missing session, an empty send, and a second receive", async () => {
    const missing = await fetch(`${base}/v0/send`, { method: "POST", body: Buffer.from("x") })
    assert.equal(missing.status, 400)
    assert.equal(((await missing.json()) as { error: string }).error, "session")
    assert.equal(missing.headers.get("cache-control"), "no-store")

    const session = formatSession(randomBytes(32))
    const empty = await fetch(`${base}/v0/send`, {
      method: "POST",
      headers: { "x-tesera-session": session },
    })
    assert.equal(empty.status, 400)
    assert.equal(((await empty.json()) as { error: string }).error, "empty")

    const headers = {
      "x-tesera-session": session,
      "x-tesera-relays": `${relay.endpoint.host}:${relay.endpoint.port}`,
      "x-tesera-deadline-ms": "8000",
    }
    const waiting = new AbortController()
    const first = fetch(`${base}/v0/receive`, { method: "POST", headers, signal: waiting.signal })
    await sleep(100)
    const second = await fetch(`${base}/v0/receive`, { method: "POST", headers })
    assert.equal(second.status, 409)
    assert.equal(((await second.json()) as { error: string }).error, "in_use")
    waiting.abort()
    await first.catch(() => {})
  })

  it("refuses a send that names different relays", async () => {
    const session = formatSession(randomBytes(32))
    const headers = {
      "x-tesera-session": session,
      "x-tesera-relays": `${relay.endpoint.host}:${relay.endpoint.port}`,
      "x-tesera-deadline-ms": "8000",
    }
    const waiting = new AbortController()
    const receive = fetch(`${base}/v0/receive`, { method: "POST", headers, signal: waiting.signal })
    await sleep(100)
    const sent = await fetch(`${base}/v0/send`, {
      method: "POST",
      headers: { ...headers, "x-tesera-relays": "127.0.0.1:9" },
      body: Buffer.from("no"),
    })
    assert.equal(sent.status, 409)
    assert.equal(((await sent.json()) as { error: string }).error, "relays")
    waiting.abort()
    await receive.catch(() => {})
  })

  it("times out when the other side never arrives", async () => {
    const session = formatSession(randomBytes(32))
    const response = await fetch(`${base}/v0/receive`, {
      method: "POST",
      headers: {
        "x-tesera-session": session,
        "x-tesera-relays": `${relay.endpoint.host}:${relay.endpoint.port}`,
        "x-tesera-deadline-ms": "1000",
      },
    })
    assert.equal(response.status, 408)
    assert.equal(((await response.json()) as { error: string }).error, "timeout")
  })

  it("rejects a payload over the limit", async () => {
    const small = await listenPublicApi("127.0.0.1", 0, {
      discover: relay.endpoint,
      advertise: "127.0.0.1",
      maxBytes: 8,
    })
    try {
      const response = await fetch(`http://${small.endpoint.host}:${small.endpoint.port}/v0/send`, {
        method: "POST",
        headers: { "x-tesera-session": formatSession(randomBytes(32)) },
        body: Buffer.alloc(100),
      })
      assert.equal(response.status, 413)
      assert.equal(((await response.json()) as { error: string }).error, "size")
    } finally {
      await small.close()
    }
  })
})
