import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp } from "../src/carrier/udp.js"
import { generateIdentity } from "../src/identity/id.js"
import { decodeSnapshot, encodeSnapshot, encodeUsage, readRelaySnapshot } from "../src/identity/stats.js"
import { encodeEnvelope } from "../src/protocol/envelope.js"
import { encodeAck, encodeData } from "../src/protocol/frames.js"
import { Relay } from "../src/relay/relay.js"
import { sleep } from "../src/util.js"

describe("relay snapshot", () => {
  it("signs a snapshot and rejects a damaged one", () => {
    const seed = generateIdentity()
    const challenge = randomBytes(16)
    const packet = encodeSnapshot(seed, challenge, { relays: 2, bytes: 99, transfers: 4 })
    const decoded = decodeSnapshot(packet)
    assert.ok(decoded)
    assert.equal(decoded.id, seed.id)
    assert.deepEqual(decoded.snapshot, { relays: 2, bytes: 99, transfers: 4 })
    const flipped = Buffer.from(packet)
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff
    assert.equal(decodeSnapshot(flipped), null)
  })

  it("counts joined relays and the bytes they have forwarded", async () => {
    const seedId = generateIdentity()
    const firstId = generateIdentity()
    const secondId = generateIdentity()
    const stranger = generateIdentity()
    const seed = new Relay({ host: "127.0.0.1", port: 0, identity: seedId })
    const first = new Relay({ host: "127.0.0.1", port: 0, identity: firstId })
    const second = new Relay({ host: "127.0.0.1", port: 0, identity: secondId })
    const seedEndpoint = await seed.start()
    await first.start()
    await second.start()
    const socket = createUdpSocket()
    try {
      await bindUdp(socket, "127.0.0.1", 0)
      const inner = Buffer.from("tessera")
      await sendUdp(socket, encodeEnvelope({ host: "127.0.0.1", port: 9 }, inner), seedEndpoint)
      await sleep(30)
      assert.equal(seed.stats.forwardedBytes, inner.length)

      await first.join(seedEndpoint)
      await second.join(seedEndpoint)
      first.stats.forwardedBytes = 100
      second.stats.forwardedBytes = 40
      await first.publishUsage()
      await second.publishUsage()
      await sleep(40)
      const snapshot = await readRelaySnapshot(seedEndpoint)
      assert.equal(snapshot.relays, 3)
      assert.equal(snapshot.bytes, inner.length + 140)
      assert.equal(snapshot.transfers, 0)

      await sendUdp(socket, encodeUsage(stranger, 1, 99999), seedEndpoint)
      await sleep(30)
      const after = await readRelaySnapshot(seedEndpoint)
      assert.equal(after.bytes, snapshot.bytes)
      assert.equal(after.relays, 3)
      assert.equal(after.transfers, 0)

      const sessionId = randomBytes(16)
      const opening = encodeData({
        kind: "data",
        sessionId,
        blockId: 0,
        tesseraIndex: 0,
        k: 2,
        n: 3,
        cipherLen: 1,
        payload: Buffer.from([1]),
      })
      const ack = encodeAck({ kind: "ack", sessionId, blockId: 0 }, randomBytes(32))
      await sendUdp(socket, encodeEnvelope({ host: "127.0.0.1", port: 9 }, opening), seedEndpoint)
      await sleep(40)
      const started = await readRelaySnapshot(seedEndpoint)
      assert.equal(started.transfers, 0)
      await sendUdp(socket, encodeEnvelope({ host: "127.0.0.1", port: 9 }, ack), seedEndpoint)
      await sendUdp(socket, encodeEnvelope({ host: "127.0.0.1", port: 9 }, ack), seedEndpoint)
      await sleep(40)
      const counted = await readRelaySnapshot(seedEndpoint)
      assert.equal(counted.transfers, 1)
    } finally {
      await closeUdp(socket)
      await seed.close()
      await first.close()
      await second.close()
    }
  })
})
