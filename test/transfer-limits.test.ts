import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, type Endpoint } from "../src/carrier/udp.js"
import { decodeEnvelope, encodeEnvelope } from "../src/protocol/envelope.js"
import { encodeData, peekRelayFrame } from "../src/protocol/frames.js"
import { PolicyGate, fillPolicy, safePolicy, type OperatorPolicy } from "../src/relay/policy.js"
import { Relay } from "../src/relay/relay.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { TeseraSender } from "../src/transport/sender.js"
import { sleep } from "../src/util.js"

const open = { access: "open" as const, maxSessions: 8, peerRatePerMin: 0 }

type Moved = { output: Buffer; sender: TeseraSender; receiver: TeseraReceiver; seconds: number }

/** Send through relays that are already running. The receiver lingers like `tesera recv`. */
async function move(
  relays: Endpoint[],
  payload: Buffer,
  opts: { k?: number; n?: number; maxSends?: number; linger?: boolean; idleMs?: number } = {},
): Promise<Moved> {
  const session = randomBytes(32)
  const receiver = new TeseraReceiver({ session, relays, sender: { host: "127.0.0.1", port: 9 } })
  const sender = new TeseraSender({
    session,
    relays,
    receiver: await receiver.start(),
    k: opts.k ?? 1,
    n: opts.n ?? 1,
    maxSends: opts.maxSends,
    idleMs: opts.idleMs,
  })
  receiver.setSender(await sender.start())
  const chunks: Uint8Array[] = []
  const reading = (async () => {
    for (;;) {
      const chunk = await receiver.read()
      if (!chunk) break
      chunks.push(chunk)
    }
    if (opts.linger ?? true) await receiver.linger()
    await receiver.close()
  })()
  const started = performance.now()
  try {
    await sender.write(payload)
    await sender.end()
    await reading
    return { output: Buffer.concat(chunks), sender, receiver, seconds: (performance.now() - started) / 1000 }
  } catch (err) {
    receiver.fail(err)
    await reading.catch(() => {})
    throw err
  } finally {
    await sender.close()
    await receiver.close()
  }
}

async function relays(
  count: number,
  policy: Partial<OperatorPolicy>,
  log?: (line: string) => void,
  limitLogMs = 100,
): Promise<Relay[]> {
  const out: Relay[] = []
  for (let i = 0; i < count; i++) {
    const relay = new Relay({ host: "127.0.0.1", policy, log, logLevel: "info", limitLogMs })
    await relay.start()
    out.push(relay)
  }
  return out
}

describe("relay limits and transfers", () => {
  it("defaults to 2,000 datagrams a second and 5 mbps", () => {
    const policy = safePolicy()
    assert.equal(policy.datagramRatePerSec, 2000)
    assert.equal(policy.bandwidthBps, 625_000)
  })

  it("names the cap that refused a datagram and spends nothing on a drop", () => {
    const gate = new PolicyGate(fillPolicy({ ...open, datagramRatePerSec: 2, bandwidthBps: 100, maxSessions: 1 }))
    const now = Date.now()
    assert.equal(gate.admitDatagram(200, null, now), "bandwidth")
    assert.equal(gate.admitDatagram(50, "a", now), null)
    assert.equal(gate.admitDatagram(10, "b", now), "session")
    assert.equal(gate.admitDatagram(40, "a", now), null)
    assert.equal(gate.admitDatagram(1, "a", now), "datagram")
  })

  it("slows a transfer down at 100 datagrams a second instead of failing", async () => {
    const lines: string[] = []
    const set = await relays(1, { ...open, datagramRatePerSec: 100, bandwidthBps: 0 }, (line) => lines.push(line))
    try {
      const payload = randomBytes(120_000)
      const moved = await move(set.map((relay) => relay.endpoint), payload)
      assert.deepEqual(moved.output, payload)
      assert.ok(moved.seconds > 1, `took ${moved.seconds}s`)
      const report = set[0]!.report()
      assert.ok(report.limitedBy.datagram > 0)
      assert.equal(report.limited, report.limitedBy.datagram)
      assert.ok(lines.some((line) => /role=relay event=limited session=0 datagram=[1-9]\d* bandwidth=0 /.test(line)))
    } finally {
      for (const relay of set) await relay.close()
    }
  })

  it("slows a transfer down at a 1 mbps bandwidth cap instead of failing", async () => {
    const set = await relays(1, { ...open, datagramRatePerSec: 0, bandwidthBps: 125_000 })
    try {
      const payload = randomBytes(400_000)
      const moved = await move(set.map((relay) => relay.endpoint), payload)
      assert.deepEqual(moved.output, payload)
      assert.ok(moved.seconds > 1.5, `took ${moved.seconds}s`)
      assert.ok(set[0]!.report().limitedBy.bandwidth > 0)
    } finally {
      for (const relay of set) await relay.close()
    }
  })

  it("slows a 2-of-3 transfer down when every relay allows 100 datagrams a second", async () => {
    const set = await relays(3, { ...open, datagramRatePerSec: 100, bandwidthBps: 0 })
    try {
      const payload = randomBytes(150_000)
      const moved = await move(set.map((relay) => relay.endpoint), payload, { k: 2, n: 3 })
      assert.deepEqual(moved.output, payload)
      assert.ok(set.some((relay) => relay.report().limitedBy.datagram > 0))
    } finally {
      for (const relay of set) await relay.close()
    }
  })

  it("finishes when the last ACKs are lost, because the receiver keeps answering", async () => {
    const lossy = await ackDropper()
    try {
      const payload = randomBytes(5_000)
      const moved = await move([lossy.endpoint], payload, { linger: true })
      assert.deepEqual(moved.output, payload)
      assert.ok(lossy.dropped() > 0)
      assert.ok(moved.receiver.stats.acksSent > lossy.dropped())
    } finally {
      await lossy.close()
    }
  })

  it("fails without the grace period when the last ACK is lost", async () => {
    const lossy = await ackDropper()
    try {
      await assert.rejects(
        () => move([lossy.endpoint], randomBytes(5_000), { linger: false, maxSends: 3 }),
        /exceeded 3 transmissions/,
      )
    } finally {
      await lossy.close()
    }
  })

  it("gives up after a quiet period instead of a total deadline", async () => {
    const silent = createUdpSocket()
    const hole = await bindUdp(silent, "127.0.0.1", 0)
    const sender = new TeseraSender({
      session: randomBytes(32),
      relays: [hole],
      receiver: { host: "127.0.0.1", port: 9 },
      k: 1,
      n: 1,
      maxSends: 1000,
      idleMs: 600,
    })
    try {
      await sender.start()
      await sender.write(randomBytes(100))
      await assert.rejects(() => sender.end(), /no block was acknowledged for 1s/)
    } finally {
      await sender.close()
      await closeUdp(silent)
    }
  })

  it("logs limited drops by reason at most once per interval", async () => {
    const lines: string[] = []
    // A long interval keeps all 5 sends inside the first one, even on a busy machine.
    const set = await relays(1, { ...open, datagramRatePerSec: 1, bandwidthBps: 0 }, (line) => lines.push(line), 1000)
    const socket = createUdpSocket()
    try {
      await bindUdp(socket, "127.0.0.1", 0)
      const inner = encodeData({
        kind: "data",
        sessionId: randomBytes(16),
        blockId: 0,
        tesseraIndex: 0,
        k: 1,
        n: 1,
        cipherLen: 1,
        payload: Buffer.from([1]),
      })
      for (let i = 0; i < 5; i++) await sendUdp(socket, encodeEnvelope({ host: "127.0.0.1", port: 9 }, inner), set[0]!.endpoint)
      await sleep(1500)
      const limited = lines.filter((line) => line.includes("event=limited"))
      assert.equal(limited.length, 1)
      assert.match(limited[0] ?? "", /^\d{2}:\d{2}:\d{2}\.\d{3} role=relay event=limited session=0 datagram=4 bandwidth=0 destination=0 table=0$/)
    } finally {
      await closeUdp(socket)
      for (const relay of set) await relay.close()
    }
  })
})

/** A stand-in relay that forwards everything but the first ACK for each block. */
async function ackDropper(): Promise<{ endpoint: Endpoint; dropped: () => number; close: () => Promise<void> }> {
  const socket = createUdpSocket()
  const endpoint = await bindUdp(socket, "127.0.0.1", 0)
  const seen = new Set<number>()
  let dropped = 0
  socket.on("message", (msg) => {
    const env = decodeEnvelope(Buffer.from(msg))
    if (!env) return
    const frame = peekRelayFrame(env.inner)
    if (frame?.kind === "ack" && !seen.has(frame.blockId)) {
      seen.add(frame.blockId)
      dropped++
      return
    }
    socket.send(env.inner, env.dest.port, env.dest.host)
  })
  return { endpoint, dropped: () => dropped, close: () => closeUdp(socket) }
}
