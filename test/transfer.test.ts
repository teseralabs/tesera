import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { fullBlockBodySize } from "../src/constants.js"
import { bindUdp, closeUdp, createUdpSocket, sendUdp } from "../src/carrier/udp.js"
import { runTransfer } from "../src/experiment.js"
import { encodeEnvelope } from "../src/protocol/envelope.js"
import { encodeAck, encodeData } from "../src/protocol/frames.js"
import { Relay } from "../src/relay/relay.js"
import { PathScheduler } from "../src/transport/scheduler.js"
import { sleep } from "../src/util.js"

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition")
    await sleep(5)
  }
}

function feedCohort(scheduler: PathScheduler, rttAt: (index: number) => number): void {
  const placed = scheduler.plan()
  const sent: Array<{ relay: number; cohort: number }> = []
  for (const relay of placed) {
    if (relay === null) continue
    sent.push({ relay, cohort: scheduler.noteSend(relay) })
  }
  sent.forEach((send, index) => scheduler.observe(send.relay, rttAt(index), send.cohort))
}

describe("scheduler", () => {
  it("spreads a block while every path is unknown", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    assert.deepEqual(scheduler.plan(), [0, 1, 2])
  })

  it("shares a block across paths in the same delay band", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    scheduler.plan()
    scheduler.noteSend(0)
    scheduler.observe(0, 5)
    scheduler.noteSend(1)
    scheduler.observe(1, 7)
    scheduler.noteSend(2)
    scheduler.observe(2, 8)
    assert.deepEqual(scheduler.plan(), [0, 1, 2])
  })

  it("puts both required tesserae on the fast path and skips slow parity", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    scheduler.plan()
    scheduler.noteSend(0)
    scheduler.observe(0, 5)
    scheduler.noteSend(1)
    scheduler.observe(1, 100)
    scheduler.noteSend(2)
    scheduler.observe(2, 100)
    assert.deepEqual(scheduler.plan(), [0, 0, null])
  })

  it("keeps parity on a spare path with a similar delay", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    scheduler.plan()
    for (const relay of [0, 1, 2]) {
      scheduler.noteSend(relay)
      scheduler.observe(relay, relay === 2 ? 8 : 5)
    }
    assert.deepEqual(scheduler.plan(), [0, 1, 2])
  })

  it("stops using a path that never answers", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    scheduler.plan()
    scheduler.noteSend(0)
    scheduler.miss(0)
    scheduler.noteSend(1)
    scheduler.observe(1, 4)
    scheduler.noteSend(2)
    scheduler.observe(2, 4)
    assert.deepEqual(scheduler.plan(), [1, 2, null])
  })

  it("stops retransmitting on a measured path that died while the others are busy", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    for (let round = 0; round < 50; round++) {
      for (const relay of [0, 1, 2]) {
        scheduler.noteSend(relay)
        scheduler.observe(relay, 20)
      }
    }
    for (let i = 0; i < 30; i++) {
      scheduler.noteSend(0)
      scheduler.noteSend(1)
    }
    const picks: number[] = []
    for (let i = 0; i < 40; i++) {
      const relay = scheduler.best()
      picks.push(relay)
      scheduler.noteSend(relay, false)
      if (relay === 2) scheduler.miss(2)
      else {
        scheduler.observe(relay, 20)
        scheduler.noteSend(relay)
      }
    }
    assert.ok(picks.filter((relay) => relay === 2).length <= 3, `dead path picked ${picks.join(",")}`)
  })

  it("learns a path from a sample that arrives after the block is finished", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    scheduler.plan()
    scheduler.noteSend(0)
    scheduler.observe(0, 5)
    scheduler.noteSend(1)
    scheduler.release(1)
    scheduler.noteSend(2)
    scheduler.release(2)
    assert.deepEqual(scheduler.plan(), [0, 0, null])
    scheduler.noteRtt(1, 5)
    scheduler.noteRtt(2, 6)
    assert.deepEqual(scheduler.plan(), [0, 1, 2])
  })

  it("collapses when one block fails on every path", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    const placed = scheduler.plan()
    const sent: Array<{ relay: number; cohort: number }> = []
    for (const relay of placed) {
      if (relay === null) continue
      sent.push({ relay, cohort: scheduler.noteSend(relay) })
    }
    for (const send of sent) scheduler.miss(send.relay, send.cohort)
    const next = scheduler.plan()
    assert.equal(scheduler.sharesFate, true)
    assert.equal(next[0], next[1])
    assert.equal(next[2], null)
  })

  it("keeps spreading when a shared failure follows a split one", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    scheduler.plan()
    const ok = scheduler.noteSend(0)
    const bad = scheduler.noteSend(1)
    const also = scheduler.noteSend(2)
    scheduler.noteRtt(0, 5, ok)
    scheduler.miss(1, bad)
    scheduler.noteRtt(2, 5, also)
    const placed = scheduler.plan()
    const sent: Array<{ relay: number; cohort: number }> = []
    for (const relay of placed) {
      if (relay === null) continue
      sent.push({ relay, cohort: scheduler.noteSend(relay) })
    }
    for (const send of sent) scheduler.miss(send.relay, send.cohort)
    assert.equal(scheduler.sharesFate, false)
    const next = scheduler.plan()
    assert.notEqual(next[0], next[1])
  })

  it("collapses when every path in a block fails together", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    for (let round = 0; round < 4; round++) {
      const placed = scheduler.plan()
      const sent: Array<{ relay: number; cohort: number }> = []
      for (const relay of placed) {
        if (relay === null) continue
        sent.push({ relay, cohort: scheduler.noteSend(relay) })
      }
      for (const send of sent) scheduler.miss(send.relay, send.cohort)
    }
    const placed = scheduler.plan()
    assert.equal(scheduler.sharesFate, true)
    assert.equal(placed[0], placed[1])
    assert.equal(placed[2], null)
  })

  it("keeps spreading when failures are split across paths", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    for (let round = 0; round < 4; round++) {
      scheduler.plan()
      const first = scheduler.noteSend(0)
      const second = scheduler.noteSend(1)
      const third = scheduler.noteSend(2)
      scheduler.noteRtt(0, 5, first)
      scheduler.miss(1, second)
      scheduler.noteRtt(2, 5, third)
    }
    assert.equal(scheduler.sharesFate, false)
  })

  it("clears a covered loss when the sample arrives", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    for (let i = 0; i < 8; i++) {
      for (const relay of [0, 1, 2]) {
        scheduler.noteSend(relay)
        scheduler.observe(relay, 5)
      }
    }
    const token = scheduler.noteUnanswered(1)
    scheduler.deliver(1, token)
    scheduler.plan()
    const placed = scheduler.plan()
    assert.ok(placed.includes(1))
  })

  it("keeps a delivering path after one covered loss", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    for (let i = 0; i < 8; i++) {
      for (const relay of [0, 1, 2]) {
        scheduler.noteSend(relay)
        scheduler.observe(relay, 5)
      }
    }
    scheduler.noteLost(1)
    scheduler.plan()
    const placed = scheduler.plan()
    assert.ok(placed.includes(1))
  })

  it("shares again once a later block fails on only some paths", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    scheduler.plan()
    for (const relay of [0, 1, 2]) {
      scheduler.noteSend(relay)
      scheduler.observe(relay, 5)
    }
    const first = scheduler.plan()
    const joint: Array<{ relay: number; cohort: number }> = []
    for (const relay of first) {
      if (relay === null) continue
      joint.push({ relay, cohort: scheduler.noteSend(relay) })
    }
    const second = scheduler.plan()
    const split: Array<{ relay: number; cohort: number }> = []
    for (const relay of second) {
      if (relay === null) continue
      split.push({ relay, cohort: scheduler.noteSend(relay) })
    }
    for (const send of joint) scheduler.miss(send.relay, send.cohort)
    assert.equal(scheduler.sharesFate, true)
    const ok = split[0]
    if (!ok) throw new Error("expected a placed tessera")
    scheduler.noteRtt(ok.relay, 5, ok.cohort)
    for (const send of split.slice(1)) scheduler.miss(send.relay, send.cohort)
    assert.equal(scheduler.sharesFate, false)
    const placed = scheduler.plan()
    assert.notEqual(placed[0], placed[1])
  })

  it("keeps sharing clean paths when another path keeps dropping", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    for (let i = 0; i < 16; i++) {
      for (const relay of [0, 1]) {
        scheduler.noteSend(relay)
        scheduler.observe(relay, 5)
      }
      scheduler.noteSend(2)
      if (i % 3 === 0) scheduler.noteLost(2)
      else scheduler.observe(2, 5)
    }
    scheduler.plan()
    const placed = scheduler.plan()
    assert.deepEqual(placed, [0, 1, null])
  })

  it("moves required tesserae off a path that keeps dropping", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    for (const relay of [0, 1, 2]) {
      scheduler.noteSend(relay)
      scheduler.observe(relay, 5)
    }
    for (let i = 0; i < 16; i++) {
      scheduler.noteSend(0)
      scheduler.observe(0, 5)
      for (const relay of [1, 2]) {
        scheduler.noteSend(relay)
        if (i % 3 === 0) scheduler.noteLost(relay)
        else scheduler.observe(relay, 5)
      }
    }
    scheduler.plan()
    const placed = scheduler.plan()
    assert.equal(placed[0], 0)
    assert.equal(placed[1], 0)
    assert.equal(placed[2], null)
  })

  it("waits three measured round trips before calling a tessera lost", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    assert.equal(scheduler.repairHoldMs(0), 0)
    scheduler.noteSend(0)
    scheduler.observe(0, 10)
    assert.equal(scheduler.repairHoldMs(0), 30)
  })

  it("probes a spare path on every 16th assignment", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    scheduler.noteSend(0)
    scheduler.observe(0, 5)
    scheduler.noteSend(1)
    scheduler.observe(1, 100)
    scheduler.noteSend(2)
    scheduler.observe(2, 100)
    const probed = scheduler.plan()
    assert.equal(probed[0], 0)
    assert.equal(probed[1], 0)
    assert.equal(probed[2], 1)
  })

  it("rotates data across relays and holds parity when one queue is shared", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    for (let round = 0; round < 6; round++) feedCohort(scheduler, (index) => 10 + index * 3)
    assert.equal(scheduler.sharesQueue, true)
    assert.equal(scheduler.sharesFate, false)
    const first = scheduler.plan()
    const second = scheduler.plan()
    assert.notEqual(first[0], first[1])
    assert.equal(first[2], null)
    assert.notEqual(second[0], second[1])
    assert.equal(second[2], null)
    assert.notEqual(first[0], second[0])
  })

  it("keeps parity when relays are equally fast on their own pipes", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    for (let round = 0; round < 6; round++) feedCohort(scheduler, () => 10)
    assert.equal(scheduler.sharesQueue, false)
    assert.deepEqual(scheduler.plan(), [0, 1, 2])
  })

  it("sends parity again after a relay misses on a shared queue", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    for (let round = 0; round < 6; round++) feedCohort(scheduler, (index) => 10 + index * 3)
    assert.equal(scheduler.sharesQueue, true)
    const placed = scheduler.plan()
    const relay = placed[0]
    if (relay === null || relay === undefined) throw new Error("expected a data tessera")
    scheduler.miss(relay, scheduler.noteSend(relay))
    const repaired = scheduler.plan()
    assert.notEqual(repaired[0], repaired[1])
    assert.notEqual(repaired[2], null)
  })

  it("still collapses onto one relay when a shared queue also loses every tessera", () => {
    const scheduler = new PathScheduler(3, 2, 3)
    for (let round = 0; round < 6; round++) feedCohort(scheduler, (index) => 10 + index * 3)
    assert.equal(scheduler.sharesQueue, true)
    const placed = scheduler.plan()
    const sent: Array<{ relay: number; cohort: number }> = []
    for (const relay of placed) {
      if (relay === null) continue
      sent.push({ relay, cohort: scheduler.noteSend(relay) })
    }
    for (const send of sent) scheduler.miss(send.relay, send.cohort)
    const next = scheduler.plan()
    assert.equal(scheduler.sharesFate, true)
    assert.equal(next[0], next[1])
    assert.equal(next[2], null)
  })
})

describe("relay", () => {
  it("drops non-loopback destinations and blackholed packets", async () => {
    const relay = new Relay()
    const blackhole = new Relay({ adversity: { blackhole: true }, seed: 2 })
    const socket = createUdpSocket()
    await relay.start()
    await blackhole.start()
    await bindUdp(socket, "127.0.0.1", 0)
    try {
      await sendUdp(socket, encodeEnvelope({ host: "8.8.8.8", port: 9 }, Buffer.from("nope")), relay.endpoint)
      await sendUdp(socket, encodeEnvelope({ host: "127.0.0.1", port: 9 }, Buffer.from("drop")), blackhole.endpoint)
      await waitUntil(() => relay.stats.droppedDenied === 1 && blackhole.stats.droppedBlackhole === 1, 1000)
      assert.equal(relay.stats.forwarded, 0)
      assert.equal(blackhole.stats.forwarded, 0)
    } finally {
      await closeUdp(socket)
      await relay.close()
      await blackhole.close()
    }
  })

  it("logs a block once on arrival and once when its ack passes", async () => {
    const lines: string[] = []
    const relay = new Relay({ log: (line) => lines.push(line), logLevel: "debug" })
    const socket = createUdpSocket()
    await relay.start()
    await bindUdp(socket, "127.0.0.1", 0)
    const sessionId = randomBytes(16)
    const key = randomBytes(32)
    const tessera = (tesseraIndex: number) =>
      encodeEnvelope(
        { host: "127.0.0.1", port: 9 },
        encodeData({
          kind: "data",
          sessionId,
          blockId: 3,
          tesseraIndex,
          k: 2,
          n: 3,
          cipherLen: 4,
          payload: randomBytes(4),
        }),
      )
    try {
      await sendUdp(socket, tessera(0), relay.endpoint)
      await sendUdp(socket, tessera(1), relay.endpoint)
      await sendUdp(
        socket,
        encodeEnvelope({ host: "127.0.0.1", port: 9 }, encodeAck({ kind: "ack", sessionId, blockId: 3 }, key)),
        relay.endpoint,
      )
      await waitUntil(() => lines.length >= 2, 1000)
      assert.equal(lines.length, 2)
      assert.match(
        lines[0] ?? "",
        /^\d{2}:\d{2}:\d{2}\.\d{3} role=relay event=block-in block=3 from=127\.0\.0\.1:\d+ to=127\.0\.0\.1:9$/,
      )
      assert.match(
        lines[1] ?? "",
        /^\d{2}:\d{2}:\d{2}\.\d{3} role=relay event=block-ack block=3 from=127\.0\.0\.1:\d+ to=127\.0\.0\.1:9$/,
      )
    } finally {
      await closeUdp(socket)
      await relay.close()
    }
  })
})

describe("transfer", () => {
  it("round-trips empty, short, aligned, and unaligned payloads", async () => {
    const body = fullBlockBodySize(2, 1024)
    for (const payload of [Buffer.alloc(0), randomBytes(1), randomBytes(body), randomBytes(body + 1)]) {
      const { output, metrics } = await runTransfer({
        payload,
        retxAfterMs: 500,
        nackAfterMs: 500,
        deadlineMs: 10_000,
      })
      assert.deepEqual(output, Buffer.from(payload))
      assert.equal(metrics.inputBytes, payload.length)
      assert.equal(metrics.tesseraRetransmissions, 0)
    }
  })

  it("reconstructs when one relay is a blackhole and does not retransmit", async () => {
    const payload = randomBytes(80_000)
    const { metrics } = await runTransfer({
      payload,
      adversity: [{ blackhole: true }, {}, {}],
      retxAfterMs: 500,
      nackAfterMs: 500,
      deadlineMs: 10_000,
    })
    assert.equal(metrics.tesseraRetransmissions, 0)
    assert.ok(metrics.blocksMissingSystematic > 0)
    assert.ok((metrics.relays[0]?.droppedBlackhole ?? 0) > 0)
    assert.equal(metrics.relays[0]?.forwarded, 0)
    assert.ok((metrics.relays[1]?.forwarded ?? 0) > 0)
  })

  it("reconstructs on the one live path when the others are blackholes", async () => {
    const payload = randomBytes(8_000)
    const { output, metrics } = await runTransfer({
      payload,
      adversity: [{ blackhole: true }, { blackhole: true }, {}],
      deadlineMs: 10_000,
    })
    assert.deepEqual(output, payload)
    assert.equal(metrics.relays[0]?.forwarded, 0)
    assert.equal(metrics.relays[1]?.forwarded, 0)
    assert.ok((metrics.relays[2]?.forwarded ?? 0) > 0)
  })

  it("fails when every path is a blackhole", async () => {
    await assert.rejects(
      () =>
        runTransfer({
          payload: randomBytes(1000),
          adversity: [{ blackhole: true }, { blackhole: true }, { blackhole: true }],
          maxSends: 4,
          nackAfterMs: 20,
          retxAfterMs: 40,
          deadlineMs: 5_000,
        }),
      /exceeded|timed out/,
    )
  })

  it("survives loss, delay, and reordering", async () => {
    const { output } = await runTransfer({
      payload: randomBytes(40_000),
      adversity: { lossRate: 0.2, delayMs: 4, jitterMs: 6, reorderMs: 12 },
      seed: 7,
      deadlineMs: 20_000,
    })
    assert.equal(output.length, 40_000)
  })

  it("does not keep retransmitting when the round trip is longer than the retransmit timer", async () => {
    const { output, metrics } = await runTransfer({
      payload: randomBytes(60_000),
      k: 1,
      n: 1,
      relays: 1,
      adversity: { delayMs: 80, jitterMs: 30 },
      retxAfterMs: 120,
      nackAfterMs: 5_000,
      deadlineMs: 20_000,
    })
    assert.equal(output.length, 60_000)
    // The first block goes out before any round trip is measured, so only it may be resent.
    assert.ok(metrics.tesseraRetransmissions <= 1, `${metrics.tesseraRetransmissions} retransmissions`)
  })

  it("does not put plaintext on the relay path", async () => {
    const marker = Buffer.from("this-is-the-plaintext-marker-9f3a")
    const forwarded: Buffer[] = []
    await runTransfer({
      payload: Buffer.concat([marker, randomBytes(1500), marker]),
      retxAfterMs: 500,
      nackAfterMs: 500,
      tapRelays(relays) {
        for (const relay of relays) {
          relay.onForward = (inner) => forwarded.push(Buffer.from(inner))
        }
      },
    })
    const blob = Buffer.concat(forwarded)
    assert.ok(blob.length > 0)
    assert.equal(blob.includes(marker), false)
  })

  it("fails when a shared pipe drops every packet", async () => {
    await assert.rejects(
      () =>
        runTransfer({
          payload: randomBytes(1500),
          shared: { lossRate: 1 },
          maxSends: 3,
          nackAfterMs: 20,
          retxAfterMs: 40,
          deadlineMs: 4_000,
        }),
      /exceeded|timed out/,
    )
  })

  it("slows down when every relay shares one bandwidth cap", async () => {
    const started = performance.now()
    const { metrics } = await runTransfer({
      payload: randomBytes(24_000),
      shared: { bandwidthBps: 400_000 },
      deadlineMs: 15_000,
    })
    assert.ok(performance.now() - started > 400)
    assert.equal(metrics.inputBytes, 24_000)
  })

  it("applies a relay bandwidth cap", async () => {
    const started = performance.now()
    await runTransfer({
      payload: randomBytes(32_000),
      k: 1,
      n: 1,
      relays: 1,
      adversity: { bandwidthBps: 250_000 },
      retxAfterMs: 5_000,
      nackAfterMs: 5_000,
      deadlineMs: 20_000,
    })
    assert.ok(performance.now() - started > 500)
  })

  it("does not retransmit 3-of-5 when each relay has its own pipe", async () => {
    const payload = randomBytes(256_000)
    const adversity = Array.from({ length: 5 }, () => ({ bandwidthBps: 8_000_000 }))
    for (const seed of [1, 2, 3]) {
      const { metrics } = await runTransfer({
        payload,
        k: 3,
        n: 5,
        relays: 5,
        seed,
        adversity,
        deadlineMs: 20_000,
      })
      assert.equal(metrics.tesseraRetransmissions, 0, `seed ${seed}`)
      const used = metrics.relays.filter((relay) => relay.forwarded > 0).length
      assert.ok(used >= 3, `seed ${seed}`)
    }
  })

  it("keeps splitting across relays and holds parity on one shared pipe", async () => {
    const payload = randomBytes(80_000)
    const pipe = { bandwidthBps: 4_000_000 }
    const shared = await runTransfer({ payload, shared: pipe, deadlineMs: 15_000 })
    const single = await runTransfer({
      payload,
      k: 1,
      n: 1,
      relays: 1,
      adversity: pipe,
      deadlineMs: 15_000,
    })
    const used = shared.metrics.relays.filter((relay) => relay.forwarded > 0).length
    assert.ok(used >= 2)
    assert.ok(shared.metrics.dataOverhead < 1.3)
    assert.ok(shared.metrics.throughputMbps > single.metrics.throughputMbps * 0.8)
  })
})
