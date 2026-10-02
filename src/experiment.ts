import { randomBytes } from "node:crypto"
import { buildMetrics, type TransferMetrics } from "./metrics.js"
import { Relay } from "./relay/relay.js"
import { CorrelatedGate, fillAdversity, PathSim, type Adversity } from "./sim/network.js"
import { TeseraReceiver } from "./transport/receiver.js"
import { TeseraSender } from "./transport/sender.js"
import { asError, concatBytes, mulberry32, sleep } from "./util.js"
import {
  DEFAULT_NACK_AFTER_MS,
  DEFAULT_RETX_AFTER_MS,
  DEFAULT_WINDOW,
} from "./constants.js"

/**
 * The k required tesserae prefer the lowest-cost relays. Parity is sent on a
 * spare relay only when its delay is comparable. When later tesserae show the
 * relays sharing one queue, data tesserae keep rotating across relays and
 * parity waits until a relay misses. If every path in a block fails
 * and failures have not been split across paths, later blocks stay on the best
 * path. A later block that fails on only some paths resumes sharing. ACK/NACK frames are copied to
 * every relay so one dead path cannot stall repair. Each relay has its own
 * adversity. `shared` is one more pipe in front of all of them.
 * `correlatedLoss` drops every data tessera that arrives inside the same
 * short window, so a burst shares a fate.
 */
export type RunOptions = {
  payload: Uint8Array
  k?: number
  n?: number
  relays?: number
  adversity?: Partial<Adversity> | Array<Partial<Adversity>>
  shared?: Partial<Adversity>
  correlatedLoss?: number
  seed?: number
  window?: number
  shardSize?: number
  maxSends?: number
  nackAfterMs?: number
  retxAfterMs?: number
  deadlineMs?: number
  session?: Buffer
  tapRelays?: (relays: Relay[]) => void
}

export type TransferResult = {
  output: Buffer
  metrics: TransferMetrics
}

export function timersFromAdversity(
  items: Adversity[],
  extra?: { shared?: Adversity; window?: number },
): { nackAfterMs: number; retxAfterMs: number } {
  let slack = 0
  for (const item of items) slack = Math.max(slack, item.delayMs + item.jitterMs + item.reorderMs)
  const window = extra?.window ?? DEFAULT_WINDOW
  const packetBits = 1200 * 8
  // Each in-flight block also returns a sample and an ack on the same pipe.
  const packetsPerSlot = 3
  let queueMs = 0
  for (const item of items) {
    if (item.bandwidthBps > 0) {
      queueMs = Math.max(queueMs, (window * packetsPerSlot * packetBits * 1000) / item.bandwidthBps)
    }
  }
  if (extra?.shared && extra.shared.bandwidthBps > 0) {
    queueMs += (window * Math.max(items.length, 1) * packetBits * 1000) / extra.shared.bandwidthBps
  }
  return {
    nackAfterMs: slack + queueMs + DEFAULT_NACK_AFTER_MS,
    retxAfterMs: slack + queueMs * 2 + DEFAULT_RETX_AFTER_MS,
  }
}

function expandAdversity(
  input: Partial<Adversity> | Array<Partial<Adversity>> | undefined,
  count: number,
): Adversity[] {
  if (Array.isArray(input)) {
    if (input.length !== count) {
      throw new Error(`expected ${count} adversity entries, got ${input.length}`)
    }
    return input.map((item) => fillAdversity(item))
  }
  const shared = fillAdversity(input)
  return Array.from({ length: count }, () => ({ ...shared }))
}

export async function runTransfer(opts: RunOptions): Promise<TransferResult> {
  const k = opts.k ?? 2
  const n = opts.n ?? 3
  const relayCount = opts.relays ?? n
  if (!Number.isInteger(relayCount) || relayCount < 1) throw new Error("need at least one relay")
  const seed = opts.seed ?? 1
  const adversity = expandAdversity(opts.adversity, relayCount)
  const sharedAdversity = opts.shared ? fillAdversity(opts.shared) : undefined
  const computed = timersFromAdversity(adversity, {
    shared: sharedAdversity,
    window: opts.window ?? DEFAULT_WINDOW,
  })
  const shared = sharedAdversity ? PathSim.from(sharedAdversity, seed + 50_000) : undefined
  const correlated =
    opts.correlatedLoss && opts.correlatedLoss > 0
      ? new CorrelatedGate(opts.correlatedLoss, mulberry32(seed + 60_000), 25)
      : undefined
  const session = opts.session ?? randomBytes(32)
  const relays: Relay[] = []
  let sender: TeseraSender | undefined
  let receiver: TeseraReceiver | undefined
  let readerDone: Promise<{ ok: true; output: Buffer } | { ok: false; err: unknown }> = Promise.resolve({
    ok: true,
    output: Buffer.alloc(0),
  })

  try {
    for (let index = 0; index < relayCount; index++) {
      const relay = new Relay({
        adversity: adversity[index],
        seed: seed + index * 9973,
        shared,
        correlated,
      })
      await relay.start()
      relays.push(relay)
    }
    opts.tapRelays?.(relays)
    const relayEndpoints = relays.map((relay) => relay.endpoint)
    receiver = new TeseraReceiver({
      session,
      relays: relayEndpoints,
      nackAfterMs: opts.nackAfterMs ?? computed.nackAfterMs,
    })
    await receiver.start()
    sender = new TeseraSender({
      session,
      relays: relayEndpoints,
      receiver: receiver.endpoint,
      k,
      n,
      window: opts.window,
      shardSize: opts.shardSize,
      maxSends: opts.maxSends,
      retxAfterMs: opts.retxAfterMs ?? computed.retxAfterMs,
      deadlineMs: opts.deadlineMs,
    })
    await sender.start()
    receiver.setSender(sender.endpoint)
    sender.onPeerFail = (err) => receiver?.fail(err)
    receiver.onPeerFail = (err) => sender?.fail(err)

    const chunks: Uint8Array[] = []
    const activeReceiver = receiver
    const reader = (async () => {
      for (;;) {
        const chunk = await activeReceiver.read()
        if (!chunk) return concatBytes(chunks)
        chunks.push(chunk)
      }
    })()
    readerDone = reader.then(
      (output) => ({ ok: true as const, output }),
      (err: unknown) => ({ ok: false as const, err }),
    )

    const started = performance.now()
    await sender.write(opts.payload)
    await sender.end()
    const settled = await readerDone
    if (!settled.ok) throw asError(settled.err)
    const output = settled.output
    const elapsedMs = performance.now() - started
    const tailMs = adversity.reduce(
      (max, item) => Math.max(max, item.delayMs + item.jitterMs + item.reorderMs),
      0,
    )
    await sleep(20 + tailMs)
    const recovery = receiver.recoveryCounts()
    receiver.stats.blocksMissingSystematic = recovery.blocksMissingSystematic
    receiver.stats.blocksWithoutAllTesserae = recovery.blocksWithoutAllTesserae
    if (Buffer.compare(output, Buffer.from(opts.payload)) !== 0) {
      throw new Error("reconstructed bytes do not match the input")
    }
    const metrics = buildMetrics(
      sender.stats,
      receiver.stats,
      relays.map((relay) => ({ ...relay.stats })),
      elapsedMs,
    )
    return { output, metrics }
  } catch (err) {
    sender?.fail(err)
    receiver?.fail(err)
    await readerDone
    throw asError(err)
  } finally {
    await sender?.close()
    await receiver?.close()
    for (const relay of relays) await relay.close()
  }
}
