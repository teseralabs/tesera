import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { describe, it } from "node:test"
import { decodeFrame } from "../src/protocol/frames.js"
import { Relay } from "../src/relay/relay.js"
import { TeseraReceiver } from "../src/transport/receiver.js"
import { TeseraSender } from "../src/transport/sender.js"

describe("session id", () => {
  const nowhere = { host: "127.0.0.1", port: 9 }

  it("is 16 bytes, readable before start, and stays the same", () => {
    const sender = new TeseraSender({ session: randomBytes(32), receiver: nowhere, relays: [nowhere] })
    const id = sender.sessionId
    assert.equal(id.length, 16)
    assert.deepEqual(sender.sessionId, id)
    id.fill(0)
    assert.notDeepEqual(sender.sessionId, id)
  })

  it("differs between senders", () => {
    const opts = { session: Buffer.alloc(32, 1), receiver: nowhere, relays: [nowhere] }
    assert.notDeepEqual(new TeseraSender(opts).sessionId, new TeseraSender(opts).sessionId)
  })

  it("refuses a known id of the wrong length", () => {
    assert.throws(
      () => new TeseraReceiver({ session: randomBytes(32), relays: [nowhere], sessionId: randomBytes(15) }),
      /session id must be 16 bytes/,
    )
  })

  it("is the id the sender puts on the wire", async () => {
    const seen: Buffer[] = []
    const result = await transfer({
      known: "matching",
      tap: (relay) => {
        relay.onForward = (inner) => {
          const frame = decodeFrame(inner, null)
          if (frame?.kind === "data") seen.push(frame.sessionId)
        }
      },
    })
    assert.ok(seen.length > 0)
    for (const id of seen) assert.deepEqual(id, result.sessionId)
  })

  it("completes when the receiver knows the id ahead", async () => {
    const result = await transfer({ known: "matching" })
    assert.equal(result.received, result.sent)
  })

  it("completes when the receiver learns the id from the first frame, as before", async () => {
    const result = await transfer({ known: "none" })
    assert.equal(result.received, result.sent)
  })

  it("ignores a sender whose id doesn't match the known one", async () => {
    const result = await transfer({ known: "other" })
    assert.equal(result.received, null)
    assert.match(String(result.senderError), /transmissions|acknowledged/)
  })
})

type Outcome = { sessionId: Buffer; sent: string; received: string | null; senderError: unknown }

async function transfer(opts: { known: "matching" | "none" | "other"; tap?: (relay: Relay) => void }): Promise<Outcome> {
  const secret = randomBytes(32)
  const payload = randomBytes(200_000)
  const relays = [new Relay({ host: "127.0.0.1" }), new Relay({ host: "127.0.0.1" }), new Relay({ host: "127.0.0.1" })]
  for (const relay of relays) await relay.start()
  for (const relay of relays) opts.tap?.(relay)
  const endpoints = relays.map((relay) => relay.endpoint)
  const failing = opts.known === "other"
  const receiverOpts = { session: secret, relays: endpoints }
  let receiver = new TeseraReceiver(receiverOpts)
  let sender: TeseraSender | null = null
  try {
    const receiverAt = await receiver.start()
    sender = new TeseraSender({
      session: secret,
      receiver: receiverAt,
      relays: endpoints,
      ...(failing ? { maxSends: 4, retxAfterMs: 20, idleMs: 300 } : {}),
    })
    if (opts.known !== "none") {
      await receiver.close()
      const sessionId = opts.known === "matching" ? sender.sessionId : randomBytes(16)
      receiver = new TeseraReceiver({ ...receiverOpts, sessionId, bindPort: receiverAt.port })
      await receiver.start()
    }
    const senderAt = await sender.start()
    receiver.setSender(senderAt)

    const reading = (async () => {
      const chunks: Buffer[] = []
      for (;;) {
        const chunk = await receiver.read()
        if (!chunk) return Buffer.concat(chunks)
        chunks.push(Buffer.from(chunk))
      }
    })()
    let senderError: unknown = null
    try {
      await sender.write(payload)
      await sender.end()
    } catch (err) {
      senderError = err
    }
    let received: Buffer | null = null
    if (senderError) {
      await receiver.close()
      await reading.catch(() => {})
    } else {
      received = await reading
    }
    return { sessionId: sender.sessionId, sent: sha256(payload), received: received && sha256(received), senderError }
  } finally {
    await sender?.close()
    await receiver.close()
    for (const relay of relays) await relay.close()
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
