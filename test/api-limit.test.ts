import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import http from "node:http"
import { after, before, describe, it } from "node:test"
import { ApiLimiter, DEFAULT_API_LIMITS, clientAddress, trustedProxies } from "../src/api/limit.js"
import { listenPublicApi, type PublicApi } from "../src/api/public.js"
import type { LogFields } from "../src/log.js"
import { formatSession } from "../src/crypto/session.js"
import { generateIdentity } from "../src/identity/id.js"
import { Relay } from "../src/relay/relay.js"
import { sleep } from "../src/util.js"

describe("api limiter", () => {
  it("expires idle entries and refuses a new address when the map is full", () => {
    let now = 1_000_000
    const limiter = new ApiLimiter(
      { ...DEFAULT_API_LIMITS, maxEntries: 2, idleMs: 1_000, windowMs: 60_000, transferRequests: 10 },
      () => now,
    )
    assert.equal(limiter.admitTransfer("203.0.113.1").ok, true)
    assert.equal(limiter.admitTransfer("203.0.113.2").ok, true)
    limiter.hold("203.0.113.1")
    limiter.hold("203.0.113.2")
    now += 1_000
    assert.equal(limiter.size, 2)
    const blocked = limiter.admitTransfer("203.0.113.3")
    assert.equal(blocked.ok, false)
    if (!blocked.ok) assert.ok(blocked.retryAfterSec >= 1)
    limiter.release("203.0.113.1")
    limiter.release("203.0.113.2")
    now += 1_000
    assert.equal(limiter.size, 0)
    assert.equal(limiter.admitTransfer("203.0.113.3").ok, true)
    assert.equal(limiter.size, 1)
  })

  it("keeps a byte charge on the address when the session would differ", () => {
    const limiter = new ApiLimiter({ ...DEFAULT_API_LIMITS, transferBytes: 10, transferRequests: 10 })
    assert.equal(limiter.admitTransfer("203.0.113.8").ok, true)
    assert.equal(limiter.bytesFit("203.0.113.8", 8).ok, true)
    assert.equal(limiter.addBytes("203.0.113.8", 8).ok, true)
    const again = limiter.bytesFit("203.0.113.8", 8)
    assert.equal(again.ok, false)
    if (!again.ok) assert.ok(again.retryAfterSec >= 1)
    assert.equal(limiter.bytesFit("203.0.113.9", 8).ok, true)
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
  let relay: Relay
  let baseRelay: { host: string; port: number }

  before(async () => {
    relay = new Relay({ host: "127.0.0.1", port: 0, identity: generateIdentity() })
    baseRelay = await relay.start()
  })

  after(async () => {
    await relay.close()
  })

  it("limits transfer requests per address and leaves informational reads on their own budget", async () => {
    const api = await open(baseRelay, { transferRequests: 1, infoRequests: 2 })
    try {
      const first = await postSend(api)
      const second = await postSend(api)
      const info = await fetch(url(api, "/"))
      const infoAgain = await fetch(url(api, "/v0/record"))
      const infoOver = await fetch(url(api, "/"))
      assert.equal(first.status, 400)
      assert.equal(second.status, 429)
      assert.equal(((await second.json()) as { error: string }).error, "rate_limit")
      assert.ok(Number(second.headers.get("retry-after")) >= 1)
      assert.equal(second.headers.get("cache-control"), "no-store")
      assert.equal(info.status, 200)
      assert.equal(infoAgain.status, 200)
      assert.equal(infoOver.status, 429)
    } finally {
      await api.close()
    }
  })

  it("rejects a transfer whose declared size does not fit the byte allowance, before the body is uploaded", async () => {
    const api = await open(baseRelay, { transferBytes: 32 })
    try {
      const early = await rawRequest(api.endpoint.port, {
        method: "POST",
        path: "/v0/send",
        headers: {
          "content-length": "1000",
          "x-tesera-session": formatSession(randomBytes(32)),
        },
        chunk: Buffer.alloc(8),
      })
      assert.equal(early.status, 429)
      assert.equal(early.error, "rate_limit")
      assert.equal(early.ended, false)
      assert.ok(Number(early.retryAfter) >= 1)
    } finally {
      await api.close()
    }
  })

  it("rejects a streamed body over the payload maximum", async () => {
    const api = await open(baseRelay, {}, { maxBytes: 8 })
    try {
      const early = await rawRequest(api.endpoint.port, {
        method: "POST",
        path: "/v0/send",
        headers: { "x-tesera-session": formatSession(randomBytes(32)) },
        chunk: Buffer.alloc(64),
      })
      assert.equal(early.status, 413)
      assert.equal(early.error, "size")
      assert.equal(early.ended, false)
    } finally {
      await api.close()
    }
  })

  it("rejects a declared content-length over the payload maximum before the body is uploaded", async () => {
    const api = await open(baseRelay, {}, { maxBytes: 8 })
    try {
      const early = await rawRequest(api.endpoint.port, {
        method: "POST",
        path: "/v0/send",
        headers: {
          "content-length": "100000",
          "x-tesera-session": formatSession(randomBytes(32)),
        },
        chunk: Buffer.alloc(4),
      })
      assert.equal(early.status, 413)
      assert.equal(early.error, "size")
      assert.equal(early.ended, false)
    } finally {
      await api.close()
    }
  })

  it("limits concurrent transfer requests per address and still reports global capacity as busy", async () => {
    const perIp = await open(baseRelay, { activePerIp: 1 })
    const global = await open(baseRelay, { activePerIp: 8 }, { maxPairs: 1 })
    try {
      const headers = waitingHeaders(baseRelay)
      const hold = fetch(url(perIp, "/v0/receive"), { method: "POST", headers })
      await sleep(80)
      const blocked = await fetch(url(perIp, "/v0/receive"), { method: "POST", headers: waitingHeaders(baseRelay) })
      assert.equal(blocked.status, 429)
      assert.equal(((await blocked.json()) as { error: string }).error, "rate_limit")
      hold.catch(() => {})

      const first = fetch(url(global, "/v0/receive"), { method: "POST", headers: waitingHeaders(baseRelay) })
      await sleep(80)
      const second = await fetch(url(global, "/v0/receive"), { method: "POST", headers: waitingHeaders(baseRelay) })
      assert.equal(second.status, 503)
      assert.equal(((await second.json()) as { error: string }).error, "busy")
      first.catch(() => {})
    } finally {
      await perIp.close()
      await global.close()
    }
  })

  it("does not let one address or a new session secret spend another address's allowance", async () => {
    const api = await open(baseRelay, { transferRequests: 1 }, { trustProxy: ["127.0.0.1"] })
    try {
      const first = await postSend(api, "203.0.113.10", formatSession(randomBytes(32)))
      const sameAddress = await postSend(api, "203.0.113.10", formatSession(randomBytes(32)))
      const otherAddress = await postSend(api, "203.0.113.11", formatSession(randomBytes(32)))
      assert.equal(first.status, 400)
      assert.equal(sameAddress.status, 429)
      assert.equal(otherAddress.status, 400)
    } finally {
      await api.close()
    }
  })

  it("ignores a spoofed X-Forwarded-For when the peer is not a trusted proxy", async () => {
    const api = await open(baseRelay, { transferRequests: 1 })
    const direct = await open(baseRelay, { transferRequests: 1 }, { trustProxy: ["127.0.0.2"] })
    try {
      const first = await postSend(api, "203.0.113.20")
      const spoofed = await postSend(api, "198.51.100.8")
      assert.equal(first.status, 400)
      assert.equal(spoofed.status, 429)
      const otherProxy = await postSend(direct, "203.0.113.21")
      const stillDirect = await postSend(direct, "198.51.100.9")
      assert.equal(otherProxy.status, 400)
      assert.equal(stillDirect.status, 429)
      await assert.rejects(
        () => open(baseRelay, {}, { trustProxy: ["203.0.113.50"] }),
        /loopback/,
      )
    } finally {
      await api.close()
      await direct.close()
    }
  })

  it("counts a receive response against the transfer byte allowance", async () => {
    const api = await open(baseRelay, { transferBytes: 30, transferRequests: 10 })
    try {
      const session = formatSession(randomBytes(32))
      const payload = Buffer.alloc(20)
      const headers = {
        "x-tesera-session": session,
        "x-tesera-relays": `${baseRelay.host}:${baseRelay.port}`,
        "x-tesera-deadline-ms": "8000",
        "x-tesera-k": "1",
        "x-tesera-n": "1",
      }
      const [received, sent] = await Promise.all([
        fetch(url(api, "/v0/receive"), { method: "POST", headers }),
        fetch(url(api, "/v0/send"), { method: "POST", headers, body: payload }),
      ])
      assert.equal(sent.status, 200)
      assert.equal(received.status, 429)
      assert.equal(((await received.json()) as { error: string }).error, "rate_limit")
    } finally {
      await api.close()
    }
  })

  it("does not log the session secret", async () => {
    const lines: string[] = []
    const secret = formatSession(randomBytes(32))
    const api = await open(baseRelay, {}, {
      log: (_event, fields) => {
        lines.push(JSON.stringify(fields))
      },
    })
    try {
      const response = await fetch(url(api, "/v0/send"), {
        method: "POST",
        headers: { "x-tesera-session": secret },
        body: Buffer.alloc(0),
      })
      assert.equal(response.status, 400)
      const text = lines.join("\n")
      assert.equal(text.includes(secret), false)
      assert.equal(text.includes("session:"), false)
    } finally {
      await api.close()
    }
  })
})

function open(
  discover: { host: string; port: number },
  limits: Partial<typeof DEFAULT_API_LIMITS>,
  extra: {
    maxBytes?: number
    maxPairs?: number
    trustProxy?: string[]
    log?: (event: string, fields: LogFields) => void
  } = {},
): Promise<PublicApi> {
  return listenPublicApi("127.0.0.1", 0, {
    discover,
    advertise: "127.0.0.1",
    limits,
    maxBytes: extra.maxBytes,
    maxPairs: extra.maxPairs,
    trustProxy: extra.trustProxy,
    log: extra.log,
  })
}

function url(api: PublicApi, path: string): string {
  return `http://${api.endpoint.host}:${api.endpoint.port}${path}`
}

function postSend(api: PublicApi, forwarded?: string, session = formatSession(randomBytes(32))): Promise<Response> {
  const headers: Record<string, string> = { "x-tesera-session": session }
  if (forwarded) headers["x-forwarded-for"] = forwarded
  return fetch(url(api, "/v0/send"), { method: "POST", headers })
}

function waitingHeaders(relay: { host: string; port: number }): Record<string, string> {
  return {
    "x-tesera-session": formatSession(randomBytes(32)),
    "x-tesera-relays": `${relay.host}:${relay.port}`,
    "x-tesera-deadline-ms": "8000",
  }
}

function rawRequest(
  port: number,
  opts: { method: string; path: string; headers: Record<string, string>; chunk: Buffer },
): Promise<{ status: number; error: string; retryAfter: string | undefined; ended: boolean }> {
  return new Promise((resolve, reject) => {
    let ended = false
    const req = http.request(
      { host: "127.0.0.1", port, method: opts.method, path: opts.path, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => {
          let error = ""
          try {
            error = (JSON.parse(Buffer.concat(chunks).toString()) as { error?: string }).error ?? ""
          } catch {
            error = ""
          }
          resolve({
            status: res.statusCode ?? 0,
            error,
            retryAfter: typeof res.headers["retry-after"] === "string" ? res.headers["retry-after"] : undefined,
            ended,
          })
        })
      },
    )
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ECONNRESET") return
      reject(err)
    })
    req.write(opts.chunk)
    const timer = setTimeout(() => {
      ended = true
      req.end()
    }, 1500)
    req.on("response", () => clearTimeout(timer))
    req.on("close", () => {
      if (!ended) clearTimeout(timer)
    })
  })
}
