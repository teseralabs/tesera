import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { DEFAULT_WINDOW, fullBlockBodySize } from "../src/constants.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { TeseraSender } from "../src/transport/sender.js"
import { sleep } from "../src/util.js"
import { MemoryNetwork, memoryRelay } from "./memory-network.js"

async function pausedTransfer(size: number, pauseMs: number, maxUnreadBytes?: number) {
  const network = new MemoryNetwork()
  const relays = [await memoryRelay(network), await memoryRelay(network), await memoryRelay(network)]
  const secret = randomBytes(32)
  const payload = randomBytes(size)
  const receiverAt = { host: "127.0.0.1", port: 50000 }
  const senderAt = { host: "127.0.0.1", port: 50001 }
  const sender = new TeseraSender({
    session: secret,
    receiver: receiverAt,
    relays: relays.map((r) => r.endpoint),
    transport: network.transport(senderAt.host, senderAt.port),
  })
  const receiver = new TeseraReceiver({
    session: secret,
    sessionId: sender.sessionId,
    sender: senderAt,
    relays: relays.map((r) => r.endpoint),
    transport: network.transport(receiverAt.host, receiverAt.port),
    maxUnreadBytes,
  })
  await receiver.start()
  await sender.start()
  const writing = (async () => {
    for (let at = 0; at < payload.length; at += 64 * 1024) await sender.write(payload.subarray(at, at + 64 * 1024))
    await sender.end()
  })()
  // The reader stalls, like a slow disk, before it takes anything.
  await sleep(pauseMs)
  const parts: Uint8Array[] = []
  for (;;) {
    const chunk = await receiver.read()
    if (chunk === null) break
    parts.push(chunk)
  }
  await writing
  await sender.close()
  await receiver.close()
  for (const relay of relays) await relay.close()
  return { sent: payload, received: Buffer.concat(parts), maxUnread: receiver.stats.maxUnreadBytes }
}

describe("receiver backpressure", () => {
  it("holds unread bytes near the limit while the reader stalls", async () => {
    const limit = 64 * 1024
    const result = await pausedTransfer(2_000_000, 800, limit)
    assert.ok(result.received.equals(result.sent))
    // Past the limit only blocks the sender already had in flight can land.
    const body = fullBlockBodySize(2, 1024)
    assert.ok(result.maxUnread <= limit + (DEFAULT_WINDOW + 1) * body, `unread peaked at ${result.maxUnread}`)
  })

  it("queues everything for a stalled reader without a limit", async () => {
    const result = await pausedTransfer(2_000_000, 800)
    assert.ok(result.received.equals(result.sent))
    assert.ok(result.maxUnread > 1_000_000, `unread peaked at ${result.maxUnread}`)
  })

  it("refuses a limit that is not positive", () => {
    assert.throws(
      () => new TeseraReceiver({ session: randomBytes(32), relays: [{ host: "127.0.0.1", port: 1 }], maxUnreadBytes: 0 }),
      /maxUnreadBytes/,
    )
  })
})
