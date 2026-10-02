import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { generateIdentity } from "../src/identity/id.js"
import { decodeTable, discoverRelays, encodeJoin, encodeTable } from "../src/identity/peers.js"
import { decodeEnvelope } from "../src/protocol/envelope.js"
import { Relay } from "../src/relay/relay.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { TeseraSender } from "../src/transport/sender.js"

describe("relay discovery", () => {
  it("signs a peer table and rejects a damaged one", () => {
    const seed = generateIdentity()
    const peer = generateIdentity()
    const packet = encodeTable(seed, randomBytes(16), [{ id: peer.id, endpoint: { host: "127.0.0.1", port: 4102 } }])
    const table = decodeTable(packet)
    assert.ok(table)
    assert.equal(table.id, seed.id)
    assert.equal(table.peers.length, 1)
    assert.equal(table.peers[0]?.id, peer.id)
    assert.deepEqual(table.peers[0]?.endpoint, { host: "127.0.0.1", port: 4102 })
    const flipped = Buffer.from(packet)
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff
    assert.equal(decodeTable(flipped), null)
    assert.equal(decodeEnvelope(encodeJoin()), null)
  })

  it("learns relays that joined a seed and skips one that is gone", async () => {
    const seedId = generateIdentity()
    const firstId = generateIdentity()
    const secondId = generateIdentity()
    const seed = new Relay({ host: "127.0.0.1", port: 0, identity: seedId })
    const first = new Relay({ host: "127.0.0.1", port: 0, identity: firstId })
    const second = new Relay({ host: "127.0.0.1", port: 0, identity: secondId })
    const seedEndpoint = await seed.start()
    await first.start()
    await second.start()
    try {
      await first.join(seedEndpoint)
      await second.join(seedEndpoint)
      const found = await discoverRelays(seedEndpoint, { confirmTimeoutMs: 300, confirmAttempts: 2 })
      assert.deepEqual(
        found.map((relay) => relay.id).sort(),
        [seedId.id, firstId.id, secondId.id].sort(),
      )
      const payload = Buffer.from("discovered\n")
      const output = await transfer(
        found.map((relay) => relay.endpoint),
        payload,
      )
      assert.deepEqual(output, payload)
      await second.close()
      const remaining = await discoverRelays(seedEndpoint, { confirmTimeoutMs: 80, confirmAttempts: 1 })
      assert.deepEqual(
        remaining.map((relay) => relay.id).sort(),
        [seedId.id, firstId.id].sort(),
      )
    } finally {
      await seed.close()
      await first.close()
      await second.close()
    }
  })
})

async function transfer(relays: Array<{ host: string; port: number }>, payload: Buffer): Promise<Buffer> {
  const session = randomBytes(32)
  const receiver = new TeseraReceiver({ session, relays })
  let sender: TeseraSender | undefined
  try {
    await receiver.start()
    sender = new TeseraSender({
      session,
      relays,
      receiver: receiver.endpoint,
      k: 2,
      n: 3,
      deadlineMs: 3000,
    })
    await sender.start()
    receiver.setSender(sender.endpoint)
    const chunks: Uint8Array[] = []
    const reading = (async () => {
      for (;;) {
        const chunk = await receiver.read()
        if (!chunk) return Buffer.concat(chunks)
        chunks.push(chunk)
      }
    })()
    await sender.write(payload)
    await sender.end()
    return await reading
  } finally {
    await sender?.close()
    await receiver.close()
  }
}
