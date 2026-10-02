import { strict as assert } from "node:assert"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { generateIdentity } from "../src/identity/id.js"
import { writeAnalytics } from "../src/relay/analytics.js"
import { writePeers } from "../src/relay/peers-file.js"
import { writePolicy } from "../src/relay/policy.js"

describe("relay state files", () => {
  it("writes policy, peers, and metrics so only the owner can read them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-state-"))
    const id = generateIdentity()
    try {
      await writePolicy(join(dir, "policy.json"), { allowed: [id.id], blocked: [], forget: [] })
      await writePeers(join(dir, "peers.json"), [
        { id: id.id, host: "203.0.113.10", port: 4101, seenAt: 0, seq: 1, bytes: 0, transfers: 0 },
      ])
      await writeAnalytics(join(dir, "metrics.json"), { bytes: 1, transfers: 1 })
      for (const name of ["policy.json", "peers.json", "metrics.json"]) {
        assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
