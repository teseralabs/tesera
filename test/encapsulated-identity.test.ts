import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { type Socket } from "node:dgram"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, type Endpoint } from "../src/carrier/udp.js"
import { encodeQuery, generateIdentity, startsIdentity } from "../src/identity/id.js"
import { encodeJoin, encodeLookup } from "../src/identity/peers.js"
import { encodeRecordAsk } from "../src/identity/record.js"
import { encodeSnapshotQuery } from "../src/identity/stats.js"
import { encodeEnvelope } from "../src/protocol/envelope.js"
import { encodeData } from "../src/protocol/frames.js"
import { Relay } from "../src/relay/relay.js"
import { sleep } from "../src/util.js"

const uncapped = { bandwidthBps: 0, maxSessions: 0, peerRatePerMin: 0, datagramRatePerSec: 0 }

describe("identity packets inside an envelope", () => {
  it("can't make one relay join another through it", async () => {
    const a = new Relay({ host: "127.0.0.1", identity: generateIdentity() })
    const b = new Relay({ host: "127.0.0.1", identity: generateIdentity(), policy: { access: "open", ...uncapped } })
    const x = createUdpSocket()
    try {
      await a.start()
      await b.start()
      await bindUdp(x, "127.0.0.1", 0)
      await sendUdp(x, encodeEnvelope(b.endpoint, encodeJoin()), a.endpoint)
      await sleep(300)
      assert.deepEqual(
        b.directory().relays.map((relay) => relay.port),
        [b.endpoint.port],
      )
      assert.equal(a.stats.droppedInvalid, 1)
      assert.equal(a.stats.forwarded, 0)
    } finally {
      await closeUdp(x)
      await a.close()
      await b.close()
    }
  })

  it("drops every identity kind and version instead of forwarding it", async () => {
    await withRelay(async ({ relay, tx, sink, received }) => {
      const other = encodeJoin()
      other[4] = 1
      const packets = [
        encodeJoin(),
        encodeLookup(randomBytes(16)),
        encodeQuery(randomBytes(16)),
        encodeRecordAsk(),
        encodeSnapshotQuery(randomBytes(16)),
        other,
      ]
      for (const inner of packets) await sendUdp(tx, encodeEnvelope(sink, inner), relay.endpoint)
      const frame = dataFrame()
      await sendUdp(tx, encodeEnvelope(sink, frame), relay.endpoint)
      await waitFor(() => received.length > 0)
      await sleep(30)
      assert.deepEqual(received, [frame])
      assert.equal(relay.stats.droppedInvalid, packets.length)
    })
  })

  it("still answers an identity packet sent to the relay directly", async () => {
    await withRelay(async ({ relay, tx }) => {
      const replies: Buffer[] = []
      tx.on("message", (msg) => replies.push(Buffer.from(msg)))
      await sendUdp(tx, encodeRecordAsk(), relay.endpoint)
      await waitFor(() => replies.length === 1)
      assert.ok(startsIdentity(replies[0]!))
    })
  })

  it("never mistakes a frame for an identity packet", () => {
    assert.equal(startsIdentity(dataFrame()), false)
    assert.equal(startsIdentity(encodeEnvelope({ host: "127.0.0.1", port: 9 }, dataFrame())), false)
    assert.equal(startsIdentity(Buffer.from("TSI")), false)
    assert.equal(startsIdentity(encodeJoin()), true)
  })
})

type Harness = { relay: Relay; tx: Socket; sink: Endpoint; received: Buffer[] }

async function withRelay(run: (harness: Harness) => Promise<void>): Promise<void> {
  const relay = new Relay({ host: "127.0.0.1", identity: generateIdentity() })
  const tx = createUdpSocket()
  const sinkSocket = createUdpSocket()
  const received: Buffer[] = []
  sinkSocket.on("message", (msg) => received.push(Buffer.from(msg)))
  try {
    await relay.start()
    await bindUdp(tx, "127.0.0.1", 0)
    const sink = await bindUdp(sinkSocket, "127.0.0.1", 0)
    await run({ relay, tx, sink, received })
  } finally {
    await closeUdp(tx)
    await closeUdp(sinkSocket)
    await relay.close()
  }
}

function dataFrame(): Buffer {
  return encodeData({
    kind: "data",
    sessionId: randomBytes(16),
    blockId: 0,
    tesseraIndex: 0,
    k: 1,
    n: 1,
    cipherLen: 64,
    payload: randomBytes(64),
  })
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting")
    await sleep(5)
  }
}
