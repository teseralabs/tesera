// The e2e page. It uses @tesera/client exactly as an application would: the built package, a File or a
// stream as the source, and a file in the origin private file system as the sink.
// Modes, from the URL fragment: send, recv, crypto.
import { TeseraClient, webTransport, webTransportSupported } from "../dist/index.js"
import { checkRejections, checkVectors, clientLib, produceCases, verifyCases } from "../test/crypto-checks.ts"
import { payload } from "./payload.js"

const params = new URLSearchParams(location.hash.slice(1))
const mode = params.get("mode")
const role = params.get("role") ?? mode
let current = null
const log = (line) => {
  document.getElementById("log").textContent += `${line}\n`
  void post("/log", { role, line })
}

async function post(path, body) {
  await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
}

async function get(path) {
  return (await fetch(path)).json()
}

/** Polls a rendezvous field until the other page has written it. */
async function wait(path) {
  for (;;) {
    const value = await get(path)
    if (value && Object.keys(value).length > 0) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * JavaScript heap while the transfer runs. `peak` is the heap as V8 leaves it, garbage included.
 * `retainedPeak` is the most the page holds: once a second it forces a collection and measures.
 */
function heapMeter() {
  const memory = () => performance.memory?.usedJSHeapSize ?? 0
  let samples = 0
  let peak = 0
  let retainedPeak = 0
  const retained = []
  const timer = setInterval(() => {
    const used = memory()
    if (used > peak) peak = used
    samples++
  }, 50)
  const collect = setInterval(() => {
    globalThis.gc?.()
    const used = memory()
    if (used > retainedPeak) retainedPeak = used
    retained.push(used)
  }, 1000)
  return {
    baseline: () => {
      globalThis.gc?.()
      return memory()
    },
    stop: () => {
      clearInterval(timer)
      clearInterval(collect)
      globalThis.gc?.()
      return { peak, retainedPeak, retained, samples, end: memory() }
    },
  }
}

function progressCheck(total) {
  let last = -1
  let doneCount = 0
  let ok = true
  let reportedAt = 0
  return {
    on: (p) => {
      if (p.bytes < last) ok = false
      if (p.total !== total) ok = false
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

/** A File on disk with the payload, written a megabyte at a time so the page never holds it. */
async function payloadFile(root, seed, size) {
  const handle = await root.getFileHandle("payload.bin", { create: true })
  const writable = await handle.createWritable()
  const bytes = payload(seed, size)
  for (let chunk = bytes.next(1 << 20); chunk; chunk = bytes.next(1 << 20)) await writable.write(chunk)
  await writable.close()
  return handle.getFile()
}

/** The payload as a stream, generated as the client pulls it. */
function payloadStream(seed, size) {
  const bytes = payload(seed, size)
  return new ReadableStream({
    pull(controller) {
      const chunk = bytes.next(64 * 1024)
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
  })
}

async function send() {
  const config = await get("/config?role=send")
  const root = await opfs()
  const source = config.source === "stream" ? payloadStream(config.seed, config.size) : await payloadFile(root, config.seed, config.size)
  log(`source ${config.source}, ${config.size} bytes`)
  const meter = heapMeter()
  const baseline = meter.baseline()
  const progress = progressCheck(config.size)
  const client = new TeseraClient({ transport: webTransport({ url: config.url, certificateHash: config.certificateHash }) })
  const transfer = await client.send(source, { relays: config.relays, size: config.size, hash: true, onProgress: progress.on })
  current = transfer
  await post("/rendezvous/offer", transfer.offer)
  // The secret's channel: in an application, a link fragment the user shares. It never reaches a relay.
  await post("/secret", { secret: transfer.secret })
  const answer = await wait("/rendezvous/answer")
  const started = performance.now()
  const result = await transfer.start(answer)
  const seconds = (performance.now() - started) / 1000
  const heap = meter.stop()
  await post("/report", {
    role,
    bytes: result.bytes,
    sha256: result.sha256,
    seconds,
    heap: { baseline, ...heap },
    progress: progress.result(),
    diagnostics: transfer.diagnostics(),
    offer: transfer.offer,
    userAgent: navigator.userAgent,
  })
  log(`sent ${result.bytes} bytes in ${seconds.toFixed(1)} s`)
}

async function recv() {
  const config = await get("/config?role=recv")
  const root = await opfs()
  const offer = await wait("/rendezvous/offer")
  const { secret } = await wait("/secret")
  const handle = await root.getFileHandle("received.bin", { create: true })
  const sink = await handle.createWritable()
  const meter = heapMeter()
  const baseline = meter.baseline()
  const progress = progressCheck(offer.size)
  const client = new TeseraClient({ transport: webTransport({ url: config.url, certificateHash: config.certificateHash }) })
  const transfer = await client.receive({ offer, secret, sink, hash: true, onProgress: progress.on })
  current = transfer
  setInterval(() => void post("/recv-diagnostics", transfer.diagnostics()), 1000)
  await post("/rendezvous/answer", transfer.answer)
  let first = 0
  const startedAt = performance.now()
  const watchFirst = setInterval(() => {
    if (!first && (transfer.diagnostics().outputBytes ?? 0) > 0) first = performance.now()
  }, 20)
  const result = await transfer.done
  clearInterval(watchFirst)
  const seconds = (performance.now() - (first || startedAt)) / 1000
  const heap = meter.stop()
  const written = (await handle.getFile()).size
  await post("/report", {
    role,
    bytes: result.bytes,
    written,
    sha256: result.sha256,
    seconds,
    heap: { baseline, ...heap },
    progress: progress.result(),
    diagnostics: transfer.diagnostics(),
    answer: transfer.answer,
    userAgent: navigator.userAgent,
  })
  log(`received ${result.bytes} bytes in ${seconds.toFixed(1)} s`)
}

async function crypto() {
  const vectors = await get("/vectors")
  const nativeCases = await get("/native-cases")
  const random = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length))
  const browserCases = produceCases(clientLib, 40, random)
  await post("/crypto", {
    vectors: checkVectors(clientLib, vectors),
    nativeToBrowser: verifyCases(clientLib, nativeCases),
    rejections: browserCases.slice(1, 8).flatMap((c) => checkRejections(clientLib, c)),
    browserCases,
    webTransport: webTransportSupported(),
    userAgent: navigator.userAgent,
  })
  log("crypto checks posted")
}

const run = { send, recv, crypto }[mode]
run().catch((err) => {
  log(`failed: ${err?.code ?? ""} ${err?.message ?? err}`)
  void post("/failed", { role, code: err?.code, message: String(err?.message ?? err), diagnostics: current?.diagnostics() })
})
