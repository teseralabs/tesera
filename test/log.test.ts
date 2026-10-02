import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { allowsLog, formatLog } from "../src/log.js"

describe("log lines", () => {
  it("prints time, role, event, then fields in order", () => {
    const line = formatLog("relay", "block-in", { block: 3, from: "127.0.0.1:1", to: "127.0.0.1:2" }, new Date(2026, 8, 28, 19, 41, 1, 123))
    assert.equal(line, "19:41:01.123 role=relay event=block-in block=3 from=127.0.0.1:1 to=127.0.0.1:2")
  })

  it("rejects a value that would split the line", () => {
    assert.throws(() => formatLog("sender", "done", { note: "has space" }))
  })

  it("keeps info lines at the default level and block lines at debug", () => {
    assert.equal(allowsLog("info", "info"), true)
    assert.equal(allowsLog("info", "debug"), false)
    assert.equal(allowsLog("error", "info"), false)
    assert.equal(allowsLog("debug", "debug"), true)
  })
})
