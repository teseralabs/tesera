import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { listenPublicApi, type PublicApi } from "../src/api/public.js"
import { signStatement } from "../src/attach/statement.js"
import { Discovery, type DiscoveryDocument } from "../src/control/discovery.js"
import { Rendezvous } from "../src/control/rendezvous.js"
import { generateIdentity } from "../src/identity/id.js"
import { discoverRelays } from "../src/identity/peers.js"
import type { LogFields } from "../src/log.js"
import { Relay } from "../src/relay/relay.js"

const SESSION = "0123456789abcdef0123456789abcdef"
const offer = JSON.stringify({ v: 1, sessionId: SESSION, sender: { host: "203.0.113.1", port: 4101 }, relays: [{ host: "203.0.113.9", port: 4101 }], k: 1, n: 1 })
const answer = JSON.stringify({ v: 1, sessionId: SESSION, receiver: { host: "203.0.113.2", port: 4101 }, maxPacketSize: 1200 })
const hash = "ab".repeat(32)

describe("control plane api", () => {
  const identity = generateIdentity()
  let relay: Relay
  let api: PublicApi
  let base: string
  let discovery: Discovery
  const rooms = new Rendezvous()
  const logs: { event: string; fields: LogFields }[] = []

  before(async () => {
    relay = new Relay({
      host: "127.0.0.1",
      identity,
      api: { host: "127.0.0.1", port: 0 },
      transportStatements: () => [signStatement(identity, { attach: 1, certificates: [{ sha256: hash, notAfter: Math.floor(Date.now() / 1000) + 3600 }] })],
    })
    const seed = await relay.start()
    const local = relay.apiEndpoint!
    discovery = new Discovery({
      entries: [{ relay: identity.id, url: "https://edge.example:4433", statement: `http://${local.host}:${local.port}/v1/transports` }],
      udpRelays: () => discoverRelays(seed, { pinned: identity.id }),
    })
    await discovery.start()
    api = await listenPublicApi("127.0.0.1", 0, {
      discovery,
      rendezvous: rooms,
      limits: { roomCreates: 9 },
      log: (event, fields) => logs.push({ event, fields }),
    })
    base = `http://${api.endpoint.host}:${api.endpoint.port}`
  })

  after(async () => {
    discovery.stop()
    await api.close()
    await relay.close()
  })

  const open = async () => {
    const response = await fetch(`${base}/v1/rooms`, { method: "POST", body: offer })
    assert.equal(response.status, 201)
    return (await response.json()) as { room: string; token: string; expiresAt: number }
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  it("lists the relay with its signed WebTransport entry and its UDP address", async () => {
    const response = await fetch(`${base}/v1/relays`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("access-control-allow-origin"), "*")
    const doc = (await response.json()) as DiscoveryDocument
    assert.equal(doc.v, 1)
    assert.equal(doc.relays.length, 1)
    assert.equal(doc.relays[0]?.id, identity.id)
    const [wt, udp] = doc.relays[0]!.transports
    assert.equal(wt?.type, "webtransport")
    assert.equal(wt.type === "webtransport" && wt.certificateHashes[0]?.sha256, hash)
    assert.deepEqual(udp, { type: "udp", host: relay.endpoint.host, port: relay.endpoint.port })
  })

  it("carries an offer and an answer between two endpoints, then closes the room", async () => {
    const { room, token, expiresAt } = await open()
    assert.ok(expiresAt > Date.now() / 1000)
    const joined = await fetch(`${base}/v1/rooms/${room}`)
    assert.equal(joined.status, 200)
    assert.equal(await joined.text(), offer, "the offer comes back byte for byte")
    const waiting = fetch(`${base}/v1/rooms/${room}/answer?wait=20`, { headers: auth(token) })
    const answered = await fetch(`${base}/v1/rooms/${room}/answer`, { method: "POST", body: answer })
    assert.equal(answered.status, 204)
    const got = await waiting
    assert.equal(got.status, 200)
    assert.equal(await got.text(), answer)
    const closed = await fetch(`${base}/v1/rooms/${room}`, { method: "DELETE", headers: auth(token) })
    assert.equal(closed.status, 204)
    assert.equal((await fetch(`${base}/v1/rooms/${room}`)).status, 404)
  })

  it("ends an empty wait with 204, and 404 once the sender cancels", async () => {
    const { room, token } = await open()
    assert.equal((await fetch(`${base}/v1/rooms/${room}/answer?wait=0`, { headers: auth(token) })).status, 204)
    const waiting = fetch(`${base}/v1/rooms/${room}/answer?wait=20`, { headers: auth(token) })
    await new Promise((r) => setTimeout(r, 50))
    await fetch(`${base}/v1/rooms/${room}`, { method: "DELETE", headers: auth(token) })
    assert.equal((await waiting).status, 404)
  })

  it("refuses a second answer, a stale answer, and a late joiner", async () => {
    const { room } = await open()
    const stale = answer.replace(SESSION, "f".repeat(32))
    assert.equal((await fetch(`${base}/v1/rooms/${room}/answer`, { method: "POST", body: stale })).status, 409)
    assert.equal((await fetch(`${base}/v1/rooms/${room}/answer`, { method: "POST", body: answer })).status, 204)
    assert.equal((await fetch(`${base}/v1/rooms/${room}/answer`, { method: "POST", body: answer })).status, 204, "the same answer again")
    const other = answer.replace("203.0.113.2", "198.51.100.2")
    const second = await fetch(`${base}/v1/rooms/${room}/answer`, { method: "POST", body: other })
    assert.equal(second.status, 409)
    assert.deepEqual(await second.json(), { error: "answered" })
    assert.equal((await fetch(`${base}/v1/rooms/${room}`)).status, 409)
  })

  it("needs the sender's token to read the answer or close the room", async () => {
    const { room } = await open()
    const { token: other } = await open()
    assert.equal((await fetch(`${base}/v1/rooms/${room}/answer`)).status, 401)
    assert.equal((await fetch(`${base}/v1/rooms/${room}/answer`, { headers: auth(other) })).status, 403)
    assert.equal((await fetch(`${base}/v1/rooms/${room}`, { method: "DELETE" })).status, 401)
    assert.equal((await fetch(`${base}/v1/rooms/${room}`, { method: "DELETE", headers: auth(other) })).status, 403)
  })

  it("refuses malformed input", async () => {
    const post = (path: string, body: string) => fetch(`${base}${path}`, { method: "POST", body })
    assert.equal((await post("/v1/rooms", "{nope")).status, 400)
    assert.equal((await post("/v1/rooms", JSON.stringify({ v: 1 }))).status, 400)
    assert.equal((await fetch(`${base}/v1/rooms/not-a-room`)).status, 400)
    assert.equal((await fetch(`${base}/v1/rooms/${"A".repeat(22)}`)).status, 404)
    assert.equal((await fetch(`${base}/v1/rooms/${"A".repeat(22)}/answer?wait=x`, { headers: auth("abc") })).status, 400)
    assert.equal((await fetch(`${base}/v1/rooms`)).status, 405)
    assert.equal((await fetch(`${base}/v1/relays`, { method: "POST" })).status, 405)
    const big = await post("/v1/rooms", JSON.stringify({ v: 1, sessionId: SESSION, pad: "x".repeat(20_000) })).catch(() => null)
    assert.ok(big === null || big.status === 413)
  })

  it("allows a browser to call every route", async () => {
    const response = await fetch(`${base}/v1/rooms/x`, { method: "OPTIONS" })
    assert.equal(response.status, 204)
    assert.match(response.headers.get("access-control-allow-methods") ?? "", /DELETE/)
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /authorization/)
  })

  it("limits how many rooms one address opens", async () => {
    let status = 201
    for (let i = 0; i < 10 && status === 201; i++) {
      status = (await fetch(`${base}/v1/rooms`, { method: "POST", body: offer })).status
    }
    assert.equal(status, 429)
  })

  it("never logs a room id or a token", () => {
    const text = JSON.stringify(logs)
    assert.ok(logs.some((line) => line.event === "rendezvous"))
    for (const line of logs) {
      for (const value of Object.values(line.fields)) assert.doesNotMatch(String(value), /^[A-Za-z0-9_-]{22}$/)
    }
    assert.doesNotMatch(text, /Bearer/)
  })
})
