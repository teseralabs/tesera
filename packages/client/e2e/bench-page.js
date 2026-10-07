// The benchmark page. It attaches straight to one WebTransport relay, with no control plane, and
// the harness carries the offer and the answer. `?role=send` reads a payload from the origin
// private file system; `?role=recv` writes to it, or with `sink: "null"` only hashes. Every
// datagram the page sends or receives is timed, and the core's probe notes are summed.
import { sha256 } from "@noble/hashes/sha2.js"
import { TeseraClient, webTransport } from "../src/index.js"
import { createProbe } from "./bench-probe.js"
import { payload } from "./payload.js"

const role = new URLSearchParams(location.search).get("role")
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const poll = async (path) => {
  for (;;) {
    const answer = await fetch(path)
    if (answer.status === 200) return answer.json()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The transport, timing each send and the gap between arrivals. */
function timed(transport, probe) {
  return {
    name: transport.name,
    connect: async (events, signal, hints) => {
      let last = 0
      const connection = await transport.connect(
        {
          packet: (packet, from) => {
            const now = performance.now()
            if (last) probe.note("wt.in-gap", now - last)
            last = now
            probe.note("wt.in-bytes", packet.length)
            events.packet(packet, from)
          },
          error: (err) => events.error(err),
        },
        signal,
        hints,
      )
      const send = connection.send.bind(connection)
      connection.send = async (packet, to) => {
        const t0 = performance.now()
        await send(packet, to)
        probe.note("wt.send", performance.now() - t0)
        probe.note("wt.out-bytes", packet.length)
      }
      return connection
    },
  }
}

/** How late a 10 ms timer fires: a view of how busy the page's main thread is. */
function loopLag(probe) {
  let expected = performance.now() + 10
  return setInterval(() => {
    const now = performance.now()
    probe.note("page.loop-lag", Math.max(0, now - expected))
    expected = now + 10
  }, 10)
}

async function opfs() {
  const root = await navigator.storage.getDirectory()
  for await (const name of root.keys()) await root.removeEntry(name, { recursive: true }).catch(() => {})
  return root
}

async function run() {
  const config = await (await fetch("/config")).json()
  // Without --probe the page runs as an application would, and reports only its totals.
  const probe = config.probe ? createProbe() : null
  const sink = probe ?? createProbe()
  const base = webTransport(role === "send" ? config.entry : config.receiverEntry)
  const transport = probe ? timed(base, probe) : base
  const client = new TeseraClient({ transport, ...(probe ? { probe } : {}) })
  const lag = probe ? loopLag(probe) : null
  const root = await opfs()
  if (role === "send") {
    const handle = await root.getFileHandle("payload.bin", { create: true })
    const writable = await handle.createWritable()
    const bytes = payload(config.seed, config.size)
    for (let chunk = bytes.next(1 << 20); chunk; chunk = bytes.next(1 << 20)) await writable.write(chunk)
    await writable.close()
    const file = await handle.getFile()
    const transfer = await client.send(file, { relays: config.relays, ...(config.coding ? { coding: config.coding } : {}) })
    await post("/signal/offer", { offer: transfer.offer, secret: transfer.secret })
    const answer = await poll("/signal/answer")
    const t0 = performance.now()
    const result = await transfer.start(answer)
    const seconds = (performance.now() - t0) / 1000
    clearInterval(lag)
    await post("/report", { role, bytes: result.bytes, seconds, diagnostics: transfer.diagnostics(), probe: sink.summary(), userAgent: navigator.userAgent, heap: performance.memory?.usedJSHeapSize })
  } else {
    const { offer, secret } = await poll("/signal/offer")
    const hash = sha256.create()
    let handle = null
    let out
    if (config.sink === "null") {
      out = { write: (chunk) => void hash.update(chunk) }
    } else {
      handle = await root.getFileHandle("received.bin", { create: true })
      out = await handle.createWritable()
    }
    const timeline = []
    let lastAt = 0
    const onProgress = (p) => {
      const now = performance.now()
      if (now - lastAt < 100 && !p.done) return
      lastAt = now
      timeline.push([Math.round(now), p.bytes])
    }
    const incoming = await client.receive({ offer, secret, sink: out, onProgress, ...(config.maxBufferedBytes ? { maxBufferedBytes: config.maxBufferedBytes } : {}) })
    await post("/signal/answer", incoming.answer)
    let first = 0
    const watch = setInterval(() => {
      if (!first && (incoming.diagnostics().outputBytes ?? 0) > 0) first = performance.now()
    }, 5)
    const result = await incoming.done
    const seconds = (performance.now() - first) / 1000
    clearInterval(watch)
    clearInterval(lag)
    const summary = sink.summary()
    const heap = performance.memory?.usedJSHeapSize
    if (handle) {
      const reader = (await handle.getFile()).stream().getReader()
      for (let next = await reader.read(); !next.done; next = await reader.read()) hash.update(next.value)
    }
    let hex = ""
    for (const byte of hash.digest()) hex += byte.toString(16).padStart(2, "0")
    await post("/report", { role, bytes: result.bytes, sha256: hex, seconds, firstAt: Math.round(first), timeline, diagnostics: incoming.diagnostics(), probe: summary, userAgent: navigator.userAgent, heap })
  }
}

run().catch((err) => post("/failed", { role, message: String(err?.stack ?? err) }))
