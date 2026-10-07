import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { WebTransportCert } from "../src/attach/cert.js"
import { CertRotation, DEFAULT_ROTATION } from "../src/attach/rotation.js"
import { signStatement, STATEMENT_TTL_SEC, verifyStatement } from "../src/attach/statement.js"
import { generateIdentity, signIdentity } from "../src/identity/id.js"
import { Relay } from "../src/relay/relay.js"

const DAY = 24 * 60 * 60 * 1000
const hash = (n: number) => n.toString(16).padStart(64, "0")

describe("transport statement", () => {
  const relay = generateIdentity()
  const now = 1_800_000_000
  const pins = [{ sha256: hash(1), notAfter: now + 3600 }]

  it("verifies a statement signed by the relay it names", () => {
    const statement = verifyStatement(signStatement(relay, { attach: 1, certificates: pins }, now), relay.id, now)
    assert.ok(statement)
    assert.equal(statement.relay, relay.id)
    assert.equal(statement.type, "webtransport")
    assert.equal(statement.attach, 1)
    assert.deepEqual(statement.certificates, pins)
    assert.equal(statement.expiresAt, now + STATEMENT_TTL_SEC)
  })

  it("rejects a statement checked against another relay id", () => {
    const doc = signStatement(relay, { attach: 1, certificates: pins }, now)
    assert.equal(verifyStatement(doc, generateIdentity().id, now), null)
  })

  it("rejects a statement another relay signed in this relay's name", () => {
    const other = generateIdentity()
    const doc = signStatement({ ...other, id: relay.id }, { attach: 1, certificates: pins }, now)
    assert.equal(verifyStatement(doc, relay.id, now), null)
  })

  it("rejects a changed statement", () => {
    const doc = signStatement(relay, { attach: 1, certificates: pins }, now)
    const body = JSON.parse(Buffer.from(doc.statement, "base64url").toString("utf8"))
    body.certificates[0].sha256 = hash(2)
    const changed = { ...doc, statement: Buffer.from(JSON.stringify(body)).toString("base64url") }
    assert.equal(verifyStatement(changed, relay.id, now), null)
  })

  it("rejects a signature over the body without the statement prefix", () => {
    const doc = signStatement(relay, { attach: 1, certificates: pins }, now)
    const bare = signIdentity(relay, Buffer.from(doc.statement, "base64url")).toString("base64url")
    assert.equal(verifyStatement({ ...doc, signature: bare }, relay.id, now), null)
  })

  it("rejects an expired statement", () => {
    const doc = signStatement(relay, { attach: 1, certificates: pins }, now)
    assert.equal(verifyStatement(doc, relay.id, now + STATEMENT_TTL_SEC), null)
  })

  it("drops expired pins, and rejects a statement whose pins all expired", () => {
    const mixed = [{ sha256: hash(1), notAfter: now + 10 }, { sha256: hash(2), notAfter: now + 3600 }]
    const doc = signStatement(relay, { attach: 1, certificates: mixed }, now)
    assert.deepEqual(verifyStatement(doc, relay.id, now + 20)?.certificates, [mixed[1]])
    const stale = signStatement(relay, { attach: 1, certificates: [mixed[0]!] }, now)
    assert.equal(verifyStatement(stale, relay.id, now + 20), null)
  })

  it("keeps a statement with no pins, for a certificate from a public authority", () => {
    const doc = signStatement(relay, { attach: 1, certificates: [] }, now)
    assert.deepEqual(verifyStatement(doc, relay.id, now)?.certificates, [])
  })

  it("is served by the relay's local API, and is empty without a transport", async () => {
    for (const statements of [[signStatement(relay, { attach: 1, certificates: pins })], undefined]) {
      const served = new Relay({
        host: "127.0.0.1",
        identity: relay,
        api: { host: "127.0.0.1", port: 0 },
        transportStatements: statements && (() => statements),
      })
      await served.start()
      try {
        const api = served.apiEndpoint!
        const body = (await (await fetch(`http://${api.host}:${api.port}/v1/transports`)).json()) as { statements: unknown[] }
        assert.deepEqual(body, { statements: statements ?? [] })
        if (statements) assert.ok(verifyStatement(body.statements[0], relay.id))
      } finally {
        await served.close()
      }
    }
  })

  it("rejects malformed documents", () => {
    for (const doc of [null, "x", {}, { statement: 1, signature: "a" }, { statement: "!!", signature: "" }]) {
      assert.equal(verifyStatement(doc, relay.id, now), null)
    }
  })
})

describe("certificate rotation", () => {
  let clock = 0
  let made = 0
  const cert = (start: number): WebTransportCert => ({
    cert: "",
    privKey: "",
    hash: Buffer.from(hash(++made), "hex"),
    notBefore: start,
    notAfter: start + 10 * DAY,
  })
  const fresh = () => {
    clock = 0
    made = 0
    return new CertRotation(cert(0), () => cert(clock), DEFAULT_ROTATION, () => clock)
  }

  it("publishes only the current certificate until the next one is due", () => {
    const rotation = fresh()
    clock = 3 * DAY
    assert.equal(rotation.tick(true), null)
    assert.equal(rotation.published().length, 1)
  })

  it("publishes the next certificate days before it switches", () => {
    const rotation = fresh()
    clock = 4 * DAY
    assert.equal(rotation.tick(true), null)
    const [current, next] = rotation.published()
    assert.ok(current && next)
    assert.equal(rotation.active, current)
    clock = 5 * DAY
    assert.equal(rotation.tick(true), null, "too early to switch even when idle")
  })

  it("switches when idle once the current certificate is old enough", () => {
    const rotation = fresh()
    clock = 4 * DAY
    rotation.tick(true)
    const next = rotation.published()[1]
    clock = 6 * DAY
    assert.equal(rotation.tick(false), null, "not while an attachment is open")
    assert.equal(rotation.tick(true), next)
    assert.equal(rotation.active, next)
    assert.deepEqual(rotation.published(), [next])
  })

  it("switches by the deadline even with attachments open", () => {
    const rotation = fresh()
    clock = 4 * DAY
    rotation.tick(false)
    clock = 9 * DAY
    assert.ok(rotation.tick(false))
  })

  it("never publishes an expired certificate", () => {
    const rotation = fresh()
    clock = 10 * DAY
    assert.deepEqual(rotation.published(), [])
  })
})
