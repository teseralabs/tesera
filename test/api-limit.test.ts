import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { ApiLimiter, DEFAULT_API_LIMITS, clientAddress, trustedProxies } from "../src/api/limit.js"
import { listenPublicApi, type PublicApi } from "../src/api/public.js"

const offer = JSON.stringify({ v: 1, sessionId: "0123456789abcdef0123456789abcdef", sender: { host: "203.0.113.1", port: 4101 }, relays: [{ host: "203.0.113.9", port: 4101 }], k: 1, n: 1 })

describe("api limiter", () => {
  it("expires idle entries and refuses a new address when the map is full", () => {
    let now = 1_000_000
    const limiter = new ApiLimiter({ ...DEFAULT_API_LIMITS, maxEntries: 2, idleMs: 1_000, windowMs: 60_000 }, () => now)
    assert.equal(limiter.admitInfo("203.0.113.1").ok, true)
    assert.equal(limiter.admitInfo("203.0.113.2").ok, true)
    assert.equal(limiter.size, 2)
    const blocked = limiter.admitInfo("203.0.113.3")
    assert.equal(blocked.ok, false)
    if (!blocked.ok) assert.ok(blocked.retryAfterSec >= 1)
    now += 1_000
    assert.equal(limiter.size, 0)
    assert.equal(limiter.admitInfo("203.0.113.3").ok, true)
    assert.equal(limiter.size, 1)
  })

  it("counts room creation on its own budget", () => {
    const limiter = new ApiLimiter({ ...DEFAULT_API_LIMITS, roomCreates: 1 })
    assert.equal(limiter.admitCreate("203.0.113.8").ok, true)
    const again = limiter.admitCreate("203.0.113.8")
    assert.equal(again.ok, false)
    if (!again.ok) assert.ok(again.retryAfterSec >= 1)
    assert.equal(limiter.admitInfo("203.0.113.8").ok, true)
    assert.equal(limiter.admitCreate("203.0.113.9").ok, true)
  })

  it("uses the socket address unless that peer is a trusted proxy", () => {
    const trusted = new Set(["127.0.0.1"])
    assert.equal(clientAddress("127.0.0.1", "203.0.113.4", new Set()), "127.0.0.1")
    assert.equal(clientAddress("127.0.0.1", "8.8.8.8, 203.0.113.4", trusted), "203.0.113.4")
    assert.equal(clientAddress("::ffff:127.0.0.1", "203.0.113.4", trusted), "203.0.113.4")
    assert.equal(clientAddress("203.0.113.9", "198.51.100.1", trusted), "203.0.113.9")
    assert.equal(clientAddress("10.0.0.8", "203.0.113.4", trusted), "10.0.0.8")
    assert.throws(() => trustedProxies(["203.0.113.1"]), /loopback/)
    assert.deepEqual([...trustedProxies(["127.0.0.1"])], ["127.0.0.1"])
  })
})

describe("public api limits", () => {
  it("answers 429 with Retry-After once an address is over its request budget", async () => {
    const api = await listenPublicApi("127.0.0.1", 0, { limits: { infoRequests: 2 } })
    try {
      assert.equal((await fetch(url(api, "/"))).status, 200)
      assert.equal((await fetch(url(api, "/"))).status, 200)
      const over = await fetch(url(api, "/"))
      assert.equal(over.status, 429)
      assert.deepEqual(await over.json(), { error: "rate_limit" })
      assert.ok(Number(over.headers.get("retry-after")) >= 1)
      assert.equal(over.headers.get("cache-control"), "no-store")
    } finally {
      await api.close()
    }
  })

  it("charges each forwarded address separately behind a trusted proxy", async () => {
    const api = await listenPublicApi("127.0.0.1", 0, { limits: { roomCreates: 1 }, trustProxy: ["127.0.0.1"] })
    try {
      assert.equal((await openRoom(api, "203.0.113.10")).status, 201)
      assert.equal((await openRoom(api, "203.0.113.10")).status, 429)
      assert.equal((await openRoom(api, "203.0.113.11")).status, 201)
    } finally {
      await api.close()
    }
  })

  it("ignores a spoofed X-Forwarded-For when the peer is not a trusted proxy", async () => {
    const api = await listenPublicApi("127.0.0.1", 0, { limits: { roomCreates: 1 } })
    const direct = await listenPublicApi("127.0.0.1", 0, { limits: { roomCreates: 1 }, trustProxy: ["127.0.0.2"] })
    try {
      assert.equal((await openRoom(api, "203.0.113.20")).status, 201)
      assert.equal((await openRoom(api, "198.51.100.8")).status, 429)
      assert.equal((await openRoom(direct, "203.0.113.21")).status, 201)
      assert.equal((await openRoom(direct, "198.51.100.9")).status, 429)
      await assert.rejects(() => listenPublicApi("127.0.0.1", 0, { trustProxy: ["203.0.113.50"] }), /loopback/)
    } finally {
      await api.close()
      await direct.close()
    }
  })
})

function url(api: PublicApi, path: string): string {
  return `http://${api.endpoint.host}:${api.endpoint.port}${path}`
}

function openRoom(api: PublicApi, forwarded: string): Promise<Response> {
  return fetch(url(api, "/v1/rooms"), { method: "POST", headers: { "x-forwarded-for": forwarded }, body: offer })
}
