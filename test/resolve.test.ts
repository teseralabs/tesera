import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { resolveEndpoint, resolveRelayRef } from "../src/carrier/resolve.js"
import { generateIdentity } from "../src/identity/id.js"

const found = async (host: string) => {
  assert.equal(host, "relay.tesera.net")
  return "203.0.113.10"
}

describe("domain names", () => {
  it("keeps an IPv4 address and does not look it up", async () => {
    const endpoint = await resolveEndpoint("127.0.0.1:4101", undefined, async () => {
      throw new Error("looked up an address")
    })
    assert.deepEqual(endpoint, { host: "127.0.0.1", port: 4101 })
  })

  it("uses port 4101 when a relay name has no port", async () => {
    assert.deepEqual(await resolveEndpoint("relay.tesera.net", 4101, found), {
      host: "203.0.113.10",
      port: 4101,
    })
    assert.deepEqual(await resolveEndpoint("relay.tesera.net:4102", undefined, found), {
      host: "203.0.113.10",
      port: 4102,
    })
    assert.deepEqual(await resolveEndpoint("localhost", 4101, found), { host: "127.0.0.1", port: 4101 })
  })

  it("resolves a pinned relay name", async () => {
    const identity = generateIdentity()
    const ref = await resolveRelayRef(`${identity.id}@relay.tesera.net`, found)
    assert.equal(ref.id, identity.id)
    assert.deepEqual(ref.endpoint, { host: "203.0.113.10", port: 4101 })
  })

  it("says when a name has no IPv4 address", async () => {
    const miss = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })
    await assert.rejects(
      () => resolveEndpoint("relay.tesera.net", 4101, async () => Promise.reject(miss)),
      /relay\.tesera\.net has no IPv4 address/,
    )
  })
})
