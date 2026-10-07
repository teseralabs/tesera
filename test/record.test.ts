import { strict as assert } from "node:assert"
import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { bindUdp, closeUdp, createUdpSocket } from "../src/carrier/udp.js"
import { confirmRelay } from "../src/identity/confirm.js"
import { HEADER_LEN, generateIdentity, identityFromSecret, signIdentity } from "../src/identity/id.js"
import {
  MAX_RECORD_BODY,
  RECORD_DOMAIN,
  RECORD_SKEW_SEC,
  chooseRecord,
  decodeRecord,
  encodeRecord,
  fetchRelayRecord,
  officialClaims,
  SOFTWARE_VERSION,
  planRecord,
  recordDocument,
  recordFresh,
  verifyRecord,
  type RecordClaims,
  type SignedRecord,
} from "../src/identity/record.js"
import { Relay } from "../src/relay/relay.js"
import { isStructuralTesera } from "../src/relay/structural.js"
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url))
const now = 1_700_000_000

function claims(partial: Partial<RecordClaims> = {}): RecordClaims {
  return {
    ...officialClaims({ addresses: [{ host: "203.0.113.10", port: 4101 }], name: "north", ttlSec: 3600 }),
    ...partial,
  }
}

function resign(identity: ReturnType<typeof generateIdentity>, packet: Buffer, body: Buffer): Buffer {
  const signature = signIdentity(identity, Buffer.concat([RECORD_DOMAIN, body]))
  const out = Buffer.alloc(HEADER_LEN + body.length + signature.length)
  out.set(packet.subarray(0, HEADER_LEN), 0)
  out.set(body, HEADER_LEN)
  out.set(signature, HEADER_LEN + body.length)
  return out
}

describe("relay record", () => {
  it("uses the package version as the software claim", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
      version: string
    }
    assert.equal(SOFTWARE_VERSION, pkg.version)
  })

  it("round-trips a signed record and derives json from the packet", () => {
    const id = generateIdentity()
    const packet = encodeRecord(id, claims(), 50n, now)
    const record = decodeRecord(packet)
    assert.ok(record)
    assert.equal(verifyRecord(record), true)
    assert.equal(record.seq, 50n)
    assert.equal(recordFresh(record, now), true)
    assert.equal(record.wire, 2)
    assert.deepEqual(record.capabilities, ["discover", "forward"])
    assert.equal(record.name, "north")
    assert.deepEqual(record.addresses, [{ host: "203.0.113.10", port: 4101 }])
    const doc = recordDocument(packet)
    assert.ok(doc)
    assert.equal(doc.packet, packet.toString("base64"))
    assert.equal(doc.record.seq, "50")
    assert.equal(doc.record.id, id.id)
    assert.deepEqual(doc.record.addresses, ["203.0.113.10:4101"])
    const flipped = Buffer.from(packet)
    flipped[HEADER_LEN + 10] = (flipped[HEADER_LEN + 10] ?? 0) ^ 0xff
    const parsed = decodeRecord(flipped)
    assert.ok(parsed)
    assert.equal(verifyRecord(parsed), false)
    assert.equal(recordDocument(flipped), null)
  })

  it("treats sequence as an opaque counter", () => {
    const id = generateIdentity()
    const low = mustDecode(encodeRecord(id, claims(), 1n, now))
    const high = mustDecode(encodeRecord(id, claims(), 50n, now))
    assert.equal(recordFresh(high, now), true)
    assert.equal(chooseRecord(low, high).action, "supersede")
    const expired = mustDecode(encodeRecord(id, claims(), 80n, now - 3601))
    assert.equal(recordFresh(expired, now), false)
    const choice = chooseRecord(expired, high)
    assert.equal(choice.action, "keep")
    assert.equal(choice.record?.seq, 80n)
    assert.equal(recordFresh(choice.record as SignedRecord, now), false)
    const again = mustDecode(encodeRecord(id, claims(), 50n, now))
    assert.equal(chooseRecord(high, again).action, "same")
    const other = mustDecode(encodeRecord(id, claims({ name: "south" }), 50n, now))
    const conflict = chooseRecord(high, other)
    assert.equal(conflict.action, "conflict")
    assert.equal(conflict.record?.name, "north")
    const forged = Buffer.from(high.packet)
    forged[forged.length - 1] = (forged[forged.length - 1] ?? 0) ^ 0xff
    const bad = decodeRecord(forged)
    assert.ok(bad)
    assert.equal(chooseRecord(low, bad).action, "reject")
    assert.equal(chooseRecord(low, bad).record?.seq, 1n)
  })

  it("keeps freshness on issuedAt and ttl", () => {
    const id = generateIdentity()
    const record = mustDecode(encodeRecord(id, claims({ ttlSec: 3600 }), 4n, now))
    const ahead = mustDecode(encodeRecord(id, claims({ ttlSec: 3600 }), 5n, now + RECORD_SKEW_SEC))
    const early = mustDecode(encodeRecord(id, claims({ ttlSec: 3600 }), 6n, now + RECORD_SKEW_SEC + 1))
    assert.equal(recordFresh(ahead, now), true)
    assert.equal(recordFresh(early, now), false)
    assert.equal(recordFresh(record, now + 3600), true)
    assert.equal(recordFresh(record, now + 3601), false)
  })

  it("rejects a record that is not canonical", () => {
    const id = generateIdentity()
    const packet = encodeRecord(
      id,
      claims({
        addresses: [
          { host: "203.0.113.20", port: 4101 },
          { host: "203.0.113.10", port: 9 },
        ],
      }),
      2n,
      now,
    )
    const record = mustDecode(packet)
    assert.deepEqual(
      record.addresses.map((endpoint) => `${endpoint.host}:${endpoint.port}`),
      ["203.0.113.10:9", "203.0.113.20:4101"],
    )
    const body = Buffer.from(record.body)
    const addrAt = body.length - (1 + Buffer.byteLength("north")) - 14
    const swapped = Buffer.from(body)
    const a = Buffer.from(swapped.subarray(addrAt, addrAt + 7))
    const b = Buffer.from(swapped.subarray(addrAt + 7, addrAt + 14))
    swapped.set(b, addrAt)
    swapped.set(a, addrAt + 7)
    assert.equal(decodeRecord(resign(id, packet, swapped)), null)
    const zero = Buffer.from(record.body)
    zero.writeBigUInt64BE(0n, 34)
    assert.equal(decodeRecord(resign(id, packet, zero)), null)
    const huge = Buffer.alloc(HEADER_LEN + MAX_RECORD_BODY + 1 + 64)
    huge.set(packet.subarray(0, HEADER_LEN))
    assert.equal(decodeRecord(huge), null)
    assert.throws(() => encodeRecord(id, claims({ name: "x".repeat(65) }), 1n, now), /64 bytes/)
    assert.throws(() => encodeRecord(id, claims({ name: "bad\nname" }), 1n, now), /character/)
    assert.throws(() => encodeRecord(id, claims({ name: "hide\u202eme" }), 1n, now), /character/)
    assert.throws(() => encodeRecord(id, claims({ addresses: [{ host: "0.0.0.0", port: 4101 }] }), 1n, now), /0\.0\.0\.0/)
    assert.equal(isStructuralTesera(packet), true)
  })

  it("reuses a stored sequence across a restart and starts at 1 when the file is gone", () => {
    const id = generateIdentity()
    const input = claims()
    const first = planRecord({ identity: id, claims: input, stored: null, nowSec: now })
    assert.equal(first.seq, 1n)
    assert.equal(first.reused, false)
    const again = planRecord({ identity: id, claims: input, stored: first.packet, nowSec: now + 10 })
    assert.equal(again.reused, true)
    assert.equal(again.seq, 1n)
    assert.ok(again.packet.equals(first.packet))
    const renamed = planRecord({ identity: id, claims: claims({ name: "south" }), stored: first.packet, nowSec: now + 10 })
    assert.equal(renamed.seq, 2n)
    const late = planRecord({ identity: id, claims: input, stored: first.packet, nowSec: now + 1801 })
    assert.equal(late.seq, 2n)
    assert.equal(late.reused, false)
    const lost = planRecord({ identity: id, claims: input, stored: null, nowSec: now + 10 })
    assert.equal(lost.seq, 1n)
    assert.throws(() => planRecord({ identity: id, claims: input, stored: Buffer.from("nope"), nowSec: now }), /not a valid record/)
    const other = generateIdentity()
    assert.throws(
      () => planRecord({ identity: other, claims: input, stored: first.packet, nowSec: now }),
      /different relay/,
    )
  })

  it("serves the packet on udp and http, and keeps the sequence after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-record-"))
    const secret = join(dir, "relay.secret")
    const file = join(dir, "relay.record")
    const id = generateIdentity()
    await writeFile(secret, `${id.secret.toString("hex")}\n`, { mode: 0o600 })
    const relay = new Relay({
      host: "127.0.0.1",
      port: 0,
      identity: identityFromSecret(id.secret.toString("hex")),
      advertise: [],
      recordFile: file,
      api: { host: "127.0.0.1", port: 0 },
    })
    try {
      const bound = await relay.start()
      await relay.close()
      const advertised = new Relay({
        host: "127.0.0.1",
        port: bound.port,
        identity: identityFromSecret(id.secret.toString("hex")),
        advertise: [{ host: "127.0.0.1", port: bound.port }],
        recordName: "north",
        recordFile: file,
        api: { host: "127.0.0.1", port: 0 },
      })
      const endpoint = await advertised.start()
      const packet = await fetchRelayRecord(endpoint, { timeoutMs: 500, attempts: 2 })
      const doc = recordDocument(packet)
      assert.ok(doc)
      assert.equal(doc.record.seq, "2")
      assert.equal(doc.record.name, "north")
      assert.deepEqual(doc.record.addresses, [`127.0.0.1:${bound.port}`])
      assert.equal("bytes" in doc, false)
      assert.equal("bytes" in doc.record, false)
      const api = advertised.apiEndpoint
      assert.ok(api)
      const response = await fetch(`http://${api.host}:${api.port}/v1/record`)
      assert.equal(response.status, 200)
      const body = (await response.json()) as { packet: string; record: { seq: string; name: string } }
      assert.equal(body.packet, packet.toString("base64"))
      assert.deepEqual(body.record, recordDocument(Buffer.from(body.packet, "base64"))?.record)
      await confirmRelay(endpoint, id.id)
      await advertised.close()

      const restarted = new Relay({
        host: "127.0.0.1",
        port: 0,
        identity: identityFromSecret(id.secret.toString("hex")),
        advertise: [{ host: "127.0.0.1", port: bound.port }],
        recordName: "north",
        recordFile: file,
      })
      const again = await restarted.start()
      const second = await fetchRelayRecord(again, { timeoutMs: 500, attempts: 2 })
      assert.equal(recordDocument(second)?.record.seq, "2")
      assert.ok(second.equals(packet))
      await restarted.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("prints tesera info from the signed packet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-info-"))
    const secret = join(dir, "relay.secret")
    const id = generateIdentity()
    await writeFile(secret, `${id.secret.toString("hex")}\n`, { mode: 0o600 })
    const port = await reservePort()
    const child = spawn(
      process.execPath,
      [
        cliPath,
        "relay",
        "--listen",
        `127.0.0.1:${port}`,
        "--identity",
        secret,
        "--advertise",
        `127.0.0.1:${port}`,
        "--name",
        "north",
        "--api",
        "127.0.0.1:0",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    let output = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    try {
      await waitFor(() => output.includes("event=record "), 3000, child, output)
      const info = spawn(process.execPath, [cliPath, "info", `${id.id}@127.0.0.1:${port}`, "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
      })
      const text = await readAll(info)
      const report = JSON.parse(text.out) as {
        packet: string
        record: { seq: string; name: string; id: string; addresses: string[] }
        checks: { signature: string; pinned: string; fresh: boolean; reachable: boolean; advertised: boolean }
      }
      const derived = recordDocument(Buffer.from(report.packet, "base64"))
      assert.deepEqual(report.record, derived?.record)
      assert.equal(report.checks.signature, "valid")
      assert.equal(report.checks.pinned, "match")
      assert.equal(report.checks.fresh, true)
      assert.equal(report.checks.reachable, true)
      assert.equal(report.checks.advertised, true)
      assert.equal(report.record.name, "north")
      assert.equal(info.exitCode, 0)
      const stored = await readFile(`${secret}.record`)
      assert.equal(stored.toString("base64"), report.packet)
    } finally {
      child.kill("SIGTERM")
      await onceExit(child)
      await rm(dir, { recursive: true, force: true })
    }
  })
})

async function reservePort(): Promise<number> {
  const socket = createUdpSocket()
  const bound = await bindUdp(socket, "127.0.0.1", 0)
  await closeUdp(socket)
  return bound.port
}

function mustDecode(packet: Buffer): SignedRecord {
  const record = decodeRecord(packet)
  assert.ok(record)
  assert.equal(verifyRecord(record), true)
  return record
}

function waitFor(ready: () => boolean, timeoutMs: number, child: ChildProcess, output: string): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer)
        resolve()
        return
      }
      if (child.exitCode !== null || Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`relay did not publish a record\n${output}`))
      }
    }, 10)
  })
}

function readAll(child: ChildProcess): Promise<{ out: string; err: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let out = ""
    let err = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.once("error", reject)
    child.once("exit", (exitCode) => resolve({ out, err, exitCode }))
  })
}

function onceExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once("exit", () => resolve())
  })
}
