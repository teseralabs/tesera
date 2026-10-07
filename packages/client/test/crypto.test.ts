import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { checkRejections, checkVectors, clientLib, produceCases, verifyCases, type CryptoLib, type VectorFile } from "./crypto-checks.js"
import { native, rootDir } from "./native.js"

const random = (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length))
const vectors = JSON.parse(readFileSync(new URL("test/vectors/v2.json", rootDir), "utf8")) as VectorFile

async function nativeLib(): Promise<CryptoLib> {
  return {
    session: await native("crypto/session.js"),
    frames: await native("protocol/frames.js"),
    primitives: await native("crypto/primitives.js"),
  } as unknown as CryptoLib
}

describe("client crypto", () => {
  it("matches tesera's v2 vectors", () => {
    assert.deepEqual(checkVectors(clientLib, vectors), [])
  })

  it("decrypts what native tesera encrypts", async () => {
    assert.deepEqual(verifyCases(clientLib, produceCases(await nativeLib(), 40, random)), [])
  })

  it("encrypts what native tesera decrypts", async () => {
    assert.deepEqual(verifyCases(await nativeLib(), produceCases(clientLib, 40, random)), [])
  })

  it("rejects tampered ciphertext, associated data, and control macs", () => {
    for (const c of produceCases(clientLib, 6, random).slice(1)) assert.deepEqual(checkRejections(clientLib, c), [])
  })
})
