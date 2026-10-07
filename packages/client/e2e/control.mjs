// The control-plane end-to-end run in real Chrome:
//
//   Chrome A --WebTransport--> relay A --UDP--> relays B, C, D (an older release) --UDP--> relay A --WebTransport--> Chrome B
//                  control plane: `tesera api` with discovery and rendezvous, behind a recording proxy
//
// Every process is the real CLI: A is `tesera relay --webtransport --api`, B, C, and D are an older
// release joined to A, and the control plane is `tesera api --entries`. The sending page lets
// `shareTransfer` choose, which takes B, C, and D before the attachment relay A. With `--udp 2` only B
// and C run, as on the live network, and A is the third path. `--kill-relay` reads the offer from
// the rendezvous and kills its first path that is not an attachment relay.
// With `--entries 2` a second attachment relay E is listed too, and with `--separate` the receiver asks for an entry other than the
// sender's, so it lands on E. The pages are told only the control plane's URL. The sender shares a
// link, `/t/<room>#<secret>`, through a separate channel that stands in for the person passing it on;
// the receiver's browser opens it. Every request to the page server and to the control plane is
// recorded and searched for the secret, derived keys, and data. With `--capture`, every UDP datagram
// at every relay is recorded too, and searched the same way.
//
//   (cd ../../.. && npm run build) && npm run build && node e2e/build.mjs
//   node e2e/control.mjs [--size 100mb] [--entries 1|2] [--udp 2|3] [--separate] [--reverse] [--capture]
//                        [--kill-relay] [--kill-api] [--late SECONDS] [--label NAME]
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, request } from "node:http"
import { parseArgs } from "node:util"
import { payload } from "./payload.js"

const { values: args } = parseArgs({
  options: {
    size: { type: "string", default: "10mb" },
    "kill-relay": { type: "boolean", default: false },
    "kill-api": { type: "boolean", default: false },
    late: { type: "string", default: "0" },
    entries: { type: "string", default: "1" },
    udp: { type: "string", default: "3" },
    separate: { type: "boolean", default: false },
    reverse: { type: "boolean", default: false },
    capture: { type: "boolean", default: false },
    label: { type: "string" },
    "udp-cli": { type: "string", default: new URL("../../../tmp/v021/dist/src/cli.js", import.meta.url).pathname },
    chrome: { type: "string", default: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  },
})
const here = (path) => new URL(path, import.meta.url).pathname
const out = here("./out/")
mkdirSync(out, { recursive: true })
for (const name of readdirSync(out)) if (name.startsWith("chrome-")) rmSync(`${out}${name}`, { recursive: true, force: true, maxRetries: 3 })
const cli = here("../../../dist/src/cli.js")
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

const size = parseSize(args.size)
const seed = 1 + Math.floor(Math.random() * 0xfffffff0)
const lateMs = Number(args.late) * 1000
const entryCount = Number(args.entries)
if (entryCount !== 1 && entryCount !== 2) throw new Error("--entries is 1 or 2")
if (args.separate && entryCount < 2) throw new Error("--separate needs --entries 2")
const udpCount = Number(args.udp)
if (udpCount !== 2 && udpCount !== 3) throw new Error("--udp is 2 or 3")
const [senderName, receiverName] = args.reverse ? ["B", "A"] : ["A", "B"]
const label =
  args.label ??
  `control-${args.size}-entries${entryCount}${udpCount === 2 ? "-udp2" : ""}${args.separate ? "-separate" : ""}${args.reverse ? "-reverse" : ""}${args["kill-relay"] ? "-kill-relay" : ""}${args["kill-api"] ? "-kill-api" : ""}${lateMs ? `-late${args.late}` : ""}`
step(`${label}: ${size} bytes, seed ${seed}, Chrome ${senderName} sends to Chrome ${receiverName}`)
const expected = digest(seed, size)

// --- relays ---------------------------------------------------------------------------------------
const { generateIdentity } = await native("identity/id.js")
const identityFile = (name) => {
  const identity = generateIdentity()
  const path = `${out}identity-${name}`
  writeFileSync(path, `${identity.secret.toString("hex")}\n`, { mode: 0o600 })
  return { id: identity.id, path }
}
const open = ["--allow-remote", "--allow-dest", "127.0.0.0/8", "--access", "open", "--bandwidth", "4000mbps", "--datagram-rate", "1000000"]

const A = await relay("a", cli, [...open, "--webtransport", "127.0.0.1:0", "--api", "127.0.0.1:0"], { browser: true })
const E =
  entryCount === 2
    ? await relay("e", cli, [...open, "--webtransport", "127.0.0.1:0", "--api", "127.0.0.1:0", "--join", `${A.id}@127.0.0.1:${A.udp}`], { browser: true })
    : null
const browserRelays = E ? [A, E] : [A]
const udp = []
for (const name of ["b", "c", "d"].slice(0, udpCount)) udp.push(await relay(name, args["udp-cli"], [...open, "--join", `${A.id}@127.0.0.1:${A.udp}`]))
const oldVersion = JSON.parse(readFileSync(new URL("../../package.json", `file://${args["udp-cli"]}`), "utf8")).version
step(browserRelays.map((r) => `relay ${r.name.toUpperCase()} udp ${r.udp} webtransport ${r.browser} api ${r.api}`).join("; ") + `; ${browserRelays.length} WebTransport relay(s) in all`)
step(`UDP relays ${udp.map((r) => `${r.name}:${r.udp}`).join(" ")}, release ${oldVersion}, joined to A`)

// --- control plane ------------------------------------------------------------------------------------
const entriesPath = `${out}entries.json`
writeFileSync(
  entriesPath,
  JSON.stringify({
    entries: browserRelays.map((r) => ({ relay: r.id, url: `https://127.0.0.1:${r.browser}`, statement: `http://127.0.0.1:${r.api}/v1/transports` })),
  }),
)
const api = await start("api", cli, ["api", "--listen", "127.0.0.1:0", "--discover", `${A.id}@127.0.0.1:${A.udp}`, "--entries", entriesPath], /event=listen addr=127\.0\.0\.1:(\d+)/)
const apiPort = api.port

/** Every exchange with the control plane, as the proxy saw it. */
const exchanges = []
const proxy = createServer(async (req, res) => {
  const body = await text(req)
  const record = { method: req.method, url: req.url, headers: req.headers, body, status: 0, response: "" }
  exchanges.push(record)
  const upstream = request({ host: "127.0.0.1", port: apiPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
    const parts = []
    answer.on("data", (part) => parts.push(part))
    answer.on("end", () => {
      record.status = answer.statusCode
      record.response = Buffer.concat(parts).toString("utf8")
      res.writeHead(answer.statusCode, answer.headers).end(Buffer.concat(parts))
    })
  })
  upstream.on("error", () => {
    record.status = 502
    res.writeHead(502).end()
  })
  upstream.end(body)
})
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve))
const controlUrl = `http://127.0.0.1:${proxy.address().port}/`

// wait until discovery lists every entry and the old relays
let discovered = null
for (let i = 0; i < 100; i++) {
  discovered = await (await fetch(`http://127.0.0.1:${apiPort}/v1/relays`)).json()
  const wt = discovered.relays.filter((r) => r.transports.some((t) => t.type === "webtransport")).length
  const plain = discovered.relays.filter((r) => !r.transports.some((t) => t.type === "webtransport") && r.transports.some((t) => t.type === "udp")).length
  if (wt === entryCount && plain === udpCount) break
  await sleep(200)
}
writeFileSync(`${out}discovery-${label}.json`, JSON.stringify(discovered, null, 2))
step(`discovery lists ${discovered.relays.length} relays: ${discovered.relays.map((r) => `${r.id.slice(0, 14)}… ${r.transports.map((t) => t.type).join("+")}`).join(", ")}`)

// --- pages ----------------------------------------------------------------------------------------
const pageRequests = []
const store = {}
const waiters = new Map()
const waitFor = (key) => (store[key] !== undefined ? Promise.resolve(store[key]) : new Promise((resolve) => waiters.set(key, resolve)))
const put = (key, value) => {
  store[key] = value
  waiters.get(key)?.(value)
}
let onProgress = () => {}
const site = createServer(async (req, res) => {
  const body = await text(req)
  pageRequests.push({ method: req.method, url: req.url, headers: req.headers, body })
  const url = new URL(req.url, "http://127.0.0.1")
  const json = (value) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value ?? {}))
  const file = (path, type) => res.writeHead(200, { "content-type": type }).end(readFileSync(here(path)))
  if (url.pathname === "/send" || url.pathname.startsWith("/t/")) return file("./index-control.html", "text/html")
  if (url.pathname === "/control-page.js") return file("./out/control-page.js", "text/javascript")
  if (url.pathname === "/favicon.ico") return res.writeHead(404).end()
  if (url.pathname === "/config") return json({ control: controlUrl, size, seed, separate: args.separate })
  const parsed = body ? JSON.parse(body) : null
  if (url.pathname === "/progress") onProgress(parsed)
  else if (url.pathname === "/log") step(`${parsed.role}: ${parsed.line}`)
  else put(`${url.pathname.slice(1)}-${parsed.role}`, parsed)
  json({ ok: true })
})
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve))
const siteUrl = `http://127.0.0.1:${site.address().port}/`

// The person passing the link on: a channel that is neither the page server nor the control plane.
const shared = []
const channel = createServer(async (req, res) => {
  shared.push(JSON.parse(await text(req)))
  put("link", shared.at(-1).link)
  res.writeHead(204, { "access-control-allow-origin": "*" }).end()
})
await new Promise((resolve) => channel.listen(0, "127.0.0.1", resolve))
const channelUrl = `http://127.0.0.1:${channel.address().port}/`

let killedRelay = null
let apiKilledAt = null
onProgress = (p) => {
  if (args["kill-relay"] && !killedRelay && p.role === "send" && p.bytes > size / 3) {
    const offer = JSON.parse(exchanges.find((r) => r.method === "POST" && r.url === "/v1/rooms")?.body ?? "null")
    const attachments = new Set(browserRelays.map((r) => r.udp))
    const path = offer?.relays.find((r) => !attachments.has(r.port) && udp.some((u) => u.udp === r.port))
    if (!path) throw new Error(`the offer has no path that isn't an attachment relay: ${JSON.stringify(offer?.relays)}`)
    killedRelay = udp.find((u) => u.udp === path.port)
    killedRelay.proc.kill("SIGKILL")
    step(`killed UDP relay ${killedRelay.name}, offer path ${offer.relays.indexOf(path) + 1} of ${offer.relays.length}, at ${p.bytes} bytes`)
  }
  if (args["kill-api"] && apiKilledAt === null && p.role === "recv" && p.bytes > 0) {
    apiKilledAt = p.bytes
    api.proc.kill("SIGKILL")
    proxy.close()
    proxy.closeAllConnections()
    step(`killed the control plane and its proxy at ${p.bytes} received bytes`)
  }
}

const sendBrowser = chrome(`${siteUrl}send#channel=${encodeURIComponent(channelUrl)}`, senderName)
const link = await Promise.race([waitFor("link"), waitFor("failed-send").then((f) => Promise.reject(new Error(`sender failed: ${f.code} ${f.message}`))), timeout(60_000, "share")])
const secret = new URL(link).hash.slice(1)
step(`link ${link.replace(secret, "<secret>")}`)
if (lateMs) {
  step(`receiver joins in ${lateMs / 1000} s`)
  await sleep(lateMs)
}
const recvBrowser = chrome(link, receiverName)
const limit = 120_000 + lateMs + (size / (1024 * 1024)) * 2_000
const reports = await Promise.race([
  Promise.all([waitFor("report-send"), waitFor("report-recv")]),
  waitFor("failed-send").then((f) => ({ failed: f })),
  waitFor("failed-recv").then((f) => ({ failed: f })),
  timeout(limit, "transfer"),
])
await sleep(4000)
sendBrowser.kill("SIGKILL")
recvBrowser.kill("SIGKILL")
if (reports.failed) {
  writeFileSync(`${out}failure-${label}.json`, JSON.stringify({ failed: reports.failed, exchanges }, null, 2))
  throw new Error(`the ${reports.failed.role} page failed: ${reports.failed.code} ${reports.failed.message}`)
}
const [sent, received] = reports
if (killedRelay && !sent.offer.relays.some((r) => r.port === killedRelay.udp)) {
  throw new Error(`killed UDP relay ${killedRelay.name} carried none of the transfer`)
}
const apiAlive = apiKilledAt === null
const apiLog = apiAlive ? await api.stop() : api.log.join("")
const relayLogs = [...(await Promise.all(browserRelays.map((r) => r.stop()))), ...udp.filter((r) => r !== killedRelay).map((r) => r.stopNow())].join("\n")
if (args.capture) await sleep(500)
proxy.close()
site.close()
channel.close()

// --- checks ---------------------------------------------------------------------------------------
const { deriveKeys } = await native("crypto/session.js")
const keys = deriveKeys(Buffer.from(secret, "hex"), Buffer.from(sent.offer.sessionId, "hex"))
const plain = Buffer.concat(collectPayload(seed, Math.min(size, 4 << 20)))
const windows = new Set()
for (let at = 0; at + 16 <= plain.length; at += 8) windows.add(plain.toString("latin1", at, at + 16))
const secretBytes = Buffer.from(secret, "hex")
const needles = {
  secretHex: Buffer.from(secret),
  secret: secretBytes,
  secretBase64: Buffer.from(secretBytes.toString("base64")),
  secretBase64url: Buffer.from(secretBytes.toString("base64url")),
  aeadKey: keys.aeadKey,
  aeadKeyHex: Buffer.from(keys.aeadKey.toString("hex")),
  macKey: keys.macKey,
  macKeyHex: Buffer.from(keys.macKey.toString("hex")),
}
const runs = (haystack) => {
  let hits = 0
  for (let at = 0; at + 16 <= haystack.length; at++) if (windows.has(haystack.toString("latin1", at, at + 16))) hits++
  return hits
}
const scan = (haystack) => {
  const found = Object.fromEntries(Object.entries(needles).map(([name, bytes]) => [name, haystack.includes(bytes)]))
  const plaintextRuns = runs(haystack)
  // planted positives: the detector must fire on real plaintext and on every needle, or "clean" means nothing
  const planted = Buffer.concat([haystack.subarray(0, 500), plain.subarray(5000, 5100), ...Object.values(needles), haystack.subarray(500)])
  const detectorControl = runs(planted) > 0 && Object.values(needles).every((bytes) => planted.includes(bytes))
  const verdict = !Object.values(found).some(Boolean) && plaintextRuns === 0 && detectorControl ? "clean" : "LEAK"
  return { bytes: haystack.length, found, plaintextRuns, detectorControl, verdict }
}
const asText = (records) => Buffer.from(records.map((r) => `${r.method} ${r.url}\n${JSON.stringify(r.headers)}\n${r.body}\n${r.status ?? ""}\n${r.response ?? ""}`).join("\n"))
const discoveryResponses = exchanges.filter((r) => r.url.startsWith("/v1/relays"))
const rendezvousDocuments = exchanges.filter((r) => r.url.startsWith("/v1/rooms"))
const leaks = {
  controlPlaneRequestsAndResponses: scan(asText(exchanges)),
  discoveryResponses: scan(asText(discoveryResponses)),
  rendezvousDocuments: scan(asText(rendezvousDocuments)),
  controlPlaneLog: scan(Buffer.from(apiLog)),
  relayLogs: scan(Buffer.from(relayLogs)),
  pageServerRequests: scan(asText(pageRequests)),
}
const { decodeEnvelope } = await native("protocol/envelope.js")
const { PROTOCOL_VERSION } = await native("constants.js")
const captures = {}
const pathPorts = new Set(sent.offer.relays.map((p) => p.port))
if (args.capture) {
  for (const r of [...browserRelays, ...udp]) {
    const records = readCapture(r.capture)
    const kinds = {}
    let chained = 0
    for (const { tag, bytes } of records) {
      const env = decodeEnvelope(bytes)
      const inner = env ? env.inner : bytes
      // "other" is identity and seed traffic, and at an attachment relay the WebTransport library's own QUIC packets.
      const type = inner[0] === PROTOCOL_VERSION ? { 1: "data", 2: "ack", 3: "nack", 4: "sample" }[inner[1]] ?? "other" : "other"
      const key = `${tag === 0 ? "in" : "out"} ${env ? "envelope " : ""}${type}`
      kinds[key] = (kinds[key] ?? 0) + 1
      // One hop: an envelope inside an envelope, an envelope leaving an ordinary relay, or one arriving
      // over UDP at an attachment relay that is not also a path in the offer, would be a chain.
      const asPath = pathPorts.has(r.udp)
      if (env && (decodeEnvelope(env.inner) || (tag === 0 && r.browser && !asPath) || (tag === 2 && !r.browser))) chained++
    }
    leaks[`udp-${r.name}`] = scan(Buffer.concat(records.map((x) => x.bytes)))
    captures[r.name] = { records: records.length, kinds, chained }
  }
}
const crossed = {
  sender: Object.keys(sent.frameTypes ?? {}).filter((t) => !["2", "3", "4"].includes(t)),
  receiver: Object.keys(received.frameTypes ?? {}).filter((t) => t !== "1"),
}
const sameEntry = sent.offer.sender.port === A.udp && received.answer.receiver.port === A.udp
const roomInLog = apiLog.includes(new URL(link).pathname.split("/").pop())
const stored = {
  offer: JSON.parse(rendezvousDocuments.find((r) => r.method === "POST" && r.url === "/v1/rooms")?.body ?? "null"),
  answer: JSON.parse(rendezvousDocuments.find((r) => r.method === "POST" && r.url.endsWith("/answer"))?.body ?? "null"),
}
const after = exchanges.filter((r) => apiKilledAt !== null && r.status === 502)
const report = {
  label,
  size,
  userAgent: sent.userAgent,
  udpRelease: oldVersion,
  expected,
  match: sent.sha256 === expected && received.sha256 === expected && received.written === size,
  sent: { sha256: sent.sha256, seconds: sent.seconds, diagnostics: sent.diagnostics, progress: sent.progress },
  received: { sha256: received.sha256, written: received.written, seconds: received.seconds, progress: received.progress },
  throughputMBps: size / (1024 * 1024) / sent.seconds,
  window: windowTheory(sent.diagnostics),
  entries: entryCount,
  browsers: { sender: senderName, receiver: receiverName },
  offerRelays: sent.offer.relays,
  sender: sent.offer.sender,
  receiver: received.answer.receiver,
  sameEntry,
  frameTypes: { sender: sent.frameTypes, receiver: received.frameTypes },
  crossed,
  datagram: sent.diagnostics.datagramSize,
  captures,
  killedRelay: killedRelay?.name ?? null,
  apiKilledAtBytes: apiKilledAt,
  requestsAfterApiKilled: after.length,
  controlPlaneRequests: exchanges.map((r) => `${r.method} ${r.url.replace(/\/v1\/rooms\/[^/?]+/, "/v1/rooms/<room>")} ${r.status}`),
  pageRequests: pageRequests.map((r) => `${r.method} ${r.url.replace(/\/t\/[^/?#]+/, "/t/<room>")}`).filter((line) => !line.startsWith("POST /progress")),
  fragmentSent: pageRequests.some((r) => r.url.includes("#") || r.url.includes(secret)),
  roomInControlPlaneLog: roomInLog,
  stored,
  leaks,
}
writeFileSync(`${out}report-${label}.json`, JSON.stringify(report, null, 2))
writeFileSync(`${out}control-log-${label}.txt`, apiLog)

step(`sender ${sent.userAgent}`)
step(`Chrome ${senderName} attached to ${JSON.stringify(report.sender)}, Chrome ${receiverName} to ${JSON.stringify(report.receiver)} (A is ${A.udp}${E ? `, E is ${E.udp}` : ""}), same entry ${sameEntry}`)
step(`frame types handed to the sender ${JSON.stringify(sent.frameTypes)}, to the receiver ${JSON.stringify(received.frameTypes)}, crossed ${JSON.stringify(crossed)}`)
for (const [name, c] of Object.entries(captures)) step(`capture ${name}: ${c.records} datagrams ${JSON.stringify(c.kinds)}, chained ${c.chained}`)
step(`offer relays ${report.offerRelays.map((r) => r.port).join(" ")} (old relays ${udp.map((r) => r.udp).join(" ")})`)
step(`sha256 expected ${expected}`)
step(`sha256 sent     ${sent.sha256}`)
step(`sha256 received ${received.sha256}, ${received.written} bytes on disk, match ${report.match}`)
step(`throughput ${report.throughputMBps.toFixed(2)} MB/s over ${sent.seconds.toFixed(1)} s, retransmitted ${sent.diagnostics.tesseraRetransmissions} of ${sent.diagnostics.tesseraSends}`)
step(`window: mean sample rtt ${report.window.meanRttMs.toFixed(1)} ms, mean open window ${report.window.meanOpenWindowBlocks.toFixed(1)} blocks of ${report.window.bytesPerBlock.toFixed(0)} bytes, window/rtt predicts ${report.window.predictedMBps.toFixed(2)} MB/s, datagram ${sent.diagnostics.datagramSize}`)
step(`control plane requests: ${report.controlPlaneRequests.join(", ")}`)
step(`page server requests: ${report.pageRequests.join(", ")}`)
step(`fragment or secret in a page request: ${report.fragmentSent}; room id in the control plane log: ${roomInLog}`)
if (apiKilledAt !== null) step(`control plane killed at ${apiKilledAt} bytes; requests after: ${after.length}; transfer completed: ${report.match}`)
for (const [name, leak] of Object.entries(leaks)) step(`leak scan ${name}: ${leak.verdict} ${leak.bytes} bytes, plaintext runs ${leak.plaintextRuns}, control ${leak.detectorControl}`)
const clean = Object.values(leaks).every((l) => l.verdict === "clean")
const placed = args.separate ? received.answer.receiver.port === E.udp : sameEntry
const unchained = Object.values(captures).every((c) => c.chained === 0)
// shareTransfer's rule: relays that aren't entries first, then entries, each in listed order.
const listedUdp = (entry) =>
  discovered.relays.filter((r) => r.transports.some((t) => t.type === "webtransport") === entry).flatMap((r) => r.transports.filter((t) => t.type === "udp").map((t) => t.port))
const expectedPaths = [...listedUdp(false), ...listedUdp(true)].slice(0, 3)
const pathsAsRule = JSON.stringify(sent.offer.relays.map((r) => r.port)) === JSON.stringify(expectedPaths)
const ok =
  report.match && clean && !report.fragmentSent && !roomInLog && sent.progress.ok && received.progress.ok && placed && unchained &&
  crossed.sender.length === 0 && crossed.receiver.length === 0 && pathsAsRule
step(`placement as asked ${placed}, no forwarding chain ${unchained}, paths ${expectedPaths.join(" ")} as the rule says ${pathsAsRule}`)
step(ok ? "RESULT pass" : "RESULT fail")
process.exit(ok ? 0 : 1)

// --- helpers --------------------------------------------------------------------------------------
/** If the open window bounds throughput, it is about window × block bytes per round trip. */
function windowTheory(d) {
  const meanRttMs = d.sampleRttSumMs / Math.max(1, d.sampleRttCount)
  const meanOpenWindowBlocks = d.windowSum / Math.max(1, d.windowCount)
  const bytesPerBlock = d.inputBytes / Math.max(1, d.blocks)
  const predictedMBps = (meanOpenWindowBlocks * bytesPerBlock) / (meanRttMs / 1000) / (1024 * 1024)
  return { meanRttMs, meanOpenWindowBlocks, bytesPerBlock, predictedMBps }
}

async function relay(name, path, extra, opts = {}) {
  const identity = identityFile(name)
  const capture = args.capture ? `${out}capture-${name}.bin` : null
  const proc = await start(name, path, ["relay", "--listen", "127.0.0.1:0", "--identity", identity.path, ...extra], /event=listen addr=127\.0\.0\.1:(\d+)/, capture)
  const found = { name, id: identity.id, udp: proc.port, proc: proc.proc, log: proc.log, capture }
  if (opts.browser) {
    found.browser = Number(await proc.match(/event=webtransport-listen addr=127\.0\.0\.1:(\d+)/))
    found.api = Number(await proc.match(/event=api addr=127\.0\.0\.1:(\d+)/))
  }
  found.stop = proc.stop
  found.stopNow = () => {
    proc.proc.kill("SIGTERM")
    return proc.log.join("")
  }
  found.endpoint = { host: "127.0.0.1", port: found.udp }
  return found
}

function readCapture(path) {
  const file = readFileSync(path)
  const records = []
  for (let at = 0; at + 11 <= file.length; ) {
    const tag = file.readUInt8(at)
    const len = file.readUInt32BE(at + 1)
    records.push({ tag, bytes: file.subarray(at + 11, at + 11 + len) })
    at += 11 + len
  }
  return records
}

async function start(name, path, argv, ready, capture = null) {
  const preload = capture ? ["--import", here("./capture-preload.mjs")] : []
  const env = capture ? { ...process.env, TESERA_E2E_CAPTURE: capture } : process.env
  const proc = spawn(process.execPath, [...preload, path, ...argv], { stdio: ["ignore", "pipe", "pipe"], env })
  children.add(proc)
  const log = []
  const listeners = new Set()
  const read = (data) => {
    log.push(String(data))
    for (const check of listeners) check()
  }
  proc.stdout.on("data", read)
  proc.stderr.on("data", read)
  const match = (pattern) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = log.join("").match(pattern)
        if (!found) return
        listeners.delete(check)
        resolve(found[1])
      }
      listeners.add(check)
      check()
      setTimeout(() => reject(new Error(`${name} did not print ${pattern}: ${log.join("")}`)), 15_000)
    })
  const port = Number(await match(ready))
  return {
    proc,
    port,
    log,
    match,
    stop: async () => {
      proc.kill("SIGTERM")
      await new Promise((resolve) => proc.once("exit", resolve))
      return log.join("")
    },
  }
}

function chrome(url, name) {
  const profile = `${out}chrome-${name}-${Math.random().toString(36).slice(2)}`
  const proc = spawn(args.chrome, [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
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

function parseSize(value) {
  const match = /^(\d+)(b|kb|mb|gb)?$/i.exec(value)
  if (!match) throw new Error(`not a size: ${value}`)
  return Number(match[1]) * { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(match[2] ?? "b").toLowerCase()]
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
