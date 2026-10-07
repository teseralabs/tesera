import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import type { OpenTransport } from "../src/carrier/transport.js"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, udpTransport, type Endpoint } from "../src/carrier/udp.js"
import { blockAad, deriveKeys, seal, sealedLength } from "../src/crypto/session.js"
import { decodeEnvelope, encodeEnvelope } from "../src/protocol/envelope.js"
import { encodeData } from "../src/protocol/frames.js"
import { Relay } from "../src/relay/relay.js"
import type { PeerAddress } from "../src/transport/address.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { TeseraSender } from "../src/transport/sender.js"
import { MemoryNetwork, memoryRelay } from "./memory-network.js"

type Net = {
  relays: Endpoint[]
  /** A transport bound at `at`. Port 0 picks one. */
  transport: (at?: Endpoint) => OpenTransport
  /** An address nobody holds yet, so the sender can be built before the receiver binds. */
  freeAddress: () => Promise<Endpoint>
  /** Send bytes to `to` from an address that is not a relay. */
  sendFromStranger: (packet: Buffer, to: Endpoint) => Promise<void>
  close: () => Promise<void>
}

const ANY = { host: "127.0.0.1", port: 0 }

async function udpNet(): Promise<Net> {
  const relays = [new Relay({ host: "127.0.0.1" }), new Relay({ host: "127.0.0.1" }), new Relay({ host: "127.0.0.1" })]
  for (const relay of relays) await relay.start()
  const stranger = createUdpSocket()
  await bindUdp(stranger, "127.0.0.1", 0)
  return {
    relays: relays.map((relay) => relay.endpoint),
    transport: (at = ANY) => udpTransport(at.host, at.port),
    freeAddress: async () => {
      const socket = createUdpSocket()
      const at = await bindUdp(socket, "127.0.0.1", 0)
      await closeUdp(socket)
      return at
    },
    sendFromStranger: (packet, to) => sendUdp(stranger, packet, to),
    close: async () => {
      await closeUdp(stranger)
      for (const relay of relays) await relay.close()
    },
  }
}

async function memoryNet(network = new MemoryNetwork()): Promise<Net> {
  const relays = [await memoryRelay(network), await memoryRelay(network), await memoryRelay(network)]
  const stranger = await network.transport()({ packet: () => {}, error: () => {} })
  let nextFree = 50000
  return {
    relays: relays.map((relay) => relay.endpoint),
    transport: (at = ANY) => network.transport(at.host, at.port),
    freeAddress: async () => ({ host: "127.0.0.1", port: nextFree++ }),
    sendFromStranger: (packet, to) => stranger.send(packet, to),
    close: async () => {
      await stranger.close()
      for (const relay of relays) await relay.close()
    },
  }
}

for (const [name, open] of [
  ["udp", udpNet],
  ["memory", () => memoryNet()],
] as const) {
  describe(`transfer over ${name}`, () => {
    it("delivers the same bytes across 3 relays", async () => {
      await withNet(open, async (net) => {
        const result = await transfer(net, { size: 500_000 })
        assert.equal(result.received, result.sent)
      })
    })

    it("ignores a data frame that doesn't come from a relay", async () => {
      await withNet(open, async (net) => {
        const result = await transfer(net, {
          size: 100_000,
          beforeSend: async ({ secret, receiverAt }) => {
            await net.sendFromStranger(dataFrame(secret, randomBytes(16), Buffer.from("rogue")), receiverAt)
          },
        })
        assert.equal(result.received, result.sent)
      })
    })

    it("completes with the session id known to the receiver ahead", async () => {
      await withNet(open, async (net) => {
        const result = await transfer(net, { size: 100_000, knownSessionId: true })
        assert.equal(result.received, result.sent)
      })
    })
  })
}

describe("transfer over memory with an address per relay", () => {
  it("reaches each end at the address given for that relay", async () => {
    const network = new MemoryNetwork()
    await withNet(
      () => memoryNet(network),
      async (net) => {
        const receiverAt = { host: "10.0.0.2", port: 7000 }
        const senderAt = { host: "10.0.0.1", port: 7000 }
        const receiverAddresses = net.relays.map((_, index) => ({ host: `10.0.1.${index}`, port: 7100 }))
        const senderAddresses = net.relays.map((_, index) => ({ host: `10.0.2.${index}`, port: 7200 }))
        receiverAddresses.forEach((address) => network.alias(address, receiverAt))
        senderAddresses.forEach((address) => network.alias(address, senderAt))
        const result = await transfer(net, {
          size: 200_000,
          senderAt,
          receiverAt,
          receiverAddress: receiverAddresses,
          senderAddress: senderAddresses,
        })
        assert.equal(result.received, result.sent)
        for (const { from, to, packet } of network.sent) {
          const relay = net.relays.findIndex((r) => sameEndpoint(r, to))
          if (relay < 0) continue
          const dest = decodeEnvelope(packet)?.dest
          if (sameEndpoint(from, senderAt)) assert.deepEqual(dest, receiverAddresses[relay])
          if (sameEndpoint(from, receiverAt)) assert.deepEqual(dest, senderAddresses[relay])
        }
        net.relays.forEach((relay, index) => {
          const forwarded = network.sent.filter((p) => sameEndpoint(p.from, relay)).map((p) => p.to)
          assert.ok(forwarded.some((to) => sameEndpoint(to, receiverAddresses[index]!)))
          assert.ok(forwarded.some((to) => sameEndpoint(to, senderAddresses[index]!)))
        })
      },
    )
  })
})

describe("memory network", () => {
  it("refuses an address that is taken and frees it on close", async () => {
    const network = new MemoryNetwork()
    const events = { packet: () => {}, error: () => {} }
    const first = await network.transport("127.0.0.1", 5000)(events)
    await assert.rejects(network.transport("127.0.0.1", 5000)(events), { code: "EADDRINUSE" })
    await first.close()
    await (await network.transport("127.0.0.1", 5000)(events)).close()
  })

  it("delivers a copy from the sender's address and drops packets to nobody", async () => {
    const network = new MemoryNetwork()
    const got: Array<{ packet: Uint8Array; from: Endpoint }> = []
    const a = await network.transport()({ packet: () => {}, error: () => {} })
    const b = await network.transport()({ packet: (packet, from) => got.push({ packet, from }), error: () => {} })
    const bytes = Buffer.from("hello")
    await a.send(bytes, b.endpoint)
    await a.send(bytes, { host: "127.0.0.1", port: 1 })
    bytes.fill(0)
    await turn()
    assert.equal(got.length, 1)
    assert.deepEqual(Buffer.from(got[0]!.packet), Buffer.from("hello"))
    assert.deepEqual(got[0]!.from, a.endpoint)
    await a.close()
    await b.close()
  })

  it("never forwards an envelope inside an envelope", async () => {
    const network = new MemoryNetwork()
    const relay = await memoryRelay(network)
    const got: Uint8Array[] = []
    const sink = await network.transport()({ packet: (packet) => got.push(packet), error: () => {} })
    const tx = await network.transport()({ packet: () => {}, error: () => {} })
    const frame = Buffer.from([2, 1])
    await tx.send(encodeEnvelope(sink.endpoint, encodeEnvelope(sink.endpoint, frame)), relay.endpoint)
    await tx.send(encodeEnvelope(sink.endpoint, frame), relay.endpoint)
    await turn()
    await turn()
    assert.deepEqual(got.map((p) => Buffer.from(p)), [frame])
    for (const t of [tx, sink, relay]) await t.close()
  })
})

type TransferOptions = {
  size: number
  knownSessionId?: boolean
  senderAt?: Endpoint
  receiverAt?: Endpoint
  receiverAddress?: PeerAddress
  senderAddress?: PeerAddress
  beforeSend?: (ctx: { secret: Buffer; receiverAt: Endpoint }) => Promise<void>
}

async function transfer(net: Net, opts: TransferOptions): Promise<{ sent: string; received: string }> {
  const secret = randomBytes(32)
  const payload = randomBytes(opts.size)
  const receiverAt = opts.receiverAt ?? (await net.freeAddress())
  const sender = new TeseraSender({
    session: secret,
    receiver: opts.receiverAddress ?? receiverAt,
    relays: net.relays,
    transport: net.transport(opts.senderAt),
  })
  const receiver = new TeseraReceiver({
    session: secret,
    relays: net.relays,
    transport: net.transport(receiverAt),
    ...(opts.senderAddress ? { sender: opts.senderAddress } : {}),
    ...(opts.knownSessionId ? { sessionId: sender.sessionId } : {}),
  })
  try {
    await receiver.start()
    await opts.beforeSend?.({ secret, receiverAt })
    const senderAt = await sender.start()
    if (!opts.senderAddress) receiver.setSender(senderAt)
    const reading = readAll(receiver)
    await sender.write(payload)
    await sender.end()
    return { sent: sha256(payload), received: sha256(await reading) }
  } finally {
    await sender.close()
    await receiver.close()
  }
}

async function readAll(receiver: TeseraReceiver): Promise<Buffer> {
  const chunks: Buffer[] = []
  for (;;) {
    const chunk = await receiver.read()
    if (!chunk) return Buffer.concat(chunks)
    chunks.push(Buffer.from(chunk))
  }
}

async function withNet(open: () => Promise<Net>, run: (net: Net) => Promise<void>): Promise<void> {
  const net = await open()
  try {
    await run(net)
  } finally {
    await net.close()
  }
}

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function dataFrame(secret: Buffer, sessionId: Buffer, body: Buffer): Buffer {
  const keys = deriveKeys(secret, sessionId)
  const cipherLen = sealedLength(body.length)
  const ctx = { sessionId, blockId: 0, k: 1, n: 1, cipherLen, shardLen: cipherLen }
  const payload = seal(keys.aeadKey, 0, true, body, 1_000, blockAad(ctx))
  return encodeData({ kind: "data", sessionId, blockId: 0, tesseraIndex: 0, k: 1, n: 1, cipherLen, payload })
}

function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.host === b.host && a.port === b.port
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
