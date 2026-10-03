import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { createSocket } from "node:dgram"
import { describe, it } from "node:test"
import { listenPublicApi, type PublicApiOptions } from "../src/api/public.js"
import { PortPool, parsePortRange, startOnPort } from "../src/carrier/ports.js"
import type { Endpoint } from "../src/carrier/udp.js"
import { formatSession } from "../src/crypto/session.js"
import { generateIdentity } from "../src/identity/id.js"
import { JOINED_PICK, preferJoined } from "../src/identity/peers.js"
import type { LogFields } from "../src/log.js"
import { Relay } from "../src/relay/relay.js"
import type { Adversity } from "../src/sim/network.js"
import { TeseraReceiver } from "../src/transport/receiver.js"

describe("port ranges", () => {
  it("parses a range and rejects a bad one", () => {
    assert.deepEqual(parsePortRange("4400-4463"), { low: 4400, high: 4463 })
    assert.deepEqual(parsePortRange("4500-4500"), { low: 4500, high: 4500 })
    for (const bad of ["4400", "4463-4400", "0-10", "1-65536", "a-b", "4400-4463-1"]) {
      assert.throws(() => parsePortRange(bad), /port range/)
    }
  })

  it("hands out each port once until it is released", () => {
    const pool = new PortPool({ low: 5000, high: 5001 })
    assert.equal(pool.take(), 5000)
    assert.equal(pool.take(), 5001)
    assert.equal(pool.take(), null)
    pool.release(5000)
    assert.equal(pool.take(), 5000)
  })

  it("skips a port another socket holds and returns null when the range is used up", async () => {
    const low = await freePorts(2)
    const high = low + 1
    const holder = createSocket("udp4")
    await new Promise<void>((resolve) => holder.bind(low, "127.0.0.1", resolve))
    const pool = new PortPool({ low, high })
    const make = (port: number) => new TeseraReceiver({ session: randomBytes(32), relays: [{ host: "127.0.0.1", port: 9 }], bindHost: "127.0.0.1", bindPort: port })
    try {
      const started = await startOnPort(pool, make)
      assert.ok(started)
      assert.equal(started.port, high)
      assert.equal(started.item.endpoint.port, high)
      assert.equal(await startOnPort(pool, make), null)
      await started.item.close()
    } finally {
      holder.close()
    }
  })
})

describe("joined relay choice", () => {
  const seed = { host: "127.0.0.1", port: 4101 }
  const at = (host: string, port: number): Endpoint => ({ host, port })

  it("keeps the seed alone when fewer than 2 relays joined", () => {
    assert.deepEqual(preferJoined([seed]), { relays: [seed], fallback: null })
    assert.deepEqual(preferJoined([seed, at("10.0.0.1", 4101)]), { relays: [seed], fallback: null })
  })

  it("uses joined relays and keeps the seed for a retry", () => {
    const joined = [at("10.0.0.1", 4101), at("10.0.0.2", 4101)]
    const plan = preferJoined([seed, ...joined])
    assert.deepEqual(plan.fallback, [seed])
    assert.deepEqual([...plan.relays].sort(byHost), joined)
  })

  it("picks different hosts first and stops at the limit", () => {
    const shared = [at("10.0.0.1", 4101), at("10.0.0.1", 4102), at("10.0.0.1", 4103)]
    const other = [at("10.0.0.2", 4101), at("10.0.0.3", 4101)]
    for (let run = 0; run < 20; run++) {
      const plan = preferJoined([seed, ...shared, ...other])
      assert.equal(plan.relays.length, JOINED_PICK)
      assert.equal(new Set(plan.relays.map((relay) => relay.host)).size, 3)
      assert.ok(!plan.relays.includes(seed))
    }
    const sameHost = preferJoined([seed, ...shared])
    assert.equal(sameHost.relays.length, 3)
  })
})

describe("public api on joined relays", { timeout: 60_000 }, () => {
  it("carries a default call on joined relays and leaves the seed out", async () => {
    await withNetwork(2, {}, async ({ call, seed, joined }) => {
      const payload = randomBytes(64 * 1024)
      const { sent, received } = await call(payload, 8_000)
      assert.equal(sent.relays, 2)
      assert.deepEqual(received, payload)
      assert.equal(seed.report().data, 0)
      for (const relay of joined) assert.ok(relay.report().data > 0)
    })
  })

  it("uses the seed when only 1 relay joined", async () => {
    await withNetwork(1, {}, async ({ call, seed, joined }) => {
      const payload = Buffer.from("seed only")
      const { sent, received } = await call(payload, 8_000)
      assert.equal(sent.relays, 1)
      assert.deepEqual(received, payload)
      assert.ok(seed.report().data > 0)
      assert.equal(joined[0]?.report().data, 0)
    })
  })

  it("retries on the seed when the joined relays drop everything", async () => {
    await withNetwork(2, { joined: { blackhole: true } }, async ({ call, seed, events }) => {
      const payload = Buffer.from("through the seed after a retry")
      const { sent, received } = await call(payload, 6_000)
      assert.equal(sent.relays, 1)
      assert.deepEqual(received, payload)
      assert.ok(seed.report().data > 0)
      const retries = events.filter((event) => event.event === "retry")
      assert.equal(retries.length, 1)
      assert.deepEqual(retries[0]?.fields, { relays: 2, reason: "timeout" })
    })
  })

  it("moves bytes with both sockets in a 2 port range, twice in a row", async () => {
    const low = await freePorts(2)
    const high = low + 1
    await withNetwork(2, { api: { ports: { low, high } } }, async ({ call }) => {
      for (const text of ["first", "second"]) {
        const payload = Buffer.from(text)
        const { received } = await call(payload, 8_000)
        assert.deepEqual(received, payload)
      }
    })
  })

  it("answers busy when the port range has no room for both sockets", async () => {
    const port = await freePorts(1)
    await withNetwork(2, { api: { ports: { low: port, high: port } } }, async ({ base }) => {
      const headers = { "x-tesera-session": formatSession(randomBytes(32)), "x-tesera-deadline-ms": "4000" }
      const [received, sent] = await Promise.all([
        fetch(`${base}/v0/receive`, { method: "POST", headers }),
        fetch(`${base}/v0/send`, { method: "POST", headers, body: Buffer.from("x") }),
      ])
      assert.equal(sent.status, 503)
      assert.equal(received.status, 503)
      assert.equal(((await sent.json()) as { error: string }).error, "busy")
    })
  })
})

type Network = {
  base: string
  seed: Relay
  joined: Relay[]
  events: { event: string; fields: LogFields }[]
  call: (payload: Buffer, deadlineMs: number) => Promise<{ sent: { relays: number }; received: Buffer }>
}

async function withNetwork(
  joinedCount: number,
  opts: { joined?: Partial<Adversity>; api?: Partial<PublicApiOptions> },
  body: (net: Network) => Promise<void>,
): Promise<void> {
  const seed = new Relay({ host: "127.0.0.1", port: 0, identity: generateIdentity() })
  const joined = Array.from(
    { length: joinedCount },
    () => new Relay({ host: "127.0.0.1", port: 0, identity: generateIdentity(), adversity: opts.joined }),
  )
  const events: Network["events"] = []
  const seedEndpoint = await seed.start()
  for (const relay of joined) {
    await relay.start()
    await relay.join(seedEndpoint)
  }
  const api = await listenPublicApi("127.0.0.1", 0, {
    discover: seedEndpoint,
    advertise: "127.0.0.1",
    preferJoined: true,
    log: (event, fields) => events.push({ event, fields }),
    ...opts.api,
  })
  const base = `http://${api.endpoint.host}:${api.endpoint.port}`
  const call: Network["call"] = async (payload, deadlineMs) => {
    const headers = { "x-tesera-session": formatSession(randomBytes(32)), "x-tesera-deadline-ms": String(deadlineMs) }
    const [receive, send] = await Promise.all([
      fetch(`${base}/v0/receive`, { method: "POST", headers }),
      fetch(`${base}/v0/send`, { method: "POST", headers, body: payload }),
    ])
    assert.equal(send.status, 200)
    assert.equal(receive.status, 200)
    return { sent: (await send.json()) as { relays: number }, received: Buffer.from(await receive.arrayBuffer()) }
  }
  try {
    await body({ base, seed, joined, events, call })
  } finally {
    await api.close()
    for (const relay of joined) await relay.close()
    await seed.close()
  }
}

/** First port of a run of consecutive UDP ports that nothing on 127.0.0.1 holds right now. */
async function freePorts(count: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const low = 20_000 + Math.floor(Math.random() * 30_000)
    if (await allFree(Array.from({ length: count }, (_, i) => low + i))) return low
  }
  throw new Error("no free port run")
}

async function allFree(ports: number[]): Promise<boolean> {
  const sockets = ports.map(() => createSocket("udp4"))
  try {
    await Promise.all(
      sockets.map(
        (socket, i) =>
          new Promise<void>((resolve, reject) => {
            socket.once("error", reject)
            socket.bind(ports[i], "127.0.0.1", resolve)
          }),
      ),
    )
    return true
  } catch {
    return false
  } finally {
    for (const socket of sockets) {
      try {
        socket.close()
      } catch {
        // Never bound.
      }
    }
  }
}

function byHost(a: Endpoint, b: Endpoint): number {
  return a.host.localeCompare(b.host)
}
