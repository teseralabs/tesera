import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { codedPaths, type NetworkDirectory, type NetworkRelay } from "../src/index.js"

const at = (port: number) => ({ host: "127.0.0.1", port })
const entry = { url: "https://127.0.0.1:4433", attach: 1, certificateHashes: [] }

function relay(name: string, port: number | null, browser = false): NetworkRelay {
  return { id: `relay:${name}`, udp: port === null ? null : at(port), webTransport: browser ? entry : null }
}

const directory = (...relays: NetworkRelay[]): NetworkDirectory => ({ expiresAt: 0, relays })

describe("codedPaths", () => {
  it("leaves the attachment relay out when 3 other UDP relays are listed", () => {
    const listed = directory(relay("a", 1, true), relay("b", 2), relay("c", 3), relay("d", 4))
    assert.deepEqual(codedPaths(listed, 3), [at(2), at(3), at(4)])
  })

  it("uses the attachment relay as a path when only 3 UDP relays are listed", () => {
    const listed = directory(relay("a", 1, true), relay("b", 2), relay("c", 3))
    assert.deepEqual(codedPaths(listed, 3), [at(2), at(3), at(1)])
  })

  it("prefers neither of 2 entries while others are listed, then takes them in listed order", () => {
    assert.deepEqual(codedPaths(directory(relay("a", 1, true), relay("e", 5, true), relay("b", 2), relay("c", 3), relay("d", 4)), 3), [at(2), at(3), at(4)])
    assert.deepEqual(codedPaths(directory(relay("a", 1, true), relay("e", 5, true), relay("b", 2)), 3), [at(2), at(1), at(5)])
  })

  it("skips an entry that has no UDP address", () => {
    assert.deepEqual(codedPaths(directory(relay("a", null, true), relay("b", 2), relay("c", 3), relay("d", 4)), 3), [at(2), at(3), at(4)])
    assert.deepEqual(codedPaths(directory(relay("a", null, true), relay("b", 2)), 3), [at(2)])
  })

  it("keeps listed order among relays of the same kind, whatever their ids", () => {
    const listed = directory(relay("z", 9), relay("a", 1, true), relay("m", 5), relay("b", 2))
    assert.deepEqual(codedPaths(listed, 3), [at(9), at(5), at(2)])
    assert.deepEqual(codedPaths(listed, 3), codedPaths(structuredClone(listed), 3))
  })
})
