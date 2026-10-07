// One attachment relay for the e2e run: tesera's production Relay and WebTransportListener from the
// repository's dist, wired as `tesera relay --webtransport` wires them, with a self-signed certificate
// from the same generator. With --capture, every datagram it sends or receives, on UDP or on
// WebTransport, is appended to a file for the leak scan: tag u8 | length u32 | bytes.
//
// With --delay-ms, --jitter-ms, or --loss, its UDP sends are held or dropped, which stands in for
// a network between it and the UDP relays. Every path crosses that leg twice per round trip.
//
// It prints one JSON line when ready, and one more with its counters when it gets SIGTERM.
import { closeSync, openSync, writeSync } from "node:fs"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
  options: {
    dist: { type: "string", default: new URL("../../../dist/src/", import.meta.url).pathname },
    capture: { type: "string" },
    bandwidth: { type: "string", default: "0" },
    "delay-ms": { type: "string", default: "0" },
    "jitter-ms": { type: "string", default: "0" },
    loss: { type: "string", default: "0" },
  },
})
const load = (path) => import(new URL(path, `file://${args.dist}`).href)
const { Relay } = await load("relay/relay.js")
const { WebTransportListener } = await load("attach/listener.js")
const { generateSelfSigned } = await load("attach/cert.js")
const { generateIdentity } = await load("identity/id.js")

const TAGS = { "udp-in": 0, "wt-in": 1, "udp-out": 2, "wt-out": 3 }
const file = args.capture ? openSync(args.capture, "w") : null
const record = (dir, bytes) => {
  if (file === null) return
  const head = Buffer.alloc(5)
  head.writeUInt8(TAGS[dir], 0)
  head.writeUInt32BE(bytes.length, 1)
  writeSync(file, head)
  writeSync(file, bytes)
}

const lines = []
const cert = generateSelfSigned()
const listener = new WebTransportListener({ host: "127.0.0.1", port: 0, cert, capture: file === null ? undefined : record, log: (line) => lines.push(line), logLevel: "info" })
const relay = new Relay({
  host: "127.0.0.1",
  identity: generateIdentity(),
  allowRemote: true,
  allowDest: ["127.0.0.0/8"],
  policy: { access: "open", bandwidthBps: Number(args.bandwidth), maxSessions: 0, peerRatePerMin: 0, datagramRatePerSec: 0 },
  log: (line) => lines.push(line),
  logLevel: "info",
  localDelivery: listener.localDelivery,
})
await relay.start()
await listener.start(relay)
const loop = monitorEventLoopDelay({ resolution: 1 })
loop.enable()
const cpu0 = process.cpuUsage()
const counts = { udpIn: 0, udpOut: 0, udpOutDropped: 0 }
{
  const socket = relay["socket"]
  socket.on("message", () => counts.udpIn++)
  const delayMs = Number(args["delay-ms"])
  const jitterMs = Number(args["jitter-ms"])
  const loss = Number(args.loss)
  const send = socket.send.bind(socket)
  socket.send = (msg, ...rest) => {
    counts.udpOut++
    if (loss > 0 && Math.random() < loss) {
      counts.udpOutDropped++
      const done = rest.find((value) => typeof value === "function")
      if (done) queueMicrotask(() => done(null))
      return
    }
    if (delayMs <= 0 && jitterMs <= 0) return send(msg, ...rest)
    const copy = Buffer.from(msg)
    setTimeout(() => send(copy, ...rest), delayMs + Math.random() * jitterMs)
  }
}
if (file !== null) {
  const socket = relay["socket"]
  socket.on("message", (msg) => record("udp-in", msg))
  const send = socket.send.bind(socket)
  socket.send = (msg, ...rest) => {
    record("udp-out", msg)
    return send(msg, ...rest)
  }
}
console.log(JSON.stringify({ udp: relay.endpoint, webtransport: listener.endpoint, certificateHash: cert.hash.toString("hex") }))

process.on("SIGTERM", async () => {
  loop.disable()
  const used = process.cpuUsage(cpu0)
  const perf = {
    cpuSeconds: (used.user + used.system) / 1e6,
    eventLoopDelayMs: { mean: loop.mean / 1e6, p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    counts,
    rssMB: process.memoryUsage().rss / 1e6,
  }
  const report = { attach: listener.stats, relay: relay.report(), live: { attachments: listener.attachments.size, sessions: listener.attachments.sessions }, perf, log: lines }
  await listener.close()
  await relay.close()
  if (file !== null) closeSync(file)
  console.log(JSON.stringify(report))
  process.exit(0)
})
