import { strict as assert } from "node:assert"
import { after, before, describe, it } from "node:test"
import { PROTOCOL_VERSION } from "../src/constants.js"
import { listenPublicApi, type PublicApi } from "../src/api/public.js"
import { SOFTWARE_VERSION } from "../src/identity/record.js"

describe("public api", () => {
  let api: PublicApi
  let base: string

  before(async () => {
    api = await listenPublicApi("127.0.0.1", 0)
    base = `http://${api.endpoint.host}:${api.endpoint.port}`
  })

  after(async () => {
    await api.close()
  })

  it("describes the control plane at the root", async () => {
    const response = await fetch(`${base}/`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/)
    const body = (await response.json()) as { name: string; software: string; wire: number; endpoints: Record<string, string>; docs: string }
    assert.equal(body.name, "tesera control plane")
    assert.equal(body.software, SOFTWARE_VERSION)
    assert.equal(body.wire, PROTOCOL_VERSION)
    assert.deepEqual(body.endpoints, { relays: "GET /v1/relays", rooms: "POST /v1/rooms" })
    assert.equal(body.docs, "https://tesera.net/docs#api")
  })

  it("serves no /v0 routes and none of the old /v1 names", async () => {
    for (const path of ["/v0/send", "/v0/receive", "/v0/record", "/v0/stats", "/v0/peers", "/v1/network/relays", "/v1/rendezvous", "/v1/send"]) {
      const response = await fetch(`${base}${path}`, { method: "POST", body: "x" })
      assert.equal(response.status, 404, path)
      assert.deepEqual(await response.json(), { error: "not_found" })
    }
  })

  it("leaves /v1/relays out without a discovery source", async () => {
    assert.equal((await fetch(`${base}/v1/relays`)).status, 404)
  })
})
