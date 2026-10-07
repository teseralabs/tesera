import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import type { Endpoint } from "../src/carrier/transport.js"
import { encodeEnvelope } from "../src/protocol/envelope.js"
import { encodeAck, encodeData, encodeNack, encodeSample } from "../src/protocol/frames.js"
import { Attachments, sentBy, sessionOf } from "../src/attach/attachments.js"

const FROM: Endpoint = { host: "203.0.113.5", port: 4101 }

/** A bare data frame (what arrives from UDP) and its session id, hex. */
function frameFor(sessionId = randomBytes(16)): { frame: Buffer; hex: string } {
  const frame = encodeData({ kind: "data", sessionId, blockId: 0, tesseraIndex: 0, k: 1, n: 1, cipherLen: 16, payload: randomBytes(16) })
  const hex = sessionOf(frame)
  assert.ok(hex)
  return { frame, hex }
}

/** The receiving end's frames for a session, under a key the relay never has. */
function returnsFor(sessionId: Buffer) {
  const key = randomBytes(32)
  return {
    ack: encodeAck({ kind: "ack", sessionId, blockId: 0 }, key),
    nack: encodeNack({ kind: "nack", sessionId, blockId: 0, missing: [1] }, key),
    sample: encodeSample({ kind: "sample", sessionId, blockId: 0, tesseraIndex: 0 }, key),
  }
}

/** An attachment that records what it was asked to deliver. */
function recorder(reg: Attachments, ip = "198.51.100.1") {
  const got: Buffer[] = []
  const attachment = reg.add(ip, (packet) => got.push(Buffer.from(packet)))
  assert.ok(attachment)
  return { attachment, got }
}

describe("attachment claims and lifecycle", () => {
  it("claims a session and routes its return frames to the owner", () => {
    const reg = new Attachments()
    const { attachment, got } = recorder(reg)
    const { frame, hex } = frameFor()
    assert.equal(reg.claim(hex, attachment), "ok")
    assert.equal(reg.deliverReturn(frame, FROM), true)
    assert.equal(got.length, 1)
    assert.deepEqual(got[0], frame)
  })

  it("learns a sender's session from its outbound frame", () => {
    const reg = new Attachments()
    const { attachment, got } = recorder(reg)
    const sessionId = randomBytes(16)
    const { frame } = frameFor(sessionId)
    assert.equal(reg.learn(frame, attachment), "ok")
    assert.equal(reg.deliverReturn(returnsFor(sessionId).ack, FROM), true)
    assert.equal(reg.deliverReturn(frame, FROM), false, "a sender is not handed data for its own session")
    assert.equal(got.length, 1)
  })

  it("refuses a duplicate live claim and keeps the first owner", () => {
    const reg = new Attachments()
    const a = recorder(reg, "198.51.100.1")
    const b = recorder(reg, "198.51.100.2")
    const { frame, hex } = frameFor()
    assert.equal(reg.claim(hex, a.attachment), "ok")
    assert.equal(reg.claim(hex, b.attachment), "taken")
    reg.deliverReturn(frame, FROM)
    assert.equal(a.got.length, 1, "the first claimant still owns the session")
    assert.equal(b.got.length, 0, "a later claimant cannot steal a live session")
  })

  it("routes a wrong or unknown session nowhere", () => {
    const reg = new Attachments()
    recorder(reg)
    const { frame } = frameFor()
    assert.equal(reg.deliverReturn(frame, FROM), false)
  })

  it("removes a claim when the attachment closes", () => {
    const reg = new Attachments()
    const { attachment } = recorder(reg)
    const { frame, hex } = frameFor()
    reg.claim(hex, attachment)
    reg.close(attachment)
    assert.equal(reg.deliverReturn(frame, FROM), false)
    assert.equal(reg.sessions, 0)
  })

  it("expires an idle claim and attachment even while the connection lingers", () => {
    let now = 1000
    const reg = new Attachments({ idleMs: 500 }, () => now)
    const { attachment } = recorder(reg)
    const { frame, hex } = frameFor()
    reg.claim(hex, attachment)
    now += 600
    const closed = reg.sweep()
    assert.equal(reg.deliverReturn(frame, FROM), false, "the idle claim is gone")
    assert.deepEqual(closed, [attachment], "the idle attachment is swept")
    assert.equal(reg.size, 0)
  })

  it("keeps a claim alive while its return traffic flows", () => {
    let now = 1000
    const reg = new Attachments({ idleMs: 500 }, () => now)
    const { attachment, got } = recorder(reg)
    const { frame, hex } = frameFor()
    reg.claim(hex, attachment)
    now += 400
    reg.deliverReturn(frame, FROM) // traffic refreshes the claim
    now += 400
    reg.sweep()
    now += 400
    reg.deliverReturn(frame, FROM)
    assert.equal(got.length, 2, "an active claim is not swept")
  })

  it("eventually removes a claim after an abrupt disconnect via the idle timeout", () => {
    // An abrupt kill sends no close, so only the idle sweep removes the attachment and its claim.
    let now = 1000
    const reg = new Attachments({ idleMs: 500 }, () => now)
    const { attachment } = recorder(reg)
    const { frame, hex } = frameFor()
    reg.claim(hex, attachment)
    // no reg.close(attachment): the connection dropped without notice
    now += 600
    reg.sweep()
    assert.equal(reg.deliverReturn(frame, FROM), false)
    assert.equal(reg.size, 0)
  })

  it("reclaims a stale session from a closed owner", () => {
    const reg = new Attachments()
    const a = recorder(reg, "198.51.100.1")
    const b = recorder(reg, "198.51.100.2")
    const { frame, hex } = frameFor()
    reg.claim(hex, a.attachment)
    reg.close(a.attachment)
    assert.equal(reg.claim(hex, b.attachment), "ok", "a new owner may reclaim a closed owner's session")
    reg.deliverReturn(frame, FROM)
    assert.equal(b.got.length, 1)
  })

  it("closing one attachment cannot remove another's claim", () => {
    const reg = new Attachments()
    const a = recorder(reg, "198.51.100.1")
    const b = recorder(reg, "198.51.100.2")
    const one = frameFor()
    const two = frameFor()
    reg.claim(one.hex, a.attachment)
    reg.claim(two.hex, b.attachment)
    reg.close(a.attachment)
    assert.equal(reg.deliverReturn(two.frame, FROM), true, "b still owns its session")
    assert.equal(b.got.length, 1)
  })

  it("bounds claims per connection", () => {
    const reg = new Attachments({ maxSessionsPerConnection: 2 })
    const { attachment } = recorder(reg)
    assert.equal(reg.claim(frameFor().hex, attachment), "ok")
    assert.equal(reg.claim(frameFor().hex, attachment), "ok")
    assert.equal(reg.claim(frameFor().hex, attachment), "full")
  })

  it("bounds total sessions", () => {
    const reg = new Attachments({ maxSessions: 1, maxSessionsPerConnection: 10, maxSessionsPerIp: 10 })
    const a = recorder(reg, "198.51.100.1")
    const b = recorder(reg, "198.51.100.2")
    assert.equal(reg.claim(frameFor().hex, a.attachment), "ok")
    assert.equal(reg.claim(frameFor().hex, b.attachment), "full")
  })

  it("bounds attachments in total and per source address", () => {
    const reg = new Attachments({ maxAttachments: 2, maxAttachmentsPerIp: 1 })
    assert.ok(reg.add("198.51.100.1", () => {}))
    assert.equal(reg.add("198.51.100.1", () => {}), null, "a second attachment from one address is refused")
    assert.ok(reg.add("198.51.100.2", () => {}))
    assert.equal(reg.add("198.51.100.3", () => {}), null, "the total attachment cap holds")
  })

  it("bounds sessions per source address across its attachments", () => {
    const reg = new Attachments({ maxSessionsPerIp: 1, maxAttachmentsPerIp: 4, maxSessionsPerConnection: 4 })
    const a = recorder(reg, "198.51.100.9")
    const b = recorder(reg, "198.51.100.9")
    assert.equal(reg.claim(frameFor().hex, a.attachment), "ok")
    assert.equal(reg.claim(frameFor().hex, b.attachment), "full", "both attachments share one source's session budget")
  })

  it("frees a source's attachment slot on close", () => {
    const reg = new Attachments({ maxAttachmentsPerIp: 1 })
    const first = reg.add("198.51.100.1", () => {})
    assert.ok(first)
    assert.equal(reg.add("198.51.100.1", () => {}), null)
    reg.close(first)
    assert.ok(reg.add("198.51.100.1", () => {}), "the slot is reusable once the attachment closes")
  })

  it("ignores an envelope-wrapped return frame that carries no session", () => {
    const reg = new Attachments()
    recorder(reg)
    // A return frame arrives bare, not wrapped; an envelope at this point is not a return frame.
    const wrapped = encodeEnvelope(FROM, frameFor().frame)
    assert.equal(reg.deliverReturn(wrapped, FROM), false)
  })
})

describe("both ends of one session on one relay", () => {
  /** A sender and a receiver of one session, attached to the same registry. */
  function pair(reg = new Attachments()) {
    const sessionId = randomBytes(16)
    const data = frameFor(sessionId)
    const returns = returnsFor(sessionId)
    const sender = recorder(reg, "198.51.100.1")
    const receiver = recorder(reg, "198.51.100.2")
    assert.equal(reg.claim(data.hex, receiver.attachment), "ok")
    assert.equal(reg.learn(data.frame, sender.attachment), "ok")
    assert.equal(reg.learn(returns.ack, receiver.attachment), "ok", "the receiver's own acks are from the end it claimed")
    return { reg, sessionId, data, returns, sender, receiver }
  }

  it("reads the end from the frame type alone", () => {
    const sessionId = randomBytes(16)
    const r = returnsFor(sessionId)
    assert.equal(sentBy(frameFor(sessionId).frame), "sending")
    assert.equal(sentBy(r.ack), "receiving")
    assert.equal(sentBy(r.nack), "receiving")
    assert.equal(sentBy(r.sample), "receiving")
  })

  it("hands data to the receiver and acks, nacks, and samples to the sender", () => {
    const { reg, data, returns, sender, receiver } = pair()
    assert.equal(reg.deliverReturn(data.frame, FROM), true)
    assert.equal(reg.deliverReturn(returns.ack, FROM), true)
    assert.equal(reg.deliverReturn(returns.nack, FROM), true)
    assert.equal(reg.deliverReturn(returns.sample, FROM), true)
    assert.deepEqual(receiver.got, [data.frame])
    assert.deepEqual(sender.got, [returns.ack, returns.nack, returns.sample])
    assert.equal(reg.sessions, 2, "each end counts")
  })

  it("works whichever end attaches first", () => {
    const reg = new Attachments()
    const sessionId = randomBytes(16)
    const data = frameFor(sessionId)
    const sender = recorder(reg, "198.51.100.1")
    const receiver = recorder(reg, "198.51.100.2")
    assert.equal(reg.learn(data.frame, sender.attachment), "ok")
    assert.equal(reg.claim(data.hex, receiver.attachment), "ok")
    reg.deliverReturn(data.frame, FROM)
    reg.deliverReturn(returnsFor(sessionId).ack, FROM)
    assert.equal(receiver.got.length, 1)
    assert.equal(sender.got.length, 1)
  })

  it("refuses a third attachment either end, and routes nothing to it", () => {
    const { reg, data, returns, sender, receiver } = pair()
    const third = recorder(reg, "198.51.100.3")
    assert.equal(reg.claim(data.hex, third.attachment), "taken")
    assert.equal(reg.learn(data.frame, third.attachment), "taken")
    assert.equal(reg.learn(returns.ack, third.attachment), "taken")
    reg.deliverReturn(data.frame, FROM)
    reg.deliverReturn(returns.ack, FROM)
    assert.equal(third.got.length, 0)
    assert.equal(receiver.got.length, 1)
    assert.equal(sender.got.length, 1)
  })

  it("lets one attachment hold only one end of a session", () => {
    const reg = new Attachments()
    const sessionId = randomBytes(16)
    const data = frameFor(sessionId)
    const both = recorder(reg)
    assert.equal(reg.claim(data.hex, both.attachment), "ok")
    assert.equal(reg.learn(data.frame, both.attachment), "taken")
    reg.deliverReturn(returnsFor(sessionId).ack, FROM)
    assert.equal(both.got.length, 0, "an ack has no sending end to go to")
  })

  it("drops a frame of a type no end sends", () => {
    const { reg, data, sender, receiver } = pair()
    const odd = Buffer.from(data.frame)
    odd[1] = 9
    assert.equal(sentBy(odd), null)
    assert.equal(reg.deliverReturn(odd, FROM), false)
    assert.equal(reg.learn(odd, sender.attachment), "ignored")
    assert.equal(sender.got.length + receiver.got.length, 0)
  })

  it("keeps the other end when one closes, and lets a new attachment take the closed end", () => {
    const { reg, data, returns, sender, receiver } = pair()
    reg.close(sender.attachment)
    assert.equal(reg.deliverReturn(returns.ack, FROM), false, "a closed sender gets nothing")
    assert.equal(reg.deliverReturn(data.frame, FROM), true, "the receiver still gets its data")
    const again = recorder(reg, "198.51.100.1")
    assert.equal(reg.learn(data.frame, again.attachment), "ok")
    assert.equal(reg.deliverReturn(returns.ack, FROM), true)
    assert.equal(again.got.length, 1)
    assert.equal(sender.got.length, 0)
    assert.equal(receiver.got.length, 1)
  })

  it("sweeps an idle end without touching the active one", () => {
    let now = 1000
    const { reg, data, returns, sender, receiver } = pair(new Attachments({ idleMs: 500 }, () => now))
    now += 400
    reg.deliverReturn(data.frame, FROM)
    reg.touch(sender.attachment)
    now += 200
    reg.sweep()
    assert.equal(reg.deliverReturn(returns.ack, FROM), false, "the sender's end went idle")
    assert.equal(reg.deliverReturn(data.frame, FROM), true, "the receiver's end is still active")
    assert.equal(receiver.got.length, 2)
  })

  it("never hands one session's frames to another session's ends", () => {
    const reg = new Attachments()
    const one = pair(reg)
    const two = pair(reg)
    reg.deliverReturn(one.data.frame, FROM)
    reg.deliverReturn(one.returns.ack, FROM)
    assert.equal(two.sender.got.length + two.receiver.got.length, 0)
    reg.deliverReturn(frameFor().frame, FROM)
    assert.equal(one.receiver.got.length, 1, "a guessed session reaches no one")
  })

  it("counts each end against the caps", () => {
    const reg = new Attachments({ maxSessions: 1 })
    const sessionId = randomBytes(16)
    const data = frameFor(sessionId)
    const sender = recorder(reg, "198.51.100.1")
    const receiver = recorder(reg, "198.51.100.2")
    assert.equal(reg.claim(data.hex, receiver.attachment), "ok")
    assert.equal(reg.learn(data.frame, sender.attachment), "full")
  })
})
