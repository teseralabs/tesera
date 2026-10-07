import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { transportOrUdp, type Endpoint, type TransportEvents } from "../src/carrier/transport.js"
import { udpTransport } from "../src/carrier/udp.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { TeseraSender } from "../src/transport/sender.js"
import { sleep } from "../src/util.js"

describe("UDP transport", () => {
  it("binds, sends whole packets, and reports where each one came from", async () => {
    const got: Array<{ packet: Buffer; from: Endpoint }> = []
    const a = await udpTransport("127.0.0.1", 0)(events((packet, from) => got.push({ packet: Buffer.from(packet), from })))
    const b = await udpTransport("127.0.0.1", 0)(events())
    try {
      assert.equal(a.endpoint.host, "127.0.0.1")
      assert.ok(a.endpoint.port > 0)
      const packet = Buffer.from("TESR packet bytes")
      await b.send(packet, a.endpoint)
      await waitFor(() => got.length === 1)
      assert.deepEqual(got[0]?.packet, packet)
      assert.deepEqual(got[0]?.from, b.endpoint)
    } finally {
      await a.close()
      await b.close()
    }
  })

  it("rejects a port that is already in use, as port pools expect", async () => {
    const a = await udpTransport("127.0.0.1", 0)(events())
    try {
      await assert.rejects(udpTransport("127.0.0.1", a.endpoint.port)(events()), (err: { code?: string }) => err.code === "EADDRINUSE")
    } finally {
      await a.close()
    }
    const again = await udpTransport("127.0.0.1", a.endpoint.port)(events())
    await again.close()
  })

  it("is what a sender or receiver opens by default", async () => {
    const receiver = new TeseraReceiver({ session: Buffer.alloc(32, 1), relays: [{ host: "127.0.0.1", port: 9 }] })
    const sender = new TeseraSender({
      session: Buffer.alloc(32, 1),
      receiver: { host: "127.0.0.1", port: 9 },
      relays: [{ host: "127.0.0.1", port: 9 }],
    })
    try {
      assert.equal((await receiver.start()).host, "127.0.0.1")
      assert.equal((await sender.start()).host, "127.0.0.1")
    } finally {
      await sender.close()
      await receiver.close()
    }
  })

  it("refuses a transport and bind options together", () => {
    const transport = udpTransport("127.0.0.1", 0)
    assert.throws(() => transportOrUdp({ transport, bindPort: 4400 }), /either transport or bindHost/)
    assert.equal(transportOrUdp({ transport }), transport)
  })
})

function events(onPacket: TransportEvents["packet"] = () => {}): TransportEvents {
  return { packet: onPacket, error: (err) => assert.fail(err) }
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting")
    await sleep(5)
  }
}
