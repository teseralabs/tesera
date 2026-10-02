import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp } from "../src/carrier/udp.js"
import { confirmRelay } from "../src/identity/confirm.js"
import {
  base32Decode,
  base32Encode,
  decodeProof,
  encodeProof,
  encodeQuery,
  formatId,
  generateIdentity,
  identityFromSecret,
  parseId,
  parseRelayRef,
  verifyProof,
} from "../src/identity/id.js"
import { decodeEnvelope } from "../src/protocol/envelope.js"
import { Relay } from "../src/relay/relay.js"
import { sleep } from "../src/util.js"

describe("relay ids", () => {
  it("encodes base32 with the standard alphabet", () => {
    assert.equal(base32Encode(Buffer.from("foobar")), "mzxw6ytboi")
    assert.deepEqual(base32Decode("mzxw6ytboi"), Buffer.from("foobar"))
    assert.equal(formatId(Buffer.alloc(32)), `relay:${"a".repeat(52)}`)
  })

  it("round-trips a key and rejects a non-canonical id", () => {
    const identity = generateIdentity()
    assert.match(identity.id, /^relay:[a-z2-7]{52}$/)
    assert.deepEqual(parseId(identity.id.toUpperCase()), identity.publicKey)
    assert.deepEqual(identityFromSecret(identity.secret.toString("hex")).publicKey, identity.publicKey)
    assert.throws(() => parseId(`relay:${"a".repeat(51)}b`))
    assert.throws(() => parseId(identity.secret.toString("hex")))
    assert.throws(() => identityFromSecret("abcd"))
  })

  it("parses a pinned relay and a plain address", () => {
    const identity = generateIdentity()
    const pinned = parseRelayRef(`${identity.id}@127.0.0.1:4101`)
    assert.equal(pinned.id, identity.id)
    assert.deepEqual(pinned.endpoint, { host: "127.0.0.1", port: 4101 })
    const plain = parseRelayRef("127.0.0.1:4101")
    assert.equal(plain.id, null)
    assert.throws(() => parseRelayRef(`${identity.id}`))
  })

  it("signs a challenge and rejects a different key", () => {
    const identity = generateIdentity()
    const challenge = randomBytes(16)
    const packet = encodeProof(identity, challenge)
    const proof = decodeProof(packet)
    assert.ok(proof)
    assert.equal(verifyProof(proof), true)
    const flipped = Buffer.from(packet)
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff
    const damaged = decodeProof(flipped)
    assert.ok(damaged)
    assert.equal(verifyProof(damaged), false)
    assert.equal(decodeEnvelope(encodeQuery(challenge)), null)
  })

  it("proves the relay at its address and rejects the wrong id", async () => {
    const identity = generateIdentity()
    const other = generateIdentity()
    const relay = new Relay({ host: "127.0.0.1", port: 0, identity })
    const endpoint = await relay.start()
    try {
      await confirmRelay(endpoint, identity.id, { attempts: 1, timeoutMs: 500 })
      await assert.rejects(
        () => confirmRelay(endpoint, other.id, { attempts: 1, timeoutMs: 500 }),
        new RegExp(identity.id),
      )
    } finally {
      await relay.close()
    }
  })

  it("does not forward an identity query", async () => {
    const relay = new Relay({ host: "127.0.0.1", port: 0 })
    let forwarded = 0
    relay.onForward = () => {
      forwarded++
    }
    const endpoint = await relay.start()
    const socket = createUdpSocket()
    try {
      await bindUdp(socket, "127.0.0.1", 0)
      await sendUdp(socket, encodeQuery(randomBytes(16)), endpoint)
      await sleep(40)
      assert.equal(forwarded, 0)
      assert.equal(relay.stats.forwarded, 0)
      await assert.rejects(
        () => confirmRelay(endpoint, generateIdentity().id, { attempts: 1, timeoutMs: 80 }),
        /did not prove/,
      )
    } finally {
      await closeUdp(socket)
      await relay.close()
    }
  })
})
