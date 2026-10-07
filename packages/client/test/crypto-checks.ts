// Crypto compatibility checks, run against two builds of tesera's session code: native, with
// node:crypto, and the client's, with @noble. The same file runs under Node and in Chrome.
import { blockAad, deriveKeys, mac16, macMatches, open, seal, sealedLength } from "../../../src/crypto/session.js"
import { decodeFrame, encodeAck } from "../../../src/protocol/frames.js"
import * as clientPrimitives from "../src/runtime/primitives.js"

type Bytes = Uint8Array & { toString(encoding?: string): string; equals(other: Uint8Array): boolean; readUInt32BE(at: number): number }

/** One build of tesera's session, frame, and primitive functions. */
export type CryptoLib = {
  session: {
    blockAad: (ctx: { sessionId: Uint8Array; blockId: number; k: number; n: number; cipherLen: number; shardLen: number }) => Bytes
    deriveKeys: (secret: Uint8Array, sessionId: Uint8Array) => { aeadKey: Bytes; macKey: Bytes }
    mac16: (key: Uint8Array, data: Uint8Array) => Bytes
    macMatches: (key: Uint8Array, data: Uint8Array, mac: Uint8Array) => boolean
    open: (key: Uint8Array, blockId: number, sealed: Uint8Array, aad: Uint8Array) => { fin: boolean; body: Bytes; sentAtMs: number }
    seal: (key: Uint8Array, blockId: number, fin: boolean, body: Uint8Array, sentAtMs: number, aad: Uint8Array) => Bytes
    sealedLength: (length: number) => number
  }
  frames: {
    decodeFrame: (bytes: Uint8Array, macKey: Uint8Array | null) => { kind: string; blockId?: number } | null
    encodeAck: (frame: { kind: "ack"; sessionId: Uint8Array; blockId: number }, macKey: Uint8Array) => Bytes
  }
  primitives: {
    hkdfSha256: (secret: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) => Bytes
    hmacSha256: (key: Uint8Array, data: Uint8Array) => Bytes
  }
}

/** The client's build: these imports compile against the @noble primitives in the bundle. */
export const clientLib = {
  session: { blockAad, deriveKeys, mac16, macMatches, open, seal, sealedLength },
  frames: { decodeFrame, encodeAck },
  primitives: clientPrimitives,
} as unknown as CryptoLib

export type Case = Record<string, unknown> & {
  secret: string
  sessionId: string
  blockId: number
  k: number
  n: number
  fin: boolean
  sentAtMs: number
  body: string
  aeadKey: string
  macKey: string
  ciphertext: string
  ack: string
  hkdf: { ikm: string; salt: string; info: string; length: number; okm: string }
  hmac: { key: string; data: string; mac: string }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
const unhex = (text: string) => {
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Fixed inputs and this build's outputs, so another build can check them byte for byte. */
export function produceCases(lib: CryptoLib, count: number, random: (length: number) => Uint8Array): Case[] {
  const { session, frames, primitives } = lib
  const cases: Case[] = []
  for (let i = 0; i < count; i++) {
    const secret = random(32)
    const sessionId = random(16)
    const seed = random(4)
    const blockId = (((seed[0] ?? 0) << 16) | ((seed[1] ?? 0) << 8) | (seed[2] ?? 0)) % 1_000_000
    const k = 1 + (i % 3)
    const n = k + 1
    const fin = i % 2 === 1
    const sentAtMs = 1_700_000_000_000 + i
    const body = random(i === 0 ? 0 : 1 + ((i * 397) % 2000))
    const keys = session.deriveKeys(secret, sessionId)
    const cipherLen = session.sealedLength(body.length)
    const aad = session.blockAad({ sessionId, blockId, k, n, cipherLen, shardLen: Math.ceil(cipherLen / k) })
    const info = random(1 + (i % 40))
    const okmLength = 16 + (i % 3) * 16
    cases.push({
      secret: hex(secret),
      sessionId: hex(sessionId),
      blockId,
      k,
      n,
      fin,
      sentAtMs,
      body: hex(body),
      aeadKey: hex(keys.aeadKey),
      macKey: hex(keys.macKey),
      ciphertext: hex(session.seal(keys.aeadKey, blockId, fin, body, sentAtMs, aad)),
      ack: hex(frames.encodeAck({ kind: "ack", sessionId, blockId }, keys.macKey)),
      hkdf: { ikm: hex(secret), salt: hex(sessionId), info: hex(info), length: okmLength, okm: hex(primitives.hkdfSha256(secret, sessionId, info, okmLength)) },
      hmac: { key: hex(keys.macKey), data: hex(body), mac: hex(primitives.hmacSha256(keys.macKey, body)) },
    })
  }
  return cases
}

/** Checks another build's cases with this one. Returns failures, empty when every byte matches. */
export function verifyCases(lib: CryptoLib, cases: Case[]): string[] {
  const { session, frames, primitives } = lib
  const failures: string[] = []
  cases.forEach((c, i) => {
    const fail = (what: string) => failures.push(`case ${i}: ${what}`)
    try {
      const secret = unhex(c.secret)
      const sessionId = unhex(c.sessionId)
      const body = unhex(c.body)
      const keys = session.deriveKeys(secret, sessionId)
      if (hex(keys.aeadKey) !== c.aeadKey) fail("aead key differs")
      if (hex(keys.macKey) !== c.macKey) fail("mac key differs")
      const cipherLen = session.sealedLength(body.length)
      const aad = session.blockAad({ sessionId, blockId: c.blockId, k: c.k, n: c.n, cipherLen, shardLen: Math.ceil(cipherLen / c.k) })
      const opened = session.open(keys.aeadKey, c.blockId, unhex(c.ciphertext), aad)
      if (hex(opened.body) !== c.body) fail("decrypted body differs")
      if (opened.fin !== c.fin) fail("fin differs")
      if (opened.sentAtMs !== c.sentAtMs) fail("sentAt differs")
      if (hex(session.seal(keys.aeadKey, c.blockId, c.fin, body, c.sentAtMs, aad)) !== c.ciphertext) fail("ciphertext differs when sealed here")
      const ack = frames.encodeAck({ kind: "ack", sessionId, blockId: c.blockId }, keys.macKey)
      if (hex(ack) !== c.ack) fail("ack frame differs")
      const decoded = frames.decodeFrame(unhex(c.ack), keys.macKey)
      if (decoded?.kind !== "ack" || decoded.blockId !== c.blockId) fail("ack frame did not verify")
      if (hex(primitives.hkdfSha256(unhex(c.hkdf.ikm), unhex(c.hkdf.salt), unhex(c.hkdf.info), c.hkdf.length)) !== c.hkdf.okm) fail("hkdf differs")
      if (hex(primitives.hmacSha256(unhex(c.hmac.key), unhex(c.hmac.data))) !== c.hmac.mac) fail("hmac differs")
    } catch (err) {
      fail(`threw ${(err as Error)?.message ?? err}`)
    }
  })
  return failures
}

/** Every way a block or a control frame must fail to authenticate. Returns failures. */
export function checkRejections(lib: CryptoLib, c: Case): string[] {
  const { session, frames } = lib
  const failures: string[] = []
  const sessionId = unhex(c.sessionId)
  const keys = session.deriveKeys(unhex(c.secret), sessionId)
  const body = unhex(c.body)
  const cipherLen = session.sealedLength(body.length)
  const ctx = { sessionId, blockId: c.blockId, k: c.k, n: c.n, cipherLen, shardLen: Math.ceil(cipherLen / c.k) }
  const aad = session.blockAad(ctx)
  const cipher = unhex(c.ciphertext)
  const mustThrow = (what: string, run: () => unknown) => {
    try {
      run()
      failures.push(`${what} was accepted`)
    } catch {
      // expected
    }
  }
  const flipped = (bytes: Uint8Array, at: number) => {
    const out = Uint8Array.from(bytes)
    out[at] = (out[at] ?? 0) ^ 0x01
    return out
  }
  mustThrow("a changed ciphertext byte", () => session.open(keys.aeadKey, c.blockId, flipped(cipher, 0), aad))
  mustThrow("a changed tag byte", () => session.open(keys.aeadKey, c.blockId, flipped(cipher, cipher.length - 1), aad))
  mustThrow("changed associated data", () => session.open(keys.aeadKey, c.blockId, cipher, flipped(aad, 27)))
  mustThrow("another block id", () => session.open(keys.aeadKey, c.blockId + 1, cipher, session.blockAad({ ...ctx, blockId: c.blockId + 1 })))
  mustThrow("the mac key", () => session.open(keys.macKey, c.blockId, cipher, aad))
  mustThrow("a cut ciphertext", () => session.open(keys.aeadKey, c.blockId, cipher.subarray(0, 10), aad))
  const ack = unhex(c.ack)
  if (frames.decodeFrame(flipped(ack, ack.length - 1), keys.macKey) !== null) failures.push("an ack with a changed mac was accepted")
  if (frames.decodeFrame(flipped(ack, 20), keys.macKey) !== null) failures.push("an ack with a changed block id was accepted")
  if (frames.decodeFrame(ack, keys.aeadKey) !== null) failures.push("an ack under the wrong key was accepted")
  return failures
}

export type VectorFile = {
  inputs: { sessionSecret: string; sessionId: string; otherSessionId: string; blockId: number; k: number; n: number; fin: boolean; sentAtMs: number; plaintext: string }
  expected: { aeadKey: string; macKey: string; otherAeadKey: string; otherMacKey: string; aad: string; ciphertext: string; ackFrame: string; controlMac: string }
}

/** Tesera's fixed v2 vectors, from test/vectors/v2.json. Returns failures. */
export function checkVectors(lib: CryptoLib, file: VectorFile): string[] {
  const { session, frames } = lib
  const failures: string[] = []
  const expect = (what: string, got: string, want: string) => {
    if (got !== want) failures.push(`${what}: got ${got}, want ${want}`)
  }
  const { inputs, expected } = file
  const sessionId = unhex(inputs.sessionId)
  const keys = session.deriveKeys(unhex(inputs.sessionSecret), sessionId)
  const other = session.deriveKeys(unhex(inputs.sessionSecret), unhex(inputs.otherSessionId))
  expect("aead key", hex(keys.aeadKey), expected.aeadKey)
  expect("mac key", hex(keys.macKey), expected.macKey)
  expect("other aead key", hex(other.aeadKey), expected.otherAeadKey)
  expect("other mac key", hex(other.macKey), expected.otherMacKey)
  const body = unhex(inputs.plaintext)
  const cipherLen = session.sealedLength(body.length)
  const aad = session.blockAad({ sessionId, blockId: inputs.blockId, k: inputs.k, n: inputs.n, cipherLen, shardLen: Math.ceil(cipherLen / inputs.k) })
  expect("aad", hex(aad), expected.aad)
  const cipher = session.seal(keys.aeadKey, inputs.blockId, inputs.fin, body, inputs.sentAtMs, aad)
  expect("ciphertext", hex(cipher), expected.ciphertext)
  expect("opened", hex(session.open(keys.aeadKey, inputs.blockId, unhex(expected.ciphertext), aad).body), inputs.plaintext)
  try {
    session.open(other.aeadKey, inputs.blockId, cipher, aad)
    failures.push("opened under another session's key")
  } catch {
    // expected
  }
  const ack = frames.encodeAck({ kind: "ack", sessionId, blockId: inputs.blockId }, keys.macKey)
  expect("ack frame", hex(ack), expected.ackFrame)
  expect("control mac", hex(ack.subarray(ack.length - 16)), expected.controlMac)
  return failures
}
