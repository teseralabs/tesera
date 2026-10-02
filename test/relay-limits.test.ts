import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { bindUdp, closeUdp, createUdpSocket, sendUdp, type Endpoint } from "../src/carrier/udp.js"
import {
  ENVELOPE_LEN,
  MAX_FORWARD_DATAGRAM,
  MAX_SHARD,
  UNVERIFIED_DEST_BYTES,
  UNVERIFIED_DEST_MAX,
} from "../src/constants.js"
import { blockAad, deriveKeys, sealedLength, seal } from "../src/crypto/session.js"
import { generateIdentity, type Identity } from "../src/identity/id.js"
import {
  decodeAgain,
  encodeLookup,
  encodeResume,
  encodeTable,
  readRelayTable,
  type IntroducedRelay,
} from "../src/identity/peers.js"
import { encodeData, decodeFrame } from "../src/protocol/frames.js"
import { encodeEnvelope } from "../src/protocol/envelope.js"
import { DestBudget } from "../src/relay/dest-budget.js"
import { destinationAllowed, parseCidr } from "../src/relay/dest.js"
import { Relay } from "../src/relay/relay.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { sleep } from "../src/util.js"

const denied: Array<[string, string]> = [
  ["0.0.0.0", "0.255.255.255"],
  ["10.0.0.0", "10.255.255.255"],
  ["100.64.0.0", "100.127.255.255"],
  ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["172.16.0.0", "172.31.255.255"],
  ["192.0.0.0", "192.0.0.255"],
  ["192.0.2.0", "192.0.2.255"],
  ["192.168.0.0", "192.168.255.255"],
  ["198.18.0.0", "198.19.255.255"],
  ["198.51.100.0", "198.51.100.255"],
  ["203.0.113.0", "203.0.113.255"],
  ["224.0.0.0", "239.255.255.255"],
  ["240.0.0.0", "255.255.255.254"],
]

const outside: string[] = [
  "1.0.0.0",
  "9.255.255.255",
  "11.0.0.0",
  "100.63.255.255",
  "100.128.0.0",
  "128.0.0.0",
  "169.255.0.0",
  "172.15.255.255",
  "172.32.0.0",
  "192.0.1.0",
  "192.0.3.0",
  "192.169.0.0",
  "198.17.255.255",
  "198.20.0.0",
  "198.51.99.255",
  "198.51.101.0",
  "203.0.112.255",
  "203.0.114.0",
  "223.255.255.255",
  "8.8.8.8",
]

test("refuses each reserved range and allows the address just outside it", () => {
  for (const [first, last] of denied) {
    assert.equal(destinationAllowed(first, []), false, first)
    assert.equal(destinationAllowed(last, []), false, last)
  }
  assert.equal(destinationAllowed("255.255.255.255", []), false)
  for (const host of outside) assert.equal(destinationAllowed(host, []), true, host)
  assert.equal(destinationAllowed("100.64.0.1", [parseCidr("100.64.0.0/10")]), true)
  assert.equal(destinationAllowed("10.0.0.1", [parseCidr("100.64.0.0/10")]), false)
  assert.equal(destinationAllowed("10.1.2.3", [parseCidr("10.1.2.3/8")]), true)
  assert.equal(destinationAllowed("192.168.0.1", [parseCidr("10.1.2.3/8")]), false)
  assert.equal(destinationAllowed("8.8.8.8", [parseCidr("0.0.0.0/0")]), true)
  assert.equal(destinationAllowed("10.0.0.1", [parseCidr("0.0.0.0/0")]), true)
  assert.throws(() => parseCidr("10.0.0.0"), /invalid CIDR/)
  assert.throws(() => parseCidr("10.0.0.0/33"), /invalid CIDR/)
})

test("an unverified destination keeps one allowance across spends", async () => {
  const dest: Endpoint = { host: "1.2.3.4", port: 4101 }
  const other: Endpoint = { host: "1.2.3.4", port: 4102 }
  const budget = new DestBudget(UNVERIFIED_DEST_BYTES, UNVERIFIED_DEST_MAX, 40)
  let left = UNVERIFIED_DEST_BYTES
  while (left > 0) {
    const n = Math.min(1024, left)
    assert.equal(budget.spend(dest, n), true)
    left -= n
  }
  assert.equal(budget.remaining(dest), 0)
  assert.equal(budget.spend(dest, 1), false)
  assert.equal(budget.remaining(dest), 0)
  assert.equal(budget.spend(dest, 1024), false)
  assert.equal(budget.remaining(other), null)
  assert.equal(budget.spend(other, 1024), true)

  const capped = new DestBudget(100, UNVERIFIED_DEST_MAX, 60_000)
  const first: Endpoint = { host: "9.9.9.1", port: 1 }
  assert.equal(capped.spend(first, 40), true)
  for (let i = 1; i < UNVERIFIED_DEST_MAX; i++) {
    assert.equal(capped.spend({ host: "9.9.9.1", port: i + 1 }, 1), true)
  }
  assert.equal(capped.size, UNVERIFIED_DEST_MAX)
  assert.equal(capped.spend({ host: "9.9.9.2", port: 1 }, 1), false)
  assert.equal(capped.spend(first, 60), true)
  assert.equal(capped.spend(first, 1), false)
  assert.equal(capped.remaining(first), 0)

  const expiring = new DestBudget(1024, 4, 40)
  const gone: Endpoint = { host: "8.8.8.8", port: 9 }
  assert.equal(expiring.spend(gone, 1024), true)
  assert.equal(expiring.spend(gone, 1), false)
  await sleep(60)
  assert.equal(expiring.spend(gone, 1024), true)

  const live = new DestBudget(1024, 4, 60_000)
  assert.equal(live.spend(gone, 1024), true)
  assert.equal(live.remaining(gone), 0)
  live.markReachable(gone)
  assert.equal(live.remaining(gone), 0)
  assert.equal(live.spend(gone, 1024), true)
  assert.equal(live.remaining(gone), 0)
})

test("a data frame must fit one tessera", () => {
  const payload = randomBytes(MAX_SHARD)
  const fit = encodeData({
    kind: "data",
    sessionId: randomBytes(16),
    blockId: 0,
    k: 1,
    n: 1,
    tesseraIndex: 0,
    cipherLen: MAX_SHARD,
    payload,
  })
  assert.equal(fit.length, MAX_FORWARD_DATAGRAM - ENVELOPE_LEN)
  assert.equal(decodeFrame(fit, null)?.kind, "data")

  const over = encodeData({
    kind: "data",
    sessionId: randomBytes(16),
    blockId: 0,
    k: 1,
    n: 1,
    tesseraIndex: 0,
    cipherLen: MAX_SHARD,
    payload: Buffer.concat([payload, Buffer.from([0])]),
  })
  assert.equal(decodeFrame(over, null), null)

  const exact = encodeData({
    kind: "data",
    sessionId: randomBytes(16),
    blockId: 1,
    k: 2,
    n: 2,
    tesseraIndex: 1,
    cipherLen: 8,
    payload: Buffer.alloc(4),
  })
  assert.equal(decodeFrame(exact, null)?.kind, "data")
  const past = encodeData({
    kind: "data",
    sessionId: randomBytes(16),
    blockId: 1,
    k: 2,
    n: 2,
    tesseraIndex: 1,
    cipherLen: 9,
    payload: Buffer.alloc(4),
  })
  assert.equal(decodeFrame(past, null), null)
  const index = encodeData({
    kind: "data",
    sessionId: randomBytes(16),
    blockId: 1,
    k: 2,
    n: 2,
    tesseraIndex: 2,
    cipherLen: 8,
    payload: Buffer.alloc(4),
  })
  assert.equal(decodeFrame(index, null), null)
})

test("a public relay spends one allowance per destination and ignores a new session", async () => {
  const relay = new Relay({ allowRemote: true, host: "127.0.0.1" })
  const tx = createUdpSocket()
  let forwarded = 0
  relay.onForward = () => {
    forwarded++
  }
  try {
    await relay.start()
    await bindUdp(tx, "127.0.0.1", 0)
    const dest: Endpoint = { host: "1.2.3.4", port: 4101 }
    for (let i = 0; i < 8; i++) await sendUdp(tx, encodeEnvelope(dest, Buffer.alloc(1024, i)), relay.endpoint)
    await waitFor(() => forwarded === 8)
    await sendUdp(tx, encodeEnvelope(dest, Buffer.alloc(1024, 9)), relay.endpoint)
    await sleep(30)
    assert.equal(forwarded, 8)
    assert.equal(relay.stats.droppedLimited, 1)
    for (let i = 0; i < 4; i++) await sendUdp(tx, encodeEnvelope(dest, Buffer.alloc(1024, 20 + i)), relay.endpoint)
    await sleep(30)
    assert.equal(forwarded, 8)
    assert.ok(relay.stats.droppedLimited >= 5)

    const other: Endpoint = { host: "1.2.3.5", port: 4101 }
    await sendUdp(tx, encodeEnvelope(other, Buffer.alloc(1024)), relay.endpoint)
    await waitFor(() => forwarded === 9)

    const edge = Buffer.alloc(MAX_FORWARD_DATAGRAM - ENVELOPE_LEN)
    await sendUdp(tx, encodeEnvelope({ host: "1.2.3.6", port: 4101 }, edge), relay.endpoint)
    await waitFor(() => forwarded === 10)
  } finally {
    await closeUdp(tx)
    await relay.close()
  }
})

test("a private destination is refused and a reply from the same port lifts the allowance", async () => {
  const relay = new Relay({ allowRemote: true, host: "127.0.0.1", allowDest: ["127.0.0.0/8"], destTtlMs: 60_000 })
  const tx = createUdpSocket()
  const destSock = createUdpSocket()
  let forwarded = 0
  relay.onForward = () => {
    forwarded++
  }
  try {
    await relay.start()
    await bindUdp(tx, "127.0.0.1", 0)
    await bindUdp(destSock, "127.0.0.1", 0)
    const dest = destSock.address()
    const local: Endpoint = { host: "127.0.0.1", port: dest.port }
    await sendUdp(tx, encodeEnvelope({ host: "10.0.0.1", port: 9 }, Buffer.alloc(32)), relay.endpoint)
    await sleep(20)
    assert.equal(forwarded, 0)
    assert.equal(relay.stats.droppedDenied, 1)

    for (let i = 0; i < 8; i++) await sendUdp(tx, encodeEnvelope(local, Buffer.alloc(1024, i)), relay.endpoint)
    await waitFor(() => forwarded === 8)
    await sendUdp(tx, encodeEnvelope(local, Buffer.alloc(1024, 9)), relay.endpoint)
    await sleep(30)
    assert.equal(forwarded, 8)

    await sendUdp(destSock, Buffer.from([1, 2, 3]), relay.endpoint)
    await sleep(20)
    await sendUdp(tx, encodeEnvelope(local, Buffer.alloc(1024, 10)), relay.endpoint)
    await sleep(30)
    assert.equal(forwarded, 8)

    await sendUdp(destSock, encodeLookup(randomBytes(16)), relay.endpoint)
    await sleep(20)
    await sendUdp(tx, encodeEnvelope(local, Buffer.alloc(1024, 11)), relay.endpoint)
    await waitFor(() => forwarded === 9)
  } finally {
    await closeUdp(tx)
    await closeUdp(destSock)
    await relay.close()
  }
})

test("a forwarded datagram stops at one tessera and a peer table does not", async () => {
  const peers = Array.from({ length: 31 }, (_, i) => {
    const id = generateIdentity()
    return {
      id: id.id,
      host: "8.8.8.8",
      port: 1000 + i,
      seenAt: Date.now(),
      seq: 0,
      bytes: 0,
      transfers: 0,
    }
  })
  const listed: IntroducedRelay[] = peers.map((peer) => ({
    id: peer.id,
    endpoint: { host: peer.host, port: peer.port },
  }))
  const tableBytes = encodeTable(generateIdentity(), randomBytes(16), listed).length
  assert.ok(tableBytes > MAX_FORWARD_DATAGRAM)

  const dir = await mkdtemp(join(tmpdir(), "tesera-table-"))
  const peersFile = join(dir, "peers.json")
  await writeFile(peersFile, JSON.stringify({ peers }))
  const identity: Identity = generateIdentity()
  const relay = new Relay({
    allowRemote: true,
    host: "127.0.0.1",
    identity,
    peersFile,
    peerTtlMs: 30 * 24 * 60 * 60 * 1000,
  })
  const tx = createUdpSocket()
  try {
    await relay.start()
    await bindUdp(tx, "127.0.0.1", 0)
    const huge = Buffer.alloc(MAX_FORWARD_DATAGRAM + 1)
    huge.set(Buffer.from("TESR"))
    await sendUdp(tx, huge, relay.endpoint)
    const edge = Buffer.alloc(MAX_FORWARD_DATAGRAM)
    edge.set(Buffer.from("TESR"))
    await sendUdp(tx, edge, relay.endpoint)
    await sleep(30)
    assert.equal(relay.stats.droppedInvalid, 2)
    assert.equal(relay.stats.forwarded, 0)

    const table = await readRelayTable(relay.endpoint)
    assert.equal(table.peers.length, 31)
  } finally {
    await closeUdp(tx)
    await relay.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("a peer table shares the datagram budget with the nonce reply", async () => {
  const relay = new Relay({
    host: "127.0.0.1",
    identity: generateIdentity(),
    policy: { access: "open", bandwidthBps: 0, maxSessions: 0, peerRatePerMin: 0, datagramRatePerSec: 1 },
  })
  const sock = createUdpSocket()
  const got: Buffer[] = []
  sock.on("message", (msg) => got.push(Buffer.from(msg)))
  try {
    await relay.start()
    await bindUdp(sock, "127.0.0.1", 0)
    const challenge = randomBytes(16)
    await sendUdp(sock, encodeLookup(challenge), relay.endpoint)
    await waitFor(() => got.length >= 1)
    const again = decodeAgain(got[0] ?? Buffer.alloc(0))
    assert.ok(again)
    assert.equal(got.length, 1)
    await sendUdp(sock, encodeResume(challenge, again.nonce), relay.endpoint)
    await sleep(40)
    assert.equal(got.length, 1)
    assert.ok(relay.stats.droppedLimited >= 1)
  } finally {
    await closeUdp(sock)
    await relay.close()
  }
})

test("a receiver acknowledges only the recent window and ignores a block past it", async () => {
  const secret = randomBytes(32)
  const tx = createUdpSocket()
  const boundTx = await bindUdp(tx, "127.0.0.1", 0)
  const early = new TeseraReceiver({ session: secret, relays: [boundTx], sender: boundTx, maxAhead: 0 })
  const receiver = new TeseraReceiver({ session: secret, relays: [boundTx], sender: boundTx, maxAhead: 1 })
  const earlyRx = await early.start()
  const boundRx = await receiver.start()
  const sessionId = randomBytes(16)
  const earlyId = randomBytes(16)
  const first = dataFrame(secret, sessionId, 0, Buffer.from("aaaa"), false)
  const second = dataFrame(secret, sessionId, 1, Buffer.from("bbbb"), true)
  try {
    await sendUdp(tx, dataFrame(secret, earlyId, 1, Buffer.from("nope"), true), earlyRx)
    await sleep(20)
    assert.equal(early.stats.acksSent, 0)
    assert.equal(early.stats.maxBufferedBlocks, 0)
    assert.equal(early.stats.outputBytes, 0)
    await sendUdp(tx, dataFrame(secret, earlyId, 0, Buffer.from("ok"), true), earlyRx)
    assert.deepEqual(await early.read(), Buffer.from("ok"))

    await sendUdp(tx, first, boundRx)
    await sendUdp(tx, second, boundRx)
    assert.deepEqual(await receiver.read(), Buffer.from("aaaa"))
    assert.deepEqual(await receiver.read(), Buffer.from("bbbb"))
    assert.equal(receiver.stats.acksSent, 2)
    await sendUdp(tx, first, boundRx)
    await sleep(20)
    assert.equal(receiver.stats.acksSent, 2)
    await sendUdp(tx, second, boundRx)
    await sleep(20)
    assert.equal(receiver.stats.acksSent, 3)
  } finally {
    await early.close()
    await receiver.close()
    await closeUdp(tx)
  }
})

function dataFrame(secret: Buffer, sessionId: Buffer, blockId: number, body: Buffer, fin: boolean): Buffer {
  const keys = deriveKeys(secret, sessionId)
  const cipherLen = sealedLength(body.length)
  const ctx = { sessionId, blockId, k: 1, n: 1, cipherLen, shardLen: cipherLen }
  const payload = seal(keys.aeadKey, blockId, fin, body, 1_000, blockAad(ctx))
  return encodeData({ kind: "data", sessionId, blockId, tesseraIndex: 0, k: 1, n: 1, cipherLen, payload })
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now()
  while (!ready()) {
    if (Date.now() - start > 1000) throw new Error("timed out")
    await sleep(5)
  }
}
