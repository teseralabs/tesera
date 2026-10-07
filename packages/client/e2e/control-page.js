// The control-plane e2e page, written as an application would use @tesera/client. It is told only the
// control plane's URL. `/send` shares a file and passes on a link; `/t/<room>#<secret>` receives it.
// The secret lives in the fragment, which the browser never puts in a request.
import { discoveryTransport, httpControlPlane, joinTransfer, shareTransfer, TeseraClient } from "../dist/index.js"
import { payload } from "./payload.js"

const sending = location.pathname === "/send"
const role = sending ? "send" : "recv"
let current = null
const log = (line) => {
  document.getElementById("log").textContent += `${line}\n`
  void post("/log", { role, line })
}

/**
 * The transport, counting the type byte of every frame the relay hands this page. A sender must see
 * only ACK, NACK, and SAMPLE (2, 3, 4) and a receiver only DATA (1), or frames crossed between ends.
 */
const frameTypes = {}
function counted(transport) {
  return {
    name: transport.name,
    connect: (events, signal, hints) =>
      transport.connect(
        {
          packet: (packet, from) => {
            frameTypes[packet[1]] = (frameTypes[packet[1]] ?? 0) + 1
            events.packet(packet, from)
          },
          error: (err) => events.error(err),
        },
        signal,
        hints,
      ),
  }
}

async function post(path, body) {
  await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
}

function progressCheck() {
  let last = -1
  let doneCount = 0
  let ok = true
  let reportedAt = 0
  return {
    on: (p) => {
      if (p.bytes < last) ok = false
      if (p.done) doneCount++
      last = p.bytes
      if (Date.now() - reportedAt > 250 || p.done) {
        reportedAt = Date.now()
        void post("/progress", { role, bytes: p.bytes, total: p.total, done: p.done })
      }
    },
    result: () => ({ ok: ok && doneCount === 1, last, doneCount }),
  }
}

async function opfs() {
  const root = await navigator.storage.getDirectory()
  for await (const name of root.keys()) await root.removeEntry(name).catch(() => {})
  return root
}

async function payloadFile(root, seed, size) {
  const handle = await root.getFileHandle("payload.bin", { create: true })
  const writable = await handle.createWritable()
  const bytes = payload(seed, size)
  for (let chunk = bytes.next(1 << 20); chunk; chunk = bytes.next(1 << 20)) await writable.write(chunk)
  await writable.close()
  return handle.getFile()
}

async function send() {
  const config = await (await fetch("/config")).json()
  const channel = new URLSearchParams(location.hash.slice(1)).get("channel")
  const control = httpControlPlane(config.control)
  const client = new TeseraClient({ transport: counted(discoveryTransport(control)) })
  const file = await payloadFile(await opfs(), config.seed, config.size)
  const progress = progressCheck()
  const share = await shareTransfer(client, control, file, { hash: true, onProgress: progress.on })
  current = share.transfer
  const relays = share.transfer.offer.relays
  const link = `${location.origin}/t/${share.room}#${share.secret}`
  await fetch(channel, { method: "POST", body: JSON.stringify({ link }) })
  log(`shared a room on ${relays.length} relays; waiting for the receiver`)
  let started = 0
  const watch = setInterval(() => {
    if (!started && (share.transfer.diagnostics().tesseraSends ?? 0) > 0) started = performance.now()
  }, 10)
  const result = await share.done
  clearInterval(watch)
  const seconds = (performance.now() - started) / 1000
  await post("/report", {
    role,
    bytes: result.bytes,
    sha256: result.sha256,
    seconds,
    progress: progress.result(),
    diagnostics: share.transfer.diagnostics(),
    frameTypes,
    offer: share.transfer.offer,
    userAgent: navigator.userAgent,
  })
  log(`sent ${result.bytes} bytes in ${seconds.toFixed(1)} s`)
}

async function recv() {
  const config = await (await fetch("/config")).json()
  const room = location.pathname.split("/").pop()
  const secret = location.hash.slice(1)
  const control = httpControlPlane(config.control)
  const client = new TeseraClient({ transport: counted(discoveryTransport(control)) })
  const root = await opfs()
  const handle = await root.getFileHandle("received.bin", { create: true })
  const sink = await handle.createWritable()
  const progress = progressCheck()
  const incoming = await joinTransfer(client, control, { room, secret, sink, hash: true, onProgress: progress.on, avoidSenderEntry: config.separate })
  current = incoming
  log("joined; receiving")
  let first = 0
  const startedAt = performance.now()
  const watch = setInterval(() => {
    if (!first && (incoming.diagnostics().outputBytes ?? 0) > 0) first = performance.now()
  }, 20)
  const result = await incoming.done
  clearInterval(watch)
  const seconds = (performance.now() - (first || startedAt)) / 1000
  const written = (await handle.getFile()).size
  await post("/report", {
    role,
    bytes: result.bytes,
    written,
    sha256: result.sha256,
    seconds,
    progress: progress.result(),
    diagnostics: incoming.diagnostics(),
    frameTypes,
    answer: incoming.answer,
    userAgent: navigator.userAgent,
  })
  log(`received ${result.bytes} bytes in ${seconds.toFixed(1)} s`)
}

;(sending ? send : recv)().catch((err) => {
  log(`failed: ${err?.code ?? ""} ${err?.reason ?? ""} ${err?.message ?? err}`)
  void post("/failed", { role, code: err?.code, message: String(err?.message ?? err), diagnostics: current?.diagnostics() })
})
