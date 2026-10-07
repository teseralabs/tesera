import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { isRoomId, MAX_DOCUMENT_BYTES, Rendezvous, RendezvousError, RENDEZVOUS_TTL_MS } from "../src/control/rendezvous.js"

const SESSION = "0123456789abcdef0123456789abcdef"
const offer = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, sessionId: SESSION, sender: { host: "203.0.113.1", port: 4101 }, relays: [], k: 2, n: 3, ...fields })
const answer = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, sessionId: SESSION, receiver: { host: "203.0.113.2", port: 4101 }, maxPacketSize: 1200, ...fields })

function refused(run: () => unknown, status: number, code: string): void {
  assert.throws(run, (err: unknown) => err instanceof RendezvousError && err.status === status && err.code === code)
}

async function refusedAsync(run: () => Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(run(), (err: unknown) => err instanceof RendezvousError && err.status === status && err.code === code)
}

function store(limits = {}) {
  const clock = { now: 1_000_000 }
  return { clock, rooms: new Rendezvous(limits, () => clock.now) }
}

describe("rendezvous", () => {
  it("opens a room with a 128-bit id and token, and hands the offer over unchanged", () => {
    const { rooms, clock } = store()
    const text = offer({ extra: { kept: true } })
    const created = rooms.create(text)
    assert.ok(isRoomId(created.room))
    assert.equal(Buffer.from(created.room, "base64url").length, 16)
    assert.equal(Buffer.from(created.token, "base64url").length, 16)
    assert.equal(created.expiresAt, clock.now + RENDEZVOUS_TTL_MS)
    assert.equal(rooms.offer(created.room).offer, text)
  })

  it("never issues the same room twice", () => {
    const { rooms } = store({ maxRooms: 5000 })
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) seen.add(rooms.create(offer()).room)
    assert.equal(seen.size, 2000)
  })

  it("delivers an answer to a sender already waiting", async () => {
    const { rooms } = store()
    const { room, token } = rooms.create(offer())
    const waiting = rooms.waitAnswer(room, token, 10_000)
    rooms.answer(room, answer())
    assert.equal(await waiting, answer())
  })

  it("keeps the answer for a sender that asks after it arrived, or asks again", async () => {
    const { rooms } = store()
    const { room, token } = rooms.create(offer())
    rooms.answer(room, answer())
    assert.equal(await rooms.waitAnswer(room, token, 0), answer())
    assert.equal(await rooms.waitAnswer(room, token, 0), answer())
  })

  it("ends an empty wait with null and leaves the room open", async () => {
    const { rooms } = store()
    const { room, token } = rooms.create(offer())
    assert.equal(await rooms.waitAnswer(room, token, 20), null)
    assert.equal(rooms.size, 1)
  })

  it("lets one wait stand per room: a reconnecting sender replaces the old one", async () => {
    const { rooms } = store()
    const { room, token } = rooms.create(offer())
    const first = rooms.waitAnswer(room, token, 10_000)
    const second = rooms.waitAnswer(room, token, 10_000)
    assert.equal(await first, null)
    rooms.answer(room, answer())
    assert.equal(await second, answer())
  })

  it("takes the first answer, accepts the same one again, and refuses a different one", () => {
    const { rooms } = store()
    const { room } = rooms.create(offer())
    rooms.answer(room, answer())
    rooms.answer(room, answer())
    refused(() => rooms.answer(room, answer({ receiver: { host: "198.51.100.9", port: 1 } })), 409, "answered")
  })

  it("stops handing out the offer once answered, so a second joiner learns it is late", () => {
    const { rooms } = store()
    const { room } = rooms.create(offer())
    rooms.answer(room, answer())
    refused(() => rooms.offer(room), 409, "answered")
  })

  it("refuses an answer for another session", () => {
    const { rooms } = store()
    const { room } = rooms.create(offer())
    refused(() => rooms.answer(room, answer({ sessionId: "f".repeat(32) })), 409, "session")
  })

  it("needs the sender's token to wait or close", async () => {
    const { rooms } = store()
    const { room } = rooms.create(offer())
    const other = rooms.create(offer()).token
    await refusedAsync(() => rooms.waitAnswer(room, other, 0), 403, "token")
    refused(() => rooms.close(room, other), 403, "token")
  })

  it("closes a room on cancel, which ends a wait and turns away a joiner", async () => {
    const { rooms } = store()
    const { room, token } = rooms.create(offer())
    const waiting = rooms.waitAnswer(room, token, 10_000)
    rooms.close(room, token)
    assert.equal(await waiting, null)
    refused(() => rooms.offer(room), 404, "not_found")
    refused(() => rooms.answer(room, answer()), 404, "not_found")
  })

  it("expires a room after its ttl, and an expired room looks unknown", async () => {
    const { rooms, clock } = store()
    const { room, token } = rooms.create(offer())
    clock.now += RENDEZVOUS_TTL_MS
    refused(() => rooms.offer(room), 404, "not_found")
    await refusedAsync(() => rooms.waitAnswer(room, token, 0), 404, "not_found")
    assert.equal(rooms.size, 0)
  })

  it("sweeps expired rooms it was never asked about", () => {
    const { rooms, clock } = store()
    rooms.create(offer())
    rooms.create(offer())
    clock.now += RENDEZVOUS_TTL_MS - 1
    assert.equal(rooms.size, 2)
    clock.now += 1
    rooms.sweep()
    assert.equal(rooms.size, 0)
  })

  it("never waits past the room's expiry", async () => {
    const { rooms, clock } = store()
    const { room, token } = rooms.create(offer())
    clock.now += RENDEZVOUS_TTL_MS - 15
    const started = Date.now()
    assert.equal(await rooms.waitAnswer(room, token, 10_000), null)
    assert.ok(Date.now() - started < 1000)
  })

  it("refuses a room past the cap", () => {
    const { rooms } = store({ maxRooms: 2 })
    rooms.create(offer())
    rooms.create(offer())
    refused(() => rooms.create(offer()), 503, "busy")
  })

  it("refuses an oversized document", () => {
    const { rooms } = store()
    refused(() => rooms.create(offer({ pad: "x".repeat(MAX_DOCUMENT_BYTES) })), 413, "size")
  })

  it("refuses malformed documents and room ids", () => {
    const { rooms } = store()
    for (const text of ["", "nope", "[]", "null", "1", '{"v":1}', '{"sessionId":"' + SESSION + '"}', offer({ v: 0 }), offer({ v: "1" }), offer({ sessionId: "XYZ" }), offer({ sessionId: SESSION.toUpperCase() })]) {
      refused(() => rooms.create(text), 400, "document")
    }
    const { room } = rooms.create(offer())
    refused(() => rooms.answer(room, "{"), 400, "document")
    for (const bad of ["", "short", "a".repeat(23), "../../etc/passwd/aaaaa", "a+b/c=defghijklmnopqrs"]) {
      refused(() => rooms.offer(bad), 400, "room")
    }
  })

  it("forgets every room on clear, as a restart would", async () => {
    const { rooms } = store()
    const { room, token } = rooms.create(offer())
    const waiting = rooms.waitAnswer(room, token, 10_000)
    rooms.clear()
    assert.equal(await waiting, null)
    assert.equal(rooms.size, 0)
  })
})
