// The @tesera/client end-to-end run in real Chrome:
//
//   Chrome (TeseraClient) --WebTransport--> relay A --UDP--> relays B, C, D (an older release) --UDP--> relay E --WebTransport--> Chrome (TeseraClient)
//
// A and E are tesera's production attachment relays from this repository's dist. B, C, and D are
// ordinary UDP relays from an older release that know nothing of browsers. Each Chrome is its own
// process with its own profile. This process plays rendezvous, carrying only the offer and the answer,
// and stands in for the channel the secret travels on, which in an application is a link the user shares.
//
//   (cd ../../.. && npm run build) && npm run build && node e2e/build.mjs
//   node e2e/run.mjs --mode crypto
//   node e2e/run.mjs [--size 10mb] [--source file|stream] [--kill] [--capture] [--label NAME]
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createInterface } from "node:readline"
import { parseArgs } from "node:util"
import { payload } from "./payload.js"

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "transfer" },
    size: { type: "string", default: "10mb" },
    source: { type: "string", default: "file" },
    kill: { type: "boolean", default: false },
    capture: { type: "boolean", default: false },
    label: { type: "string" },
    "udp-cli": { type: "string", default: new URL("../../../tmp/v021/dist/src/cli.js", import.meta.url).pathname },
    "udp-bandwidth": { type: "string", default: "4000mbps" },
    chrome: { type: "string", default: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    firefox: { type: "string", default: "/Applications/Firefox.app/Contents/MacOS/firefox" },
    "send-browser": { type: "string", default: "chrome" },
    "recv-browser": { type: "string", default: "chrome" },
  },
})
const here = (path) => new URL(path, import.meta.url).pathname
const out = here("./out/")
mkdirSync(out, { recursive: true })
for (const name of readdirSync(out)) if (name.startsWith("chrome-") || name.startsWith("firefox-")) rmSync(`${out}${name}`, { recursive: true, force: true, maxRetries: 3 })
const dist = new URL("../../../dist/src/", import.meta.url)
const native = (path) => import(new URL(path, dist).href)
const step = (line) => console.log(`${new Date().toISOString().slice(11, 23)} ${line}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const children = new Set()
process.on("exit", () => {
  for (const child of children) child.kill("SIGKILL")
})
for (const signal of ["uncaughtException", "unhandledRejection"]) {
  process.on(signal, (err) => {
    console.error(err)
    process.exit(1)
  })
}

// rendezvous and the secret's channel: a few JSON fields, never file bytes
const store = {}
const waiters = new Map()
const waitFor = (key) => (store[key] !== undefined ? Promise.resolve(store[key]) : new Promise((resolve) => waiters.set(key, resolve)))
const put = (key, value) => {
  store[key] = value
  waiters.get(key)?.(value)
}
let onProgress = () => {}
let config = {}
let nativeCases = []

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1")
  const body = req.method === "POST" ? JSON.parse(await text(req)) : null
  const json = (value) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value ?? {}))
  const file = (path, type) => res.writeHead(200, { "content-type": type }).end(readFileSync(here(path)))
  if (url.pathname === "/") return file("./index.html", "text/html")
  if (url.pathname === "/page.js") return file("./out/page.js", "text/javascript")
  if (url.pathname === "/favicon.ico") return res.writeHead(404).end()
  if (url.pathname === "/config") return json(config[url.searchParams.get("role")])
  if (url.pathname === "/vectors") return file("../../../test/vectors/v2.json", "application/json")
  if (url.pathname === "/native-cases") return json(nativeCases)
  const key = url.pathname.slice(1)
  if (req.method === "GET") return json(store[key])
  if (key === "progress") onProgress(body)
  else if (key === "log") step(`${body.role}: ${body.line}`)
  else put(key === "report" || key === "failed" ? `${key}-${body.role}` : key, body)
  json({ ok: true })
})
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve))
const site = `http://127.0.0.1:${http.address().port}/`

if (args.mode === "crypto") await cryptoRun()
else await transferRun()
http.close()
process.exit(process.exitCode ?? 0)

async function cryptoRun() {
  const session = await native("crypto/session.js")
  const frames = await native("protocol/frames.js")
  const primitives = await native("crypto/primitives.js")
  const nativeLib = { session, frames, primitives }
  const checks = await import(here("./out/crypto-checks.mjs"))
  const random = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length))
  nativeCases = checks.produceCases(nativeLib, 40, random)
  const browser = openBrowser(args["send-browser"], `${site}#mode=crypto`)
  const result = await Promise.race([waitFor("crypto"), waitFor("failed-crypto").then((f) => ({ failed: f })), timeout(60_000, "crypto")])
  browser.kill("SIGKILL")
  if (result.failed) throw new Error(`the page failed: ${result.failed.message}`)
  const browserToNative = checks.verifyCases(nativeLib, result.browserCases)
  const report = {
    userAgent: result.userAgent,
    webTransport: result.webTransport,
    vectorFailures: result.vectors,
    nativeToBrowserFailures: result.nativeToBrowser,
    browserToNativeFailures: browserToNative,
    tamperFailures: result.rejections,
    cases: result.browserCases.length,
  }
  writeFileSync(`${out}report-crypto.json`, JSON.stringify(report, null, 2))
  step(`crypto in ${result.userAgent}`)
  step(`vectors ${report.vectorFailures.length === 0 ? "pass" : report.vectorFailures.join("; ")}`)
  step(`node encrypt -> browser decrypt: ${nativeCases.length} cases, failures ${report.nativeToBrowserFailures.length}`)
  step(`browser encrypt -> node decrypt: ${report.cases} cases, failures ${report.browserToNativeFailures.length}`)
  step(`tampering rejected: failures ${report.tamperFailures.length}`)
  const ok = [report.vectorFailures, report.nativeToBrowserFailures, report.browserToNativeFailures, report.tamperFailures].every((f) => f.length === 0)
  step(ok ? "RESULT pass" : "RESULT fail")
  if (!ok) process.exitCode = 1
}

async function transferRun() {
  const size = parseSize(args.size)
  const seed = 1 + Math.floor(Math.random() * 0xfffffff0)
  const label = args.label ?? `${args.size}-${args.source}${args.kill ? "-kill" : ""}`
  const capture = args.capture
  step(`${label}: ${size} bytes from a ${args.source}, seed ${seed}, capture ${capture}`)
  const expected = digest(seed, size)

  const A = await attachRelay("a", capture)
  const E = await attachRelay("e", capture)
  step(`relay A udp ${A.info.udp.port} webtransport ${A.info.webtransport.port}, relay E udp ${E.info.udp.port} webtransport ${E.info.webtransport.port}`)
  const udp = []
  for (const name of ["b", "c", "d"]) udp.push(await udpRelay(name))
  const version = JSON.parse(readFileSync(new URL("../../package.json", `file://${args["udp-cli"]}`), "utf8")).version
  step(`UDP relays ${udp.map((r) => `${r.name}:${r.endpoint.port}`).join(" ")}, release ${version}, bandwidth ${args["udp-bandwidth"]}`)

  config = {
    send: { url: `https://127.0.0.1:${A.info.webtransport.port}`, certificateHash: A.info.certificateHash, relays: udp.map((r) => r.endpoint), size, seed, source: args.source },
    recv: { url: `https://127.0.0.1:${E.info.webtransport.port}`, certificateHash: E.info.certificateHash },
  }
  let killed = null
  onProgress = (p) => {
    if (args.kill && !killed && p.role === "send" && p.bytes > size / 3) {
      // The last path in the offer the sender actually made, never A or E.
      const offer = store["rendezvous/offer"]
      const path = offer?.relays.findLast((r) => udp.some((u) => u.endpoint.port === r.port))
      if (!path) throw new Error(`the offer has no UDP relay to kill: ${JSON.stringify(offer?.relays)}`)
      killed = udp.find((u) => u.endpoint.port === path.port)
      killed.proc.kill("SIGKILL")
      step(`killed UDP relay ${killed.name}, offer path ${offer.relays.indexOf(path) + 1} of ${offer.relays.length}, at ${p.bytes} bytes`)
    }
  }
  const recvBrowser = openBrowser(args["recv-browser"], `${site}#mode=recv`)
  const sendBrowser = openBrowser(args["send-browser"], `${site}#mode=send`)
  const limit = 120_000 + (size / (1024 * 1024)) * 2_000
  const reports = await Promise.race([
    Promise.all([waitFor("report-send"), waitFor("report-recv")]),
    waitFor("failed-send").then((f) => ({ failed: f })),
    waitFor("failed-recv").then((f) => ({ failed: f })),
    timeout(limit, "transfer"),
  ])
  // let both clients close their attachments themselves, so the relays' counts below show cleanup
  await sleep(4000)
  sendBrowser.kill("SIGKILL")
  recvBrowser.kill("SIGKILL")
  if (reports.failed) {
    const failure = { failed: reports.failed, receiver: store["recv-diagnostics"], relayA: await A.stop(), relayE: await E.stop() }
    writeFileSync(`${out}failure-${label}.json`, JSON.stringify(failure, null, 2))
    throw new Error(`the ${reports.failed.role} page failed: ${reports.failed.code} ${reports.failed.message}, details in e2e/out/failure-${label}.json`)
  }
  const [sent, received] = reports

  const relayA = await A.stop()
  const relayE = await E.stop()
  for (const relay of udp) if (relay !== killed) relay.proc.kill("SIGTERM")
  await sleep(300)

  const report = {
    label,
    size,
    source: args.source,
    userAgent: sent.userAgent,
    udpRelease: version,
    expected,
    sent: { sha256: sent.sha256, bytes: sent.bytes, seconds: sent.seconds, heap: sent.heap, progress: sent.progress, diagnostics: sent.diagnostics },
    received: { sha256: received.sha256, bytes: received.bytes, written: received.written, seconds: received.seconds, heap: received.heap, progress: received.progress, diagnostics: received.diagnostics },
    match: sent.sha256 === expected && received.sha256 === expected && received.written === size,
    throughputMBps: size / (1024 * 1024) / sent.seconds,
    negotiation: {
      senderMaxPacket: sent.diagnostics.maxPacketSize,
      receiverAdvertised: received.answer.maxPacketSize,
      datagram: sent.diagnostics.datagramSize,
    },
    coding: { k: sent.offer.k, n: sent.offer.n },
    killed: killed?.name ?? null,
    relayA: { attach: relayA.attach, live: relayA.live },
    relayE: { attach: relayE.attach, live: relayE.live },
  }
  if (capture) report.leaks = await leakScan(store["secret"].secret, sent.offer.sessionId, seed, size, A, E, udp, relayA, relayE)
  writeFileSync(`${out}report-${label}.json`, JSON.stringify(report, null, 2))

  const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`
  step(`sender ${sent.userAgent}`)
  step(`receiver ${received.userAgent}`)
  step(`sha256 expected ${expected}`)
  step(`sha256 sent     ${sent.sha256}`)
  step(`sha256 received ${received.sha256}, ${received.written} bytes on disk, match ${report.match}`)
  step(`coding ${report.coding.k}-of-${report.coding.n}, packets: sender ${report.negotiation.senderMaxPacket}, receiver ${report.negotiation.receiverAdvertised}, datagram ${report.negotiation.datagram}`)
  step(`throughput ${report.throughputMBps.toFixed(1)} MB/s over ${sent.seconds.toFixed(1)} s, retransmitted ${sent.diagnostics.tesseraRetransmissions} of ${sent.diagnostics.tesseraSends}`)
  const heap = (h) => `baseline ${mb(h.baseline)} retained peak ${mb(h.retainedPeak)} unforced peak ${mb(h.peak)} end ${mb(h.end)}`
  step(`heap sender ${heap(sent.heap)}`)
  step(`heap receiver ${heap(received.heap)}, unread peak ${received.diagnostics.maxUnreadBytes}`)
  step(`progress sender ${JSON.stringify(sent.progress)}, receiver ${JSON.stringify(received.progress)}`)
  step(`relay A forwarded ${relayA.attach.forwarded}, live attachments after ${relayA.live.attachments}; relay E claims ${JSON.stringify(relayE.attach.claims)}, live after ${relayE.live.attachments}`)
  if (report.leaks) for (const [name, leak] of Object.entries(report.leaks)) step(`leak scan ${name}: ${leak.verdict} ${JSON.stringify(leak.found ?? {})}${leak.plaintextRuns !== undefined ? ` plaintext runs ${leak.plaintextRuns}, control ${leak.detectorControl}` : ""}`)
  const clean = !report.leaks || Object.values(report.leaks).every((l) => l.verdict === "clean")
  const ok = report.match && clean && sent.progress.ok && received.progress.ok
  step(ok ? "RESULT pass" : "RESULT fail")
  if (!ok) process.exitCode = 1
}

async function leakScan(secretHex, sessionHex, seed, size, A, E, udp, relayA, relayE) {
  const { deriveKeys } = await native("crypto/session.js")
  const { decodeEnvelope } = await native("protocol/envelope.js")
  const { decodeFrame } = await native("protocol/frames.js")
  const secret = Buffer.from(secretHex, "hex")
  const keys = deriveKeys(secret, Buffer.from(sessionHex, "hex"))
  const plain = Buffer.concat(collectPayload(seed, size))
  const windows = new Set()
  for (let at = 0; at + 16 <= plain.length; at += 8) windows.add(plain.toString("latin1", at, at + 16))
  const needles = { secret, secretHex: Buffer.from(secretHex), aeadKey: keys.aeadKey, aeadKeyHex: Buffer.from(keys.aeadKey.toString("hex")), macKey: keys.macKey, macKeyHex: Buffer.from(keys.macKey.toString("hex")) }
  const runs = (haystack) => {
    let hits = 0
    for (let at = 0; at + 16 <= haystack.length; at++) if (windows.has(haystack.toString("latin1", at, at + 16))) hits++
    return hits
  }
  const scan = (all, withPlaintext = true) => {
    const found = Object.fromEntries(Object.entries(needles).map(([name, bytes]) => [name, all.includes(bytes)]))
    const plaintextRuns = withPlaintext ? runs(all) : 0
    // planted positives: the detector must fire on real plaintext and on every key, or "clean" means nothing
    const planted = Buffer.concat([all.subarray(0, 1000), plain.subarray(5000, 5100), ...Object.values(needles), all.subarray(1000, 2000)])
    const detectorControl = runs(planted) > 0 && Object.values(needles).every((bytes) => planted.includes(bytes))
    return { bytes: all.length, found, plaintextRuns, detectorControl, verdict: !Object.values(found).some(Boolean) && plaintextRuns === 0 && detectorControl ? "clean" : "LEAK" }
  }
  const inspect = (path) => {
    const file = readFileSync(path)
    const kinds = {}
    const records = []
    for (let at = 0; at < file.length; ) {
      const tag = file.readUInt8(at)
      const len = file.readUInt32BE(at + 1)
      const bytes = file.subarray(at + 5, at + 5 + len)
      at += 5 + len
      records.push(bytes)
      const datagram = tag === 1 || tag === 3 ? bytes.subarray(7) : bytes
      const env = decodeEnvelope(datagram)
      const frame = decodeFrame(env ? env.inner : datagram, keys.macKey)
      const key = `${["udp-in", "wt-in", "udp-out", "wt-out"][tag]} ${env ? "envelope " : ""}${frame?.kind ?? "other"}`
      kinds[key] = (kinds[key] ?? 0) + 1
    }
    return { records: records.length, kinds, ...scan(Buffer.concat(records)) }
  }
  const logs = Buffer.from([...relayA.log, ...relayE.log, ...udp.map((r) => r.log.join(""))].join("\n"))
  const rendezvous = Buffer.from(JSON.stringify({ offer: store["rendezvous/offer"], answer: store["rendezvous/answer"] }))
  return {
    relayA: inspect(A.capture),
    relayE: inspect(E.capture),
    relayLogs: scan(logs),
    rendezvous: scan(rendezvous),
  }
}

async function attachRelay(name, capture) {
  const path = capture ? `${out}capture-${name}.bin` : null
  const proc = spawn(process.execPath, [here("./attach-relay.mjs"), ...(path ? ["--capture", path] : [])], { stdio: ["ignore", "pipe", "inherit"] })
  children.add(proc)
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]()
  const info = JSON.parse((await lines.next()).value)
  return {
    info,
    capture: path,
    stop: async () => {
      proc.kill("SIGTERM")
      return JSON.parse((await lines.next()).value)
    },
  }
}

async function udpRelay(name) {
  const proc = spawn(process.execPath, [args["udp-cli"], "relay", "--listen", "127.0.0.1:0", "--allow-remote", "--allow-dest", "127.0.0.0/8", "--bandwidth", args["udp-bandwidth"], "--datagram-rate", "1000000"], { stdio: ["ignore", "pipe", "pipe"] })
  children.add(proc)
  const log = []
  const port = await new Promise((resolve, reject) => {
    const read = (data) => {
      log.push(String(data))
      const match = String(data).match(/addr=127\.0\.0\.1:(\d+)/)
      if (match) resolve(Number(match[1]))
    }
    proc.stdout.on("data", read)
    proc.stderr.on("data", read)
    setTimeout(() => reject(new Error(`UDP relay ${name} did not start: ${log.join("")}`)), 5000)
  })
  return { name, proc, endpoint: { host: "127.0.0.1", port }, log }
}

function openBrowser(kind, url) {
  if (kind === "chrome") return openChrome(url)
  if (kind !== "firefox") throw new Error(`unknown browser ${kind}`)
  const profile = `${out}firefox-${Math.random().toString(36).slice(2)}`
  mkdirSync(profile)
  const proc = spawn(args.firefox, ["--headless", "--no-remote", "--profile", profile, url], { stdio: "ignore" })
  children.add(proc)
  return proc
}

function openChrome(url) {
  const profile = `${out}chrome-${Math.random().toString(36).slice(2)}`
  const proc = spawn(args.chrome, [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--enable-precise-memory-info",
    "--js-flags=--expose-gc",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    url,
  ], { stdio: "ignore" })
  children.add(proc)
  return proc
}

function digest(seed, size) {
  const hash = createHash("sha256")
  const bytes = payload(seed, size)
  for (let chunk = bytes.next(1 << 20); chunk; chunk = bytes.next(1 << 20)) hash.update(chunk)
  return hash.digest("hex")
}

function collectPayload(seed, size) {
  const parts = []
  const bytes = payload(seed, size)
  for (let chunk = bytes.next(1 << 20); chunk; chunk = bytes.next(1 << 20)) parts.push(Buffer.from(chunk))
  return parts
}

function parseSize(text) {
  const match = /^(\d+)(b|kb|mb|gb)?$/i.exec(text)
  if (!match) throw new Error(`not a size: ${text}`)
  const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(match[2] ?? "b").toLowerCase()]
  return Number(match[1]) * unit
}

function text(req) {
  return new Promise((resolve) => {
    const parts = []
    req.on("data", (part) => parts.push(part))
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")))
  })
}

function timeout(ms, what) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms))
}
