import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { bindUdp, closeUdp, createUdpSocket, type Endpoint } from "../src/carrier/udp.js"
import { splitRelayRef } from "../src/carrier/resolve.js"
import { generateIdentity, type Identity } from "../src/identity/id.js"
import { discoverRelays, readRelayTable } from "../src/identity/peers.js"
import { PinnedSeedError, Relay } from "../src/relay/relay.js"
import { sleep } from "../src/util.js"

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url))
const uncapped = { bandwidthBps: 0, maxSessions: 0, peerRatePerMin: 0, datagramRatePerSec: 0 }

async function reservePort(): Promise<number> {
  const socket = createUdpSocket()
  const bound = await bindUdp(socket, "127.0.0.1", 0)
  await closeUdp(socket)
  return bound.port
}

async function listed(seed: Endpoint, id: string, timeoutMs: number): Promise<void> {
  const started = Date.now()
  for (;;) {
    const table = await readRelayTable(seed, { timeoutMs: 100, attempts: 1 }).catch(() => null)
    if (table?.peers.some((peer) => peer.id === id)) return
    if (Date.now() - started > timeoutMs) throw new Error(`${id} was not listed`)
    await sleep(50)
  }
}

function target(seed: Endpoint, id: string | null = null) {
  return { label: `${seed.host}:${seed.port}`, id, resolve: async () => seed }
}

function seedRelay(identity: Identity, port: number, extra: Record<string, unknown> = {}): Relay {
  return new Relay({ host: "127.0.0.1", port, identity, ...extra })
}

describe("join and rejoin", () => {
  it("reads a pinned relay reference without a lookup", () => {
    const id = generateIdentity().id
    assert.deepEqual(splitRelayRef(`${id}@relay.tesera.net`), { id, host: "relay.tesera.net", port: 4101 })
    assert.deepEqual(splitRelayRef("relay.tesera.net:4102"), { id: null, host: "relay.tesera.net", port: 4102 })
    assert.throws(() => splitRelayRef("relay:nope@relay.tesera.net"))
  })

  it("retries a startup join and gives up when the window ends", async () => {
    const lines: string[] = []
    const relay = new Relay({ host: "127.0.0.1", identity: generateIdentity(), log: (line) => lines.push(line) })
    const missing = { host: "127.0.0.1", port: await reservePort() }
    try {
      await relay.start()
      const started = Date.now()
      await assert.rejects(
        () => relay.stayJoined(target(missing), { startupMs: 1000, attemptMs: 100, firstRetryMs: 100 }),
        /^Error: relay did not join 127\.0\.0\.1:\d+ within 1s: the seed did not answer$/,
      )
      assert.ok(Date.now() - started < 2000)
      const failures = lines.filter((line) => line.includes("event=error reason=join"))
      assert.ok(failures.length >= 3, lines.join("\n"))
      assert.match(failures[0] ?? "", /addr=127\.0\.0\.1:\d+ attempt=1$/)
    } finally {
      await relay.close()
    }
  })

  it("joins a seed that comes up during the startup window", async () => {
    const port = await reservePort()
    const seedId = generateIdentity()
    const relayId = generateIdentity()
    const lines: string[] = []
    const relay = new Relay({ host: "127.0.0.1", identity: relayId, log: (line) => lines.push(line) })
    const seed = seedRelay(seedId, port)
    try {
      await relay.start()
      const joining = relay.stayJoined(target({ host: "127.0.0.1", port }, seedId.id), {
        startupMs: 5000,
        attemptMs: 100,
        firstRetryMs: 100,
      })
      await sleep(300)
      await seed.start()
      await joining
      assert.ok(lines.some((line) => line.includes(`event=joined addr=127.0.0.1:${port} seed=${seedId.id}`)))
    } finally {
      await relay.close()
      await seed.close()
    }
  })

  it("refuses a pinned seed with another id without retrying", async () => {
    const seed = seedRelay(generateIdentity(), 0)
    const relay = new Relay({ host: "127.0.0.1", identity: generateIdentity() })
    try {
      const bound = await seed.start()
      await relay.start()
      const other = generateIdentity().id
      const started = Date.now()
      await assert.rejects(
        () => relay.stayJoined(target(bound, other), { startupMs: 10_000, attemptMs: 300 }),
        (err: unknown) => err instanceof PinnedSeedError && err.message.includes(`not the pinned ${other}`),
      )
      assert.ok(Date.now() - started < 1000)
    } finally {
      await relay.close()
      await seed.close()
    }
  })

  it("rejoins after the seed restarts without remembering it", async () => {
    const seedId = generateIdentity()
    const relayId = generateIdentity()
    const lines: string[] = []
    let seed = seedRelay(seedId, 0)
    const relay = new Relay({ host: "127.0.0.1", identity: relayId, log: (line) => lines.push(line) })
    try {
      const bound = await seed.start()
      await relay.start()
      await relay.stayJoined(target(bound, seedId.id), { checkMs: 150, maxCheckMs: 300, attemptMs: 200 })
      await listed(bound, relayId.id, 1000)
      await seed.close()
      await sleep(400)
      seed = seedRelay(seedId, bound.port)
      await seed.start()
      await listed(bound, relayId.id, 3000)
      assert.ok(lines.some((line) => /event=rejoin addr=\S+ reason=(missing|unreachable)$/.test(line)), lines.join("\n"))
      assert.ok(lines.filter((line) => line.includes("event=joined")).length >= 2)
    } finally {
      await relay.close()
      await seed.close()
    }
  })

  it("rejoins after the seed forgets it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-rejoin-"))
    const policyFile = join(dir, "policy.json")
    const relayId = generateIdentity()
    const lines: string[] = []
    const seed = new Relay({
      host: "127.0.0.1",
      identity: generateIdentity(),
      policy: { access: "open", ...uncapped },
      policyFile,
    })
    const relay = new Relay({ host: "127.0.0.1", identity: relayId, log: (line) => lines.push(line) })
    try {
      const bound = await seed.start()
      await relay.start()
      await relay.stayJoined(target(bound), { checkMs: 200, attemptMs: 200 })
      const forgot = spawnSync(process.execPath, [cliPath, "forget", relayId.id, "--policy-file", policyFile], {
        encoding: "utf8",
      })
      assert.equal(forgot.status, 0, forgot.stderr)
      const started = Date.now()
      while (!lines.some((line) => line.includes("event=rejoin") && line.includes("reason=missing"))) {
        if (Date.now() - started > 4000) throw new Error(lines.join("\n"))
        await sleep(50)
      }
      await listed(bound, relayId.id, 2000)
    } finally {
      await relay.close()
      await seed.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("discovers through a pinned seed and refuses one with another id", async () => {
    const seedId = generateIdentity()
    const seed = seedRelay(seedId, 0)
    try {
      const bound = await seed.start()
      const found = await discoverRelays(bound, { pinned: seedId.id })
      assert.equal(found[0]?.id, seedId.id)
      const other = generateIdentity().id
      await assert.rejects(() => discoverRelays(bound, { pinned: other }), new RegExp(`not the pinned ${other}`))
    } finally {
      await seed.close()
    }
  })

  it("joins from the CLI with a pinned and an unpinned seed, and exits 1 on a mismatch", async () => {
    const seedId = generateIdentity()
    const seed = seedRelay(seedId, 0, { allowRemote: false })
    const procs: ReturnType<typeof spawn>[] = []
    const run = (joinValue: string) => {
      const child = spawn(
        process.execPath,
        [cliPath, "relay", "--listen", "127.0.0.1:0", "--identity", generateIdentity().secret.toString("hex"), "--join", joinValue],
        { stdio: ["ignore", "pipe", "pipe"] },
      )
      procs.push(child)
      let out = ""
      let err = ""
      child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()))
      child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()))
      return { child, out: () => out, err: () => err }
    }
    try {
      const bound = await seed.start()
      const addr = `127.0.0.1:${bound.port}`
      for (const value of [addr, `${seedId.id}@${addr}`]) {
        const proc = run(value)
        const started = Date.now()
        while (!proc.out().includes("event=joined")) {
          if (proc.child.exitCode !== null || Date.now() - started > 5000) throw new Error(`${proc.out()}\n${proc.err()}`)
          await sleep(20)
        }
        assert.match(proc.out(), new RegExp(`role=relay event=joined addr=${addr.replace(/\./g, "\\.")} seed=${seedId.id}`))
        proc.child.kill("SIGTERM")
      }
      const wrong = run(`${generateIdentity().id}@${addr}`)
      const code = await new Promise<number | null>((resolve) => wrong.child.once("exit", resolve))
      assert.equal(code, 1)
      assert.match(wrong.err(), /is relay:[a-z2-7]+, not the pinned relay:/)
      assert.doesNotMatch(wrong.out(), /event=joined/)
    } finally {
      for (const child of procs) if (child.exitCode === null) child.kill("SIGKILL")
      await seed.close()
    }
  })

  it("refuses a remote --join without --allow-remote", () => {
    const result = spawnSync(
      process.execPath,
      [cliPath, "relay", "--listen", "127.0.0.1:0", "--identity", generateIdentity().secret.toString("hex"), "--join", "192.0.2.1"],
      { encoding: "utf8", timeout: 5000 },
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /--join needs --allow-remote/)
  })
})
