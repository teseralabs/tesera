import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import {
  ATTACH_PATH,
  ATTACH_VERSION,
  CLAIM,
  CLAIM_OK,
  decodeAddress,
  decodeControl,
  decodeFrame,
  encodeAddress,
  encodeControl,
  encodeFrame,
  FRAME_HEADER_LEN,
  HELLO,
} from "../src/attach/framing.js"

describe("attach framing", () => {
  it("carries the version in the path", () => {
    assert.equal(ATTACH_PATH, `/tesera/attach/${ATTACH_VERSION}`)
  })

  it("round-trips a control message", () => {
    const body = randomBytes(16)
    const control = decodeControl(encodeControl(CLAIM, body))
    assert.ok(control)
    assert.equal(control.kind, CLAIM)
    assert.deepEqual(Buffer.from(control.body), body)
  })

  it("round-trips a control message with no body", () => {
    const control = decodeControl(encodeControl(HELLO))
    assert.ok(control)
    assert.equal(control.kind, HELLO)
    assert.equal(control.body.length, 0)
  })

  it("refuses a control message of the wrong version", () => {
    const bytes = encodeControl(CLAIM)
    bytes[0] = ATTACH_VERSION + 1
    assert.equal(decodeControl(bytes), null)
    assert.equal(decodeControl(new Uint8Array([ATTACH_VERSION])), null)
  })

  it("round-trips an address", () => {
    const address = { host: "203.0.113.7", port: 4101 }
    assert.deepEqual(decodeAddress(encodeAddress(address)), address)
  })

  it("refuses an address with a zero port or wrong length", () => {
    const bytes = encodeAddress({ host: "203.0.113.7", port: 4101 })
    bytes[4] = 0
    bytes[5] = 0
    assert.equal(decodeAddress(bytes), null)
    assert.equal(decodeAddress(new Uint8Array(5)), null)
  })

  it("rejects an address that is not IPv4 when encoding", () => {
    assert.throws(() => encodeAddress({ host: "::1", port: 4101 }))
    assert.throws(() => encodeAddress({ host: "203.0.113.7", port: 0 }))
  })

  it("round-trips a datagram frame and keeps the packet exact", () => {
    const address = { host: "198.51.100.9", port: 65000 }
    const packet = randomBytes(1000)
    const frame = decodeFrame(encodeFrame(address, packet))
    assert.ok(frame)
    assert.deepEqual(frame.address, address)
    assert.deepEqual(Buffer.from(frame.packet), packet)
  })

  it("has a 7-byte frame header", () => {
    assert.equal(FRAME_HEADER_LEN, 7)
    assert.equal(encodeFrame({ host: "1.2.3.4", port: 5 }, new Uint8Array(0)).length, FRAME_HEADER_LEN)
  })

  it("refuses a short frame, a wrong version, and a zero port", () => {
    assert.equal(decodeFrame(new Uint8Array(FRAME_HEADER_LEN - 1)), null)
    const good = encodeFrame({ host: "1.2.3.4", port: 5 }, randomBytes(8))
    const wrongVersion = Uint8Array.from(good)
    wrongVersion[0] = ATTACH_VERSION + 1
    assert.equal(decodeFrame(wrongVersion), null)
    const zeroPort = Uint8Array.from(good)
    zeroPort[5] = 0
    zeroPort[6] = 0
    assert.equal(decodeFrame(zeroPort), null)
  })

  it("decodes an accepted claim status byte", () => {
    const reply = decodeControl(encodeControl(CLAIM, new Uint8Array([CLAIM_OK])))
    assert.ok(reply)
    assert.equal(reply.body[0], CLAIM_OK)
  })
})
