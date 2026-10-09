import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { memorySink, TeseraClient, TeseraError, type Progress, type SinkWriter, type Source } from "../src/index.js"
import { DEFAULT_WINDOW, PROTOCOL_VERSION } from "../../../src/constants.js"
import { CHUNK_BYTES } from "../src/source.js"
import { memoryWorld, type MemoryWorld } from "./memory-transport.js"

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A sink that keeps what it is given and can be slowed down or made to fail. */
function collect(opts: { delayMs?: number; failAt?: number; onWrite?: (written: number) => void } = {}) {
  const parts: Uint8Array[] = []
  let written = 0
  let closed = false
  let aborted: unknown = null
  const sink: SinkWriter = {
    async write(chunk) {
      if (opts.failAt !== undefined && written + chunk.length > opts.failAt) throw new Error("disk full")
      if (opts.delayMs) await sleep(opts.delayMs)
      parts.push(chunk.slice())
      written += chunk.length
      opts.onWrite?.(written)
    },
    close() {
      closed = true
    },
    abort(reason) {
      aborted = reason
    },
  }
  return { sink, bytes: () => Buffer.concat(parts), written: () => written, closed: () => closed, aborted: () => aborted }
}

/** An async source of `size` random bytes that counts how much has been pulled from it. */
function counted(payload: Uint8Array, opts: { failAt?: number; onPull?: (pulled: number) => void } = {}) {
  let pulled = 0
  let returned = false
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (opts.failAt !== undefined && pulled >= opts.failAt) throw new Error("read error")
          if (pulled >= payload.length) return { done: true, value: undefined }
          const chunk = payload.subarray(pulled, pulled + 16 * 1024)
          pulled += chunk.length
          opts.onPull?.(pulled)
          return { done: false, value: chunk }
        },
        async return() {
          returned = true
          return { done: true, value: undefined }
        },
      }
    },
  }
  return { source, pulled: () => pulled, returned: () => returned }
}

async function pair(
  world: MemoryWorld,
  source: Source,
  opts: {
    senderPacket?: number
    receiverPacket?: number
    sink?: SinkWriter
    maxBufferedBytes?: number
    onSendProgress?: (p: Progress) => void
    onRecvProgress?: (p: Progress) => void
    sendSignal?: AbortSignal
  } = {},
) {
  const sendTransport = world.transport(opts.senderPacket)
  const recvTransport = world.transport(opts.receiverPacket)
  const sender = new TeseraClient({ transport: sendTransport })
  const receiver = new TeseraClient({ transport: recvTransport })
  const out = collect()
  const outgoing = await sender.send(source, {
    relays: world.relays.map((r) => r.endpoint),
    hash: true,
    onProgress: opts.onSendProgress,
    signal: opts.sendSignal,
  })
  const incoming = await receiver.receive({
    offer: JSON.parse(JSON.stringify(outgoing.offer)),
    secret: outgoing.secret,
    sink: opts.sink ?? out.sink,
    hash: true,
    onProgress: opts.onRecvProgress,
    maxBufferedBytes: opts.maxBufferedBytes,
  })
  return { outgoing, incoming, out, sendTransport, recvTransport }
}

async function settled(check: () => boolean, ms = 4000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await sleep(20)
  }
  return check()
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof TeseraError, `expected a TeseraError, got ${String(err)}`)
    assert.equal(err.code, code, err.message)
    return true
  })
}

async function withWorld(run: (world: MemoryWorld) => Promise<void>, relays = 3): Promise<void> {
  const world = await memoryWorld(relays)
  try {
    await run(world)
  } finally {
    await world.close()
  }
}

describe("TeseraClient over a custom transport", () => {
  it("streams a file through 3 relays and reports progress in file bytes", async () => {
    await withWorld(async (world) => {
      const payload = randomBytes(3_000_000)
      const sendProgress: Progress[] = []
      const recvProgress: Progress[] = []
      const { outgoing, incoming, out, sendTransport, recvTransport } = await pair(world, payload, {
        onSendProgress: (p) => sendProgress.push(p),
        onRecvProgress: (p) => recvProgress.push(p),
      })
      assert.deepEqual([outgoing.offer.k, outgoing.offer.n, outgoing.offer.size], [2, 3, payload.length])
      const [sent, received] = await Promise.all([outgoing.start(incoming.answer), incoming.done])
      assert.equal(received.bytes, payload.length)
      assert.equal(received.sha256, sha(payload))
      assert.equal(sent.sha256, sha(payload))
      assert.ok(out.bytes().equals(payload))
      assert.ok(out.closed())
      for (const progress of [sendProgress, recvProgress]) {
        const last = progress.at(-1)
        assert.deepEqual(last, { bytes: payload.length, total: payload.length, done: true })
        assert.equal(progress.filter((p) => p.done).length, 1)
        for (let i = 1; i < progress.length; i++) assert.ok((progress[i]?.bytes ?? 0) >= (progress[i - 1]?.bytes ?? 0))
      }
      assert.ok(await settled(() => sendTransport.open() === 0 && recvTransport.open() === 0))
    })
  })

  it("finishes over 2 of 3 relays when one is gone", async () => {
    await withWorld(async (world) => {
      const payload = randomBytes(1_000_000)
      await world.relays[1]?.close()
      const { outgoing, incoming } = await pair(world, payload)
      const [, received] = await Promise.all([outgoing.start(incoming.answer), incoming.done])
      assert.equal(received.sha256, sha(payload))
    })
  })

  it("streams an async source with unknown size", async () => {
    await withWorld(async (world) => {
      const payload = randomBytes(500_000)
      const { source } = counted(payload)
      const { outgoing, incoming } = await pair(world, source)
      assert.equal(outgoing.offer.size, undefined)
      const [, received] = await Promise.all([outgoing.start(incoming.answer), incoming.done])
      assert.equal(received.sha256, sha(payload))
    })
  })

  for (const [senderPacket, receiverPacket] of [
    [65535, 700],
    [700, 65535],
    [900, 600],
  ] as const) {
    it(`fits shards to the smaller packet limit, sender ${senderPacket} and receiver ${receiverPacket}`, async () => {
      await withWorld(async (world) => {
        const payload = randomBytes(300_000)
        const { outgoing, incoming } = await pair(world, payload, { senderPacket, receiverPacket })
        assert.equal(incoming.answer.maxPacketSize, receiverPacket)
        const [, received] = await Promise.all([outgoing.start(incoming.answer), incoming.done])
        assert.equal(received.sha256, sha(payload))
        const datagram = outgoing.diagnostics()["datagramSize"] ?? Infinity
        assert.ok(datagram <= Math.min(senderPacket, receiverPacket), `datagram ${datagram}`)
      })
    })
  }

  it("gathers blocks into fewer sink writes, and still writes a trickle soon", async () => {
    await withWorld(async (world) => {
      const payload = randomBytes(1_000_000)
      const sizes: number[] = []
      const sink: SinkWriter = { write: (chunk) => void sizes.push(chunk.length) }
      const { outgoing, incoming } = await pair(world, payload, { sink })
      const [, received] = await Promise.all([outgoing.start(incoming.answer), incoming.done])
      assert.equal(received.sha256, sha(payload))
      const blocks = outgoing.diagnostics()["blocks"] ?? 0
      assert.ok(sizes.length * 4 < blocks, `${sizes.length} writes for ${blocks} blocks`)
      assert.ok(Math.max(...sizes) <= 256 * 1024 + 2023)
    })
    await withWorld(async (world) => {
      const sizes: number[] = []
      const sink: SinkWriter = { write: (chunk) => void sizes.push(chunk.length) }
      let release = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      const source: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          yield randomBytes(10_000)
          await held
        },
      }
      const { outgoing, incoming } = await pair(world, source, { sink })
      const done = Promise.all([outgoing.start(incoming.answer), incoming.done])
      try {
        const written = () => sizes.reduce((sum, n) => sum + n, 0)
        assert.ok(await settled(() => written() >= 4 * 2023, 2000), `${written()} bytes reached the sink`)
      } finally {
        release()
      }
      await done
    })
  })

  it("bounds reading ahead and buffered output behind a slow sink", async () => {
    await withWorld(async (world) => {
      const payload = randomBytes(8_000_000)
      const input = counted(payload)
      const slow = collect({ delayMs: 2 })
      const maxBufferedBytes = 64 * 1024
      let worstAhead = 0
      const { outgoing, incoming } = await pair(world, input.source, { sink: slow.sink, maxBufferedBytes })
      const probe = setInterval(() => {
        worstAhead = Math.max(worstAhead, input.pulled() - slow.written())
      }, 5)
      const [, received] = await Promise.all([outgoing.start(incoming.answer), incoming.done])
      clearInterval(probe)
      assert.equal(received.sha256, sha(payload))
      // The sender holds at most its window of blocks plus a source chunk; the receiver its limit plus that
      // window, and one sink write's gathering, which is at most the limit again.
      const window = DEFAULT_WINDOW * 2023
      assert.ok(worstAhead <= 2 * maxBufferedBytes + 2 * window + 2 * CHUNK_BYTES, `read ${worstAhead} bytes ahead of the sink`)
      const unread = incoming.diagnostics()["maxUnreadBytes"] ?? Infinity
      assert.ok(unread <= maxBufferedBytes + window + 2023, `receiver held ${unread} unread bytes`)
    })
  })
})

describe("cancellation", () => {
  it("before any data, on both ends", async () => {
    await withWorld(async (world) => {
      const input = counted(randomBytes(200_000))
      const { outgoing, incoming, out, sendTransport, recvTransport } = await pair(world, input.source)
      outgoing.cancel()
      incoming.cancel()
      await rejectsWith(outgoing.done, "cancelled")
      await rejectsWith(incoming.done, "cancelled")
      await rejectsWith(outgoing.start(incoming.answer), "cancelled")
      assert.equal(input.pulled(), 0)
      assert.ok(input.returned())
      assert.ok(out.aborted() instanceof TeseraError)
      assert.ok(await settled(() => sendTransport.open() === 0 && recvTransport.open() === 0))
    })
  })

  for (const [name, at] of [
    ["mid-transfer", 0.3],
    ["near completion", 0.9],
  ] as const) {
    it(`${name}, from the sender through an AbortSignal`, async () => {
      await withWorld(async (world) => {
        const payload = randomBytes(4_000_000)
        const abort = new AbortController()
        // Progress reports are throttled, so the source read, not a report, decides when to cancel.
        const input = counted(payload, { onPull: (pulled) => pulled >= payload.length * at && abort.abort() })
        const { outgoing, incoming, sendTransport } = await pair(world, input.source, {
          sendSignal: abort.signal,
          sink: collect({ delayMs: 1 }).sink,
        })
        await rejectsWith(outgoing.start(incoming.answer), "cancelled")
        const pulled = input.pulled()
        await sleep(200)
        assert.equal(input.pulled(), pulled, "the source was read after cancelling")
        assert.ok(pulled < payload.length)
        assert.ok(input.returned())
        assert.ok(await settled(() => sendTransport.open() === 0))
        incoming.cancel()
        await rejectsWith(incoming.done, "cancelled")
      })
    })

    it(`${name}, from the receiver`, async () => {
      await withWorld(async (world) => {
        const payload = randomBytes(4_000_000)
        let incomingRef: { cancel(): void } | null = null
        const sink = collect({ delayMs: 1, onWrite: (written) => written >= payload.length * at && incomingRef?.cancel() })
        const { outgoing, incoming, recvTransport } = await pair(world, payload, { sink: sink.sink })
        incomingRef = incoming
        void outgoing.start(incoming.answer)
        await rejectsWith(incoming.done, "cancelled")
        assert.ok(sink.aborted() instanceof TeseraError)
        assert.ok(!sink.closed())
        assert.ok(await settled(() => recvTransport.open() === 0))
        // Near completion the sender may already hold every acknowledgement and have finished.
        outgoing.cancel()
        await outgoing.done.catch((err) => assert.equal((err as TeseraError).code, "cancelled"))
      })
    })
  }

  // Each sink cancels the receiver at one point of its own work, so the moment doesn't depend on timing.
  const moments: [string, (at: { payload: number; written: number; chunk: number }) => "before" | "after" | null][] = [
    ["during a sink write", ({ written, payload }) => (written >= payload / 2 && written < payload / 2 + 300_000 ? "before" : null)],
    ["during the final sink write", ({ written, chunk, payload }) => (written + chunk === payload ? "before" : null)],
    ["right before the sink closes", ({ written, chunk, payload }) => (written + chunk === payload ? "after" : null)],
  ]
  for (const [name, when] of moments) {
    it(`${name}, from the receiver`, async () => {
      await withWorld(async (world) => {
        const payload = randomBytes(1_000_000)
        const sink = collect()
        let incomingRef: { cancel(): void } | null = null
        let written = 0
        const hooked: SinkWriter = {
          async write(chunk) {
            const at = when({ payload: payload.length, written, chunk: chunk.length })
            if (at === "before") incomingRef?.cancel()
            await sink.sink.write(chunk)
            written += chunk.length
            if (at === "after") incomingRef?.cancel()
          },
          close: () => sink.sink.close?.(),
          abort: (reason) => sink.sink.abort?.(reason),
        }
        const done: Progress[] = []
        const { outgoing, incoming } = await pair(world, payload, { sink: hooked, onRecvProgress: (p) => p.done && done.push(p) })
        incomingRef = incoming
        void outgoing.start(incoming.answer).catch(() => {})
        await rejectsWith(incoming.done, "cancelled")
        assert.ok(!sink.closed(), "a cancelled transfer closed its sink")
        assert.ok(sink.aborted() instanceof TeseraError)
        assert.equal(done.length, 0, "a cancelled transfer reported completion")
        outgoing.cancel()
      })
    })
  }

  it("while the sink closes, from the receiver", async () => {
    await withWorld(async (world) => {
      const sink = collect()
      let incomingRef: { cancel(): void } | null = null
      const hooked: SinkWriter = {
        write: (chunk) => sink.sink.write(chunk),
        async close() {
          incomingRef?.cancel()
          await sink.sink.close?.()
        },
        abort: (reason) => sink.sink.abort?.(reason),
      }
      const { outgoing, incoming } = await pair(world, randomBytes(300_000), { sink: hooked })
      incomingRef = incoming
      void outgoing.start(incoming.answer).catch(() => {})
      await rejectsWith(incoming.done, "cancelled")
      outgoing.cancel()
    })
  })

  it("after the transfer finished, changes nothing", async () => {
    await withWorld(async (world) => {
      const payload = randomBytes(300_000)
      const { outgoing, incoming, out } = await pair(world, payload)
      const [, received] = await Promise.all([outgoing.start(incoming.answer), incoming.done])
      incoming.cancel()
      outgoing.cancel()
      assert.equal(received.sha256, sha(payload))
      assert.deepEqual(await incoming.done, received)
      assert.ok(out.closed())
      assert.equal(out.aborted(), null)
    })
  })
})

describe("package bundle", () => {
  it("keeps node built-ins out and takes its crypto from @noble", () => {
    const bundle = readFileSync(new URL("../index.js", import.meta.url), "utf8")
    assert.doesNotMatch(bundle, /["']node:/)
    assert.doesNotMatch(bundle, /\brequire\(/)
    assert.match(bundle, /@noble\/ciphers\/chacha\.js/)
    assert.doesNotMatch(bundle, /createCipheriv|createSocket/)
  })

  it("names the protocol it speaks and ships the repository's license", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
    assert.equal(pkg.tesera.protocol, PROTOCOL_VERSION)
    assert.equal(pkg.repository.directory, "packages/client")
    assert.equal(
      readFileSync(new URL("../../LICENSE", import.meta.url), "utf8"),
      readFileSync(new URL("../../../../LICENSE", import.meta.url), "utf8"),
    )
  })
})

describe("errors", () => {
  it("reports a failing source as a source error", async () => {
    await withWorld(async (world) => {
      const input = counted(randomBytes(1_000_000), { failAt: 300_000 })
      const { outgoing, incoming, sendTransport } = await pair(world, input.source)
      await rejectsWith(outgoing.start(incoming.answer), "source")
      assert.ok(await settled(() => sendTransport.open() === 0))
      incoming.cancel()
    })
  })

  it("reports a failing sink as a sink error", async () => {
    await withWorld(async (world) => {
      const sink = collect({ failAt: 200_000 })
      const { outgoing, incoming, recvTransport } = await pair(world, randomBytes(1_000_000), { sink: sink.sink })
      void outgoing.start(incoming.answer).catch(() => {})
      await rejectsWith(incoming.done, "sink")
      assert.ok(await settled(() => recvTransport.open() === 0))
      outgoing.cancel()
    })
  })

  it("fails a memory sink past its limit with a sink error", async () => {
    await withWorld(async (world) => {
      const memory = memorySink({ maxBytes: 100_000 })
      const { outgoing, incoming } = await pair(world, randomBytes(300_000), { sink: memory.sink })
      void outgoing.start(incoming.answer).catch(() => {})
      await rejectsWith(incoming.done, "sink")
      outgoing.cancel()
    })
  })

  it("collects into a memory sink within its limit", async () => {
    await withWorld(async (world) => {
      const payload = randomBytes(300_000)
      const memory = memorySink({ maxBytes: 1_000_000 })
      const { outgoing, incoming } = await pair(world, payload, { sink: memory.sink })
      await Promise.all([outgoing.start(incoming.answer), incoming.done])
      assert.ok(Buffer.from(await memory.blob().arrayBuffer()).equals(payload))
    })
  })

  it("refuses malformed offers, answers, and secrets", async () => {
    await withWorld(async (world) => {
      const client = new TeseraClient({ transport: world.transport() })
      const outgoing = await client.send(randomBytes(10), { relays: world.relays.map((r) => r.endpoint) })
      const sink = collect().sink
      await rejectsWith(client.receive({ offer: { ...outgoing.offer, sessionId: "zz" }, secret: outgoing.secret, sink }), "invalid")
      await rejectsWith(client.receive({ offer: { ...outgoing.offer, relays: [] }, secret: outgoing.secret, sink }), "invalid")
      await rejectsWith(client.receive({ offer: { ...outgoing.offer, v: 9 as 1 }, secret: outgoing.secret, sink }), "incompatible")
      await rejectsWith(client.receive({ offer: outgoing.offer, secret: "00", sink }), "invalid")
      await rejectsWith(
        outgoing.start({ v: 1, sessionId: "00".repeat(16), receiver: { host: "127.0.0.1", port: 1 }, maxPacketSize: 1200 }),
        "invalid",
      )
      await rejectsWith(client.send(randomBytes(10), { relays: [] }), "invalid")
      await rejectsWith(client.send(randomBytes(10), { relays: world.relays.map((r) => r.endpoint), coding: { k: 3, n: 2 } }), "invalid")
    })
  })

  it("keeps the secret out of the offer and the answer", async () => {
    await withWorld(async (world) => {
      const { outgoing, incoming } = await pair(world, randomBytes(10))
      assert.match(outgoing.secret, /^[0-9a-f]{64}$/)
      assert.doesNotMatch(JSON.stringify(outgoing.offer), new RegExp(outgoing.secret))
      assert.doesNotMatch(JSON.stringify(incoming.answer), new RegExp(outgoing.secret))
      outgoing.cancel()
      incoming.cancel()
    })
  })
})
