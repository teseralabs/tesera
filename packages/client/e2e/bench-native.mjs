// A native tesera endpoint for the benchmark: TeseraSender or TeseraReceiver from this repository's
// dist, on its own UDP socket, in its own process. It reads its config from the harness and carries
// the offer and the answer through the harness's signal endpoints, as the bench page does.
//
//   node e2e/bench-native.mjs --role send|recv --harness http://127.0.0.1:PORT
import { createHash } from "node:crypto"
import { createSocket } from "node:dgram"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { parseArgs } from "node:util"
import { createProbe } from "./bench-probe.js"
import { payload } from "./payload.js"

const { values: args } = parseArgs({ options: { role: { type: "string" }, harness: { type: "string" } } })
const dist = new URL("../../../dist/src/", import.meta.url)
const { TeseraSender } = await import(new URL("transport/sender.js", dist).href)
const { TeseraReceiver } = await import(new URL("transport/receiver.js", dist).href)
const { MAX_FORWARD_DATAGRAM } = await import(new URL("constants.js", dist).href)
const call = (path, body) =>
  fetch(`${args.harness}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const poll = async (path) => {
  for (;;) {
    const answer = await call(path)
    if (answer.status === 200) return answer.json()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
const config = await (await call("/config")).json()
const probe = config.probe ? createProbe() : null
const loop = monitorEventLoopDelay({ resolution: 1 })
loop.enable()
const cpu0 = process.cpuUsage()

/** A bound UDP socket as a tesera transport. Sends wait `delayMs` (plus jitter) and some may be dropped. */
async function socketTransport() {
  const socket = createSocket({ type: "udp4" })
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve))
  socket.setRecvBufferSize(4 << 20)
  socket.setSendBufferSize(4 << 20)
  const endpoint = { host: "127.0.0.1", port: socket.address().port }
  const { delayMs = 0, jitterMs = 0, loss = 0 } = config.native ?? {}
  const open = async (events) => {
    socket.on("message", (msg, rinfo) => events.packet(msg, { host: rinfo.address, port: rinfo.port }))
    socket.on("error", (err) => events.error(err))
    const now = (packet, to) => new Promise((resolve, reject) => socket.send(packet, to.port, to.host, (err) => (err ? reject(err) : resolve())))
    return {
      endpoint,
      maxPacketSize: config.nativeMaxPacket ?? MAX_FORWARD_DATAGRAM,
      send: (packet, to) => {
        if (loss > 0 && Math.random() < loss) return Promise.resolve()
        if (delayMs <= 0 && jitterMs <= 0) return now(packet, to)
        const copy = Buffer.from(packet)
        setTimeout(() => void now(copy, to).catch(() => {}), delayMs + Math.random() * jitterMs)
        return Promise.resolve()
      },
      close: () => new Promise((resolve) => socket.close(() => resolve())),
    }
  }
  return { endpoint, open }
}

function finish(extra) {
  loop.disable()
  const used = process.cpuUsage(cpu0)
  return {
    ...extra,
    cpuSeconds: (used.user + used.system) / 1e6,
    eventLoopDelayMs: { mean: loop.mean / 1e6, p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    rssMB: process.memoryUsage().rss / 1e6,
    heapMB: process.memoryUsage().heapUsed / 1e6,
    probe: probe?.summary() ?? null,
  }
}

try {
  if (args.role === "send") {
    const { endpoint, open } = await socketTransport()
    const secret = Buffer.alloc(32)
    globalThis.crypto.getRandomValues(secret)
    const sender = new TeseraSender({
      session: secret,
      relays: config.relays,
      k: config.coding?.k ?? 2,
      n: config.coding?.n ?? 3,
      transport: open,
      ...(config.window ? { window: config.window } : {}),
      ...(config.shard ? { shardSize: config.shard } : {}),
      ...(probe ? { probe } : {}),
    })
    const offer = { v: 1, sessionId: sender.sessionId.toString("hex"), sender: endpoint, relays: config.relays, k: config.coding?.k ?? 2, n: config.coding?.n ?? 3, size: config.size }
    await call("/signal/offer", { offer, secret: secret.toString("hex") })
    const answer = await poll("/signal/answer")
    sender.setReceiver(answer.receiver, answer.maxPacketSize)
    await sender.start()
    const t0 = performance.now()
    const bytes = payload(config.seed, config.size)
    for (let chunk = bytes.next(1 << 20); chunk; chunk = bytes.next(1 << 20)) await sender.write(chunk)
    await sender.end()
    const seconds = (performance.now() - t0) / 1000
    const report = finish({ role: "send", bytes: config.size, seconds, diagnostics: { ...sender.stats, datagramSize: sender.datagramSize }, userAgent: `node ${process.version}` })
    await sender.close()
    await call("/report", report)
  } else {
    const { offer, secret } = await poll("/signal/offer")
    const { endpoint, open } = await socketTransport()
    const receiver = new TeseraReceiver({
      session: Buffer.from(secret, "hex"),
      sessionId: Buffer.from(offer.sessionId, "hex"),
      relays: offer.relays,
      sender: offer.sender,
      transport: open,
      maxUnreadBytes: config.maxBufferedBytes ?? 2 * 1024 * 1024,
      ...(probe ? { probe } : {}),
    })
    await receiver.start()
    await call("/signal/answer", { v: 1, sessionId: offer.sessionId, receiver: endpoint, maxPacketSize: config.nativeMaxPacket ?? MAX_FORWARD_DATAGRAM })
    const hash = createHash("sha256")
    let total = 0
    let first = 0
    let lastAt = 0
    const timeline = []
    for (let chunk = await receiver.read(); chunk; chunk = await receiver.read()) {
      const now = performance.now()
      if (!first) first = now
      hash.update(chunk)
      total += chunk.length
      if (now - lastAt >= 100) {
        lastAt = now
        timeline.push([Math.round(now), total])
      }
    }
    timeline.push([Math.round(performance.now()), total])
    const seconds = (performance.now() - first) / 1000
    const report = finish({ role: "recv", bytes: total, sha256: hash.digest("hex"), seconds, firstAt: Math.round(first), timeline, diagnostics: { ...receiver.stats, ...receiver.recoveryCounts() }, userAgent: `node ${process.version}` })
    await call("/report", report)
    await receiver.linger()
    await receiver.close()
  }
  process.exit(0)
} catch (err) {
  await call("/failed", { role: args.role, message: String(err?.stack ?? err) }).catch(() => {})
  process.exit(1)
}
