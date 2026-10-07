import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp } from "../src/carrier/udp.js"
import { generateIdentity } from "../src/identity/id.js"
import { readRelaySnapshot } from "../src/identity/stats.js"
import { readRelayTable } from "../src/identity/peers.js"
import { encodeEnvelope } from "../src/protocol/envelope.js"
import { encodeAck, encodeData, encodeNack } from "../src/protocol/frames.js"
import { parsePeerTtl } from "../src/relay/config.js"
import { parseAccess, parseBandwidth, readPolicy } from "../src/relay/policy.js"
import { Relay } from "../src/relay/relay.js"
import { sleep } from "../src/util.js"

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url))
const uncapped = { bandwidthBps: 0, maxSessions: 0, peerRatePerMin: 0, datagramRatePerSec: 0 }

describe("relay settings", () => {
  it("serves the snapshot and continues totals from the analytics file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-analytics-"))
    const file = join(dir, "analytics.json")
    const lines: string[] = []
    const first = new Relay({
      host: "127.0.0.1",
      analyticsFile: file,
      api: { host: "127.0.0.1", port: 0 },
      log: (line) => lines.push(line),
      logLevel: "info",
    })
    const socket = createUdpSocket()
    try {
      const bound = await first.start()
      await bindUdp(socket, "127.0.0.1", 0)
      assert.ok(lines.some((line) => line.includes("event=api ")))
      assert.equal(lines.some((line) => line.includes("event=block-in ")), false)
      const api = first.apiEndpoint
      assert.ok(api)
      const before = await fetch(`http://${api.host}:${api.port}/v1/stats`)
      assert.equal(before.status, 200)
      assert.equal(before.headers.get("access-control-allow-origin"), null, "the relay API is not for browsers")
      assert.deepEqual(await before.json(), first.snapshot())
      const missing = await fetch(`http://${api.host}:${api.port}/v1/other`)
      assert.equal(missing.status, 404)
      assert.equal((await fetch(`http://${api.host}:${api.port}/v0/stats`)).status, 404)

      const sessionId = randomBytes(16)
      const data = encodeData({
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
      await sendUdp(socket, encodeEnvelope({ host: "127.0.0.1", port: 9 }, data), bound)
      await sendUdp(socket, encodeEnvelope({ host: "127.0.0.1", port: 9 }, ack), bound)
      await sleep(40)
      const live = await fetch(`http://${api.host}:${api.port}/v1/stats`)
      const body = (await live.json()) as { relays: number; bytes: number; transfers: number }
      assert.equal(body.transfers, 1)
      assert.ok(body.bytes > 0)
      assert.deepEqual(body, first.snapshot())
    } finally {
      await closeUdp(socket)
      await first.close()
    }

    const saved = JSON.parse(await readFile(file, "utf8")) as { bytes: number; transfers: number }
    assert.equal(saved.transfers, 1)
    assert.ok(saved.bytes > 0)

    const second = new Relay({ host: "127.0.0.1", analyticsFile: file })
    try {
      await second.start()
      assert.equal(second.snapshot().bytes, saved.bytes)
      assert.equal(second.snapshot().transfers, 1)
      assert.equal(second.apiEndpoint, null)
    } finally {
      await second.close()
    }
  })

  it("reports what this process forwarded", async () => {
    const relay = new Relay({ host: "127.0.0.1", api: { host: "127.0.0.1", port: 0 } })
    const socket = createUdpSocket()
    try {
      const bound = await relay.start()
      await bindUdp(socket, "127.0.0.1", 0)
      const api = relay.apiEndpoint
      assert.ok(api)
      const sessionId = randomBytes(16)
      const key = randomBytes(32)
      const data = encodeData({
        kind: "data",
        sessionId,
        blockId: 0,
        tesseraIndex: 0,
        k: 1,
        n: 1,
        cipherLen: 1,
        payload: Buffer.from([1]),
      })
      const dest = { host: "127.0.0.1", port: 9 }
      await sendUdp(socket, encodeEnvelope(dest, data), bound)
      await sendUdp(socket, encodeEnvelope(dest, data), bound)
      await sendUdp(socket, encodeEnvelope(dest, encodeAck({ kind: "ack", sessionId, blockId: 0 }, key)), bound)
      await sendUdp(
        socket,
        encodeEnvelope(dest, encodeNack({ kind: "nack", sessionId, blockId: 0, missing: [0] }, key)),
        bound,
      )
      await sendUdp(socket, Buffer.from("nope"), bound)
      await sendUdp(socket, encodeEnvelope({ host: "8.8.8.8", port: 9 }, data), bound)
      await sleep(40)
      const response = await fetch(`http://${api.host}:${api.port}/v1/relay`)
      assert.equal(response.status, 200)
      const body = (await response.json()) as {
        uptimeMs: number
        forwarded: number
        bytes: number
        data: number
        acks: number
        nacks: number
        duplicates: number
        denied: number
        invalid: number
      }
      assert.ok(body.uptimeMs >= 0)
      assert.equal(body.forwarded, 4)
      assert.ok(body.bytes > 0)
      assert.equal(body.data, 2)
      assert.equal(body.acks, 1)
      assert.equal(body.nacks, 1)
      assert.equal(body.duplicates, 1)
      assert.equal(body.denied, 1)
      assert.equal(body.invalid, 1)
      const again = relay.report()
      assert.equal(again.forwarded, body.forwarded)
      assert.equal(again.bytes, body.bytes)
      assert.ok(again.uptimeMs >= body.uptimeMs)
    } finally {
      await closeUdp(socket)
      await relay.close()
    }
  })

  it("reports persisted joiner totals to the seed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-analytics-"))
    const file = join(dir, "joiner.json")
    await writeFile(file, `${JSON.stringify({ bytes: 50, transfers: 2 })}\n`)
    const seed = new Relay({ host: "127.0.0.1", identity: generateIdentity() })
    const joiner = new Relay({ host: "127.0.0.1", identity: generateIdentity(), analyticsFile: file })
    try {
      const seedEndpoint = await seed.start()
      await joiner.start()
      await joiner.join(seedEndpoint)
      await joiner.publishUsage()
      await sleep(40)
      const snapshot = await readRelaySnapshot(seedEndpoint)
      assert.equal(snapshot.relays, 2)
      assert.equal(snapshot.bytes, 50)
      assert.equal(snapshot.transfers, 2)
    } finally {
      await joiner.close()
      await seed.close()
    }
  })

  it("reads a peer keep window", () => {
    const day = 24 * 60 * 60 * 1000
    assert.equal(parsePeerTtl("30"), 30 * day)
    assert.equal(parsePeerTtl("30d"), 30 * day)
    assert.equal(parsePeerTtl("12h"), 12 * 60 * 60 * 1000)
    assert.equal(parsePeerTtl("45s"), 45_000)
    assert.equal(parsePeerTtl("0s"), 0)
    assert.throws(() => parsePeerTtl("later"), /--peer-ttl/)
  })

  it("hides a quiet relay and puts it back when it reports", async () => {
    const lines: string[] = []
    const dir = await mkdtemp(join(tmpdir(), "tesera-analytics-"))
    const file = join(dir, "joiner.json")
    await writeFile(file, `${JSON.stringify({ bytes: 50, transfers: 2 })}\n`)
    const seed = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      log: (line) => lines.push(line),
      logLevel: "info",
      peerOfflineMs: 80,
      peerTtlMs: 200,
    })
    const joiner = new Relay({ host: "127.0.0.1", identity: generateIdentity(), analyticsFile: file })
    try {
      const seedEndpoint = await seed.start()
      await joiner.start()
      await joiner.join(seedEndpoint)
      await joiner.publishUsage()
      await sleep(40)
      assert.equal((await readRelaySnapshot(seedEndpoint)).relays, 2)
      assert.equal((await readRelayTable(seedEndpoint)).peers.length, 1)

      await sleep(100)
      const hidden = await readRelaySnapshot(seedEndpoint)
      assert.equal(hidden.relays, 1)
      assert.equal(hidden.bytes, 50)
      assert.equal(hidden.transfers, 2)
      assert.equal((await readRelayTable(seedEndpoint)).peers.length, 0)
      assert.equal(lines.some((line) => line.includes("event=offline ")), true)

      await joiner.publishUsage()
      await sleep(40)
      assert.equal((await readRelaySnapshot(seedEndpoint)).relays, 2)
      assert.equal((await readRelayTable(seedEndpoint)).peers.length, 1)
      assert.equal(lines.some((line) => line.includes("event=online ")), true)

      await sleep(320)
      const forgotten = await readRelaySnapshot(seedEndpoint)
      assert.equal(forgotten.relays, 1)
      assert.equal(forgotten.bytes, 0)
      assert.equal(forgotten.transfers, 0)
      assert.equal(lines.some((line) => line.includes("event=forget ")), true)

      await joiner.publishUsage()
      await sleep(40)
      assert.equal((await readRelaySnapshot(seedEndpoint)).relays, 1)
      await joiner.join(seedEndpoint)
      await sleep(40)
      assert.equal((await readRelaySnapshot(seedEndpoint)).relays, 2)
    } finally {
      await joiner.close()
      await seed.close()
    }
  })

  it("reloads a quiet relay from the peers file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-peers-"))
    const file = join(dir, "peers.json")
    const identity = generateIdentity()
    const stored = {
      peers: [
        {
          id: identity.id,
          host: "127.0.0.1",
          port: 4101,
          seenAt: Date.now() - 60_000,
          seq: 4,
          bytes: 50,
          transfers: 2,
        },
      ],
    }
    await writeFile(file, `${JSON.stringify(stored)}\n`)
    const seed = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      peersFile: file,
      peerOfflineMs: 1000,
      peerTtlMs: 86_400_000,
    })
    const joiner = new Relay({ host: "127.0.0.1", identity })
    try {
      const seedEndpoint = await seed.start()
      const hidden = seed.snapshot()
      assert.equal(hidden.relays, 1)
      assert.equal(hidden.bytes, 50)
      assert.equal(hidden.transfers, 2)
      assert.equal((await readRelayTable(seedEndpoint)).peers.length, 0)
      await joiner.start()
      await joiner.join(seedEndpoint)
      await joiner.publishUsage()
      await sleep(40)
      const back = seed.snapshot()
      assert.equal(back.relays, 2)
      assert.equal(back.bytes, 0)
      await seed.close()
      const saved = JSON.parse(await readFile(file, "utf8")) as { peers: Array<{ id: string; port: number }> }
      assert.equal(saved.peers.length, 1)
      assert.equal(saved.peers[0]?.id, identity.id)
      assert.equal(saved.peers[0]?.port, joiner.endpoint.port)
    } finally {
      await joiner.close()
      await seed.close()
    }
  })

  it("drops an expired relay when the peers file loads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-peers-"))
    const file = join(dir, "peers.json")
    const stored = {
      peers: [
        {
          id: generateIdentity().id,
          host: "127.0.0.1",
          port: 4101,
          seenAt: Date.now() - 10_000,
          seq: 2,
          bytes: 50,
          transfers: 2,
        },
      ],
    }
    await writeFile(file, `${JSON.stringify(stored)}\n`)
    const seed = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      peersFile: file,
      peerOfflineMs: 40,
      peerTtlMs: 50,
    })
    try {
      await seed.start()
      assert.equal(seed.snapshot().relays, 1)
      assert.equal(seed.snapshot().bytes, 0)
      await seed.close()
      const saved = JSON.parse(await readFile(file, "utf8")) as { peers: unknown[] }
      assert.deepEqual(saved.peers, [])
    } finally {
      await seed.close()
    }
  })

  it("refuses to start when the peers file is damaged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-peers-"))
    const file = join(dir, "peers.json")
    await writeFile(file, "{")
    const relay = new Relay({ host: "127.0.0.1", peersFile: file })
    await assert.rejects(() => relay.start(), /peers file is not valid JSON/)
  })

  it("forgets a quiet relay immediately when the keep window is 0", async () => {
    const seed = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      peerOfflineMs: 40,
      peerTtlMs: 0,
    })
    const joiner = new Relay({ host: "127.0.0.1", identity: generateIdentity() })
    try {
      const seedEndpoint = await seed.start()
      await joiner.start()
      await joiner.join(seedEndpoint)
      await joiner.publishUsage()
      await sleep(20)
      assert.equal((await readRelaySnapshot(seedEndpoint)).relays, 2)
      await sleep(50)
      assert.equal((await readRelaySnapshot(seedEndpoint)).relays, 1)
      await joiner.publishUsage()
      await sleep(20)
      assert.equal((await readRelaySnapshot(seedEndpoint)).relays, 1)
    } finally {
      await joiner.close()
      await seed.close()
    }
  })

  it("lists a quiet relay as offline and keeps the seed first", async () => {
    const seedId = generateIdentity()
    const joinerId = generateIdentity()
    const seed = new Relay({
      host: "127.0.0.1",
      identity: seedId,
      api: { host: "127.0.0.1", port: 0 },
      peerOfflineMs: 40,
      peerTtlMs: 60_000,
    })
    const joiner = new Relay({ host: "127.0.0.1", identity: joinerId })
    try {
      const bound = await seed.start()
      const api = seed.apiEndpoint
      assert.ok(api)
      await joiner.start()
      await joiner.join(bound)
      await joiner.publishUsage()
      await sleep(20)
      const live = (await (await fetch(`http://${api.host}:${api.port}/v1/peers`)).json()) as {
        relays: Array<{ id: string; online: boolean; seq?: number }>
      }
      assert.equal(live.relays.length, 2)
      assert.equal(live.relays[0]?.id, seedId.id)
      assert.equal(live.relays[0]?.online, true)
      assert.equal(live.relays[1]?.id, joinerId.id)
      assert.equal(live.relays[1]?.online, true)
      assert.equal("seq" in (live.relays[1] ?? {}), false)
      await sleep(50)
      const later = (await (await fetch(`http://${api.host}:${api.port}/v1/peers`)).json()) as {
        relays: Array<{ id: string; online: boolean }>
      }
      assert.equal(later.relays[0]?.id, seedId.id)
      assert.equal(later.relays[0]?.online, true)
      assert.equal(later.relays.find((relay) => relay.id === joinerId.id)?.online, false)
    } finally {
      await joiner.close()
      await seed.close()
    }
  })

  it("refuses to start when the analytics file is damaged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-analytics-"))
    const file = join(dir, "analytics.json")
    await writeFile(file, "{")
    const relay = new Relay({ host: "127.0.0.1", analyticsFile: file })
    await assert.rejects(() => relay.start(), /metrics file is not valid JSON/)
  })

  it("prints block lines only at debug", async () => {
    const lines: string[] = []
    const relay = new Relay({ host: "127.0.0.1", log: (line) => lines.push(line), logLevel: "debug" })
    const socket = createUdpSocket()
    try {
      const bound = await relay.start()
      await bindUdp(socket, "127.0.0.1", 0)
      const inner = encodeData({
        kind: "data",
        sessionId: randomBytes(16),
        blockId: 1,
        tesseraIndex: 0,
        k: 1,
        n: 1,
        cipherLen: 1,
        payload: Buffer.from([1]),
      })
      await sendUdp(socket, encodeEnvelope({ host: "127.0.0.1", port: 9 }, inner), bound)
      await sleep(40)
      assert.equal(lines.some((line) => line.includes("event=block-in ")), true)
    } finally {
      await closeUdp(socket)
      await relay.close()
    }
  })

  it("reads bandwidth and access flags", () => {
    assert.equal(parseBandwidth("5mbps"), 625_000)
    assert.equal(parseBandwidth("5"), 625_000)
    assert.equal(parseBandwidth("500kbps"), 62_500)
    assert.equal(parseBandwidth("0"), 0)
    assert.equal(parseAccess("private"), "private")
    assert.throws(() => parseAccess("trusted"), /--access must be open or private/)
  })

  it("refuses a join until that relay is allowed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-policy-"))
    const file = join(dir, "policy.json")
    const lines: string[] = []
    const joinerId = generateIdentity()
    const seed = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      log: (line) => lines.push(line),
      logLevel: "info",
      policy: { access: "private", ...uncapped },
      policyFile: file,
    })
    const joiner = new Relay({ host: "127.0.0.1", identity: joinerId })
    try {
      const bound = await seed.start()
      await joiner.start()
      await assert.rejects(() => joiner.join(bound, 400), /did not join/)
      assert.equal(lines.some((line) => line.includes("reason=access")), true)
      const allowed = spawnSync(process.execPath, [cliPath, "allow", joinerId.id, "--policy-file", file], {
        encoding: "utf8",
      })
      assert.equal(allowed.status, 0, allowed.stderr)
      await sleep(1200)
      await joiner.join(bound)
      assert.equal((await readRelayTable(bound)).peers.some((peer) => peer.id === joinerId.id), true)
    } finally {
      await joiner.close()
      await seed.close()
    }
  })

  it("blocks a relay id and forgets it without keeping the block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-policy-"))
    const file = join(dir, "policy.json")
    const lines: string[] = []
    const joinerId = generateIdentity()
    const seed = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      log: (line) => lines.push(line),
      logLevel: "info",
      policy: { access: "open", ...uncapped },
      policyFile: file,
    })
    const joiner = new Relay({ host: "127.0.0.1", identity: joinerId })
    try {
      const bound = await seed.start()
      await joiner.start()
      await joiner.join(bound)
      assert.equal((await readRelayTable(bound)).peers.length, 1)
      const blocked = spawnSync(process.execPath, [cliPath, "block", joinerId.id, "--policy-file", file], {
        encoding: "utf8",
      })
      assert.equal(blocked.status, 0, blocked.stderr)
      await sleep(1200)
      assert.equal((await readRelayTable(bound)).peers.length, 0)
      await assert.rejects(() => joiner.join(bound, 400), /did not join/)
      assert.equal(lines.some((line) => line.includes("reason=blocked")), true)
      const forgot = spawnSync(process.execPath, [cliPath, "unblock", joinerId.id, "--policy-file", file], {
        encoding: "utf8",
      })
      assert.equal(forgot.status, 0, forgot.stderr)
      const dropped = spawnSync(process.execPath, [cliPath, "forget", joinerId.id, "--policy-file", file], {
        encoding: "utf8",
      })
      assert.equal(dropped.status, 0, dropped.stderr)
      await sleep(1200)
      assert.equal((await readRelayTable(bound)).peers.length, 0)
      assert.equal(lines.some((line) => line.includes("reason=operator")), true)
      const saved = await readPolicy(file)
      assert.deepEqual(saved.blocked, [])
      assert.deepEqual(saved.forget, [])
      await joiner.join(bound)
      assert.equal((await readRelayTable(bound)).peers.some((peer) => peer.id === joinerId.id), true)
    } finally {
      await joiner.close()
      await seed.close()
    }
  })

  it("stops accepting new peers once the rate is full", async () => {
    const lines: string[] = []
    const seed = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      log: (line) => lines.push(line),
      logLevel: "info",
      policy: { access: "open", ...uncapped, peerRatePerMin: 1 },
    })
    const first = new Relay({ host: "127.0.0.1", identity: generateIdentity() })
    const second = new Relay({ host: "127.0.0.1", identity: generateIdentity() })
    try {
      const bound = await seed.start()
      await first.start()
      await second.start()
      await first.join(bound)
      await assert.rejects(() => second.join(bound, 400), /did not join/)
      assert.equal(lines.some((line) => line.includes("reason=rate")), true)
      assert.equal(seed.snapshot().relays, 2)
    } finally {
      await second.close()
      await first.close()
      await seed.close()
    }
  })

  it("drops a datagram that is over the bandwidth cap", async () => {
    const relay = new Relay({
      host: "127.0.0.1",
      policy: { access: "open", ...uncapped, bandwidthBps: 1 },
    })
    let forwarded = 0
    relay.onForward = () => {
      forwarded += 1
    }
    const socket = createUdpSocket()
    try {
      const bound = await relay.start()
      await bindUdp(socket, "127.0.0.1", 0)
      const inner = encodeData({
        kind: "data",
        sessionId: randomBytes(16),
        blockId: 1,
        tesseraIndex: 0,
        k: 1,
        n: 1,
        cipherLen: 1,
        payload: Buffer.from([1]),
      })
      await sendUdp(socket, encodeEnvelope({ host: "127.0.0.1", port: 9 }, inner), bound)
      await sleep(40)
      assert.equal(forwarded, 0)
      assert.equal(relay.stats.droppedLimited, 1)
    } finally {
      await closeUdp(socket)
      await relay.close()
    }
  })
})
