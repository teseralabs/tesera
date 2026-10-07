import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { DATAGRAM_OVERHEAD, MAX_FORWARD_DATAGRAM, MAX_SHARD, shardForPacketSize } from "../src/constants.js"
import { udpTransport } from "../src/carrier/udp.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { TeseraSender } from "../src/transport/sender.js"
import { MemoryNetwork, memoryRelay } from "./memory-network.js"

describe("shardForPacketSize", () => {
  it("clamps to the protocol maximum", () => {
    assert.equal(shardForPacketSize(65535), MAX_SHARD)
    assert.equal(shardForPacketSize(MAX_FORWARD_DATAGRAM), MAX_SHARD)
  })

  it("leaves room for the datagram overhead", () => {
    assert.equal(shardForPacketSize(DATAGRAM_OVERHEAD + 500), 500)
  })

  it("refuses a limit too small for any shard", () => {
    assert.throws(() => shardForPacketSize(DATAGRAM_OVERHEAD), /too small/)
  })
})

describe("the sender fits its datagrams to the transport", () => {
  it("keeps the native shard size on UDP", async () => {
    const udp = udpTransport("127.0.0.1", 0)
    const sender = new TeseraSender({ session: randomBytes(32), receiver: { host: "127.0.0.1", port: 9 }, relays: [{ host: "127.0.0.1", port: 9 }], transport: udp })
    await sender.start()
    try {
      // a full data datagram is the default 1024-byte shard plus 44 bytes of framing
      assert.equal(sender.datagramSize, 1024 + DATAGRAM_OVERHEAD)
    } finally {
      await sender.close()
    }
  })

  for (const limit of [1004, 600, DATAGRAM_OVERHEAD + 120]) {
    it(`stays within a transport limit of ${limit} bytes and still delivers`, async () => {
      const network = new MemoryNetwork()
      const relays = [await memoryRelay(network), await memoryRelay(network), await memoryRelay(network)]
      const endpoints = relays.map((relay) => relay.endpoint)
      const secret = randomBytes(32)
      const payload = randomBytes(300_000)
      const receiver = new TeseraReceiver({ session: secret, relays: endpoints, transport: network.transport("127.0.0.1", 0, limit) })
      const sender = new TeseraSender({ session: secret, receiver: (await receiver.start()), relays: endpoints, transport: network.transport("127.0.0.1", 0, limit) })
      try {
        receiver.setSender(await sender.start())
        assert.ok(sender.datagramSize <= limit, `datagram ${sender.datagramSize} > ${limit}`)
        const reading = readAll(receiver)
        await sender.write(payload)
        await sender.end()
        assert.equal(sha256(await reading), sha256(payload))
        const largest = Math.max(...network.sent.map((p) => p.packet.length))
        assert.ok(largest <= limit, `a packet of ${largest} exceeded ${limit}`)
      } finally {
        await sender.close()
        await receiver.close()
        for (const relay of relays) await relay.close()
      }
    })
  }
})

describe("the sender fits its datagrams to both ends", () => {
  it("fits its shard to a receiver limit smaller than its own transport", async () => {
    const network = new MemoryNetwork()
    const relay = await memoryRelay(network)
    const sender = new TeseraSender({
      session: randomBytes(32),
      receiver: { host: "127.0.0.1", port: 9 },
      relays: [relay.endpoint],
      transport: network.transport("127.0.0.1", 0, 65535),
      peerMaxPacketSize: 600,
    })
    await sender.start()
    try {
      assert.equal(sender.datagramSize, 600)
    } finally {
      await sender.close()
      await relay.close()
    }
  })

  it("takes a receiver address and limit after construction", async () => {
    const network = new MemoryNetwork()
    const relay = await memoryRelay(network)
    const sender = new TeseraSender({ session: randomBytes(32), relays: [relay.endpoint], transport: network.transport("127.0.0.1", 0, 65535) })
    sender.setReceiver({ host: "127.0.0.1", port: 9 }, 500)
    await sender.start()
    try {
      assert.equal(sender.datagramSize, 500)
    } finally {
      await sender.close()
      await relay.close()
    }
  })
})

async function readAll(receiver: TeseraReceiver): Promise<Buffer> {
  const chunks: Buffer[] = []
  for (;;) {
    const chunk = await receiver.read()
    if (!chunk) return Buffer.concat(chunks)
    chunks.push(Buffer.from(chunk))
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
