// Throughput benchmarks for each path a transfer can take, on one machine:
//
//   A  native sender --UDP--> relays B, C, D --UDP--> native receiver
//   B  Chrome sender --WebTransport--> relay A --UDP--> B, C, D --UDP--> native receiver
//   C  native sender --UDP--> B, C, D --UDP--> relay A --WebTransport--> Chrome receiver
//   D  Chrome --WebTransport--> relay A --UDP--> B, C, D --UDP--> relay A --WebTransport--> Chrome
//   E  Chrome --WebTransport--> relay A --UDP--> B, C, D --UDP--> relay E --WebTransport--> Chrome
//
// B, C, and D are an older release's ordinary UDP relays. A and E are this repository's relay with
// browser attachments, from attach-relay.mjs. Every run starts a fresh set of relays. With
// --delay-ms, every UDP send from relay A, relay E, and a native endpoint waits that long, so each
// round trip gains twice the delay on every path. Pages attach straight to their relay: there is no
// control plane, so setup time stays out of the numbers.
//
//   (cd ../../.. && npm run build) && npm run build
//   node e2e/bench.mjs --path D [--size 100mb] [--repeat 3] [--probe] [--profile] [--sink opfs|null]
//                      [--delay-ms 0] [--jitter-ms 0] [--loss 0] [--window 32] [--shard 973]
//                      [--kill-relay] [--label NAME]
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { parseArgs } from "node:util"
import { build } from "esbuild"
import { clientRuntime, common } from "../esbuild-runtime.mjs"
import { launch } from "./cdp.mjs"
import { payload } from "./payload.js"

const { values: args } = parseArgs({
  options: {
    path: { type: "string", default: "D" },
    size: { type: "string", default: "100mb" },
    repeat: { type: "string", default: "1" },
    probe: { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
    sink: { type: "string", default: "opfs" },
    "delay-ms": { type: "string", default: "0" },
    "jitter-ms": { type: "string", default: "0" },
    loss: { type: "string", default: "0" },
    window: { type: "string" },
    shard: { type: "string" },
    "kill-relay": { type: "boolean", default: false },
    paths: { type: "string", default: "3" },
    production: { type: "string" },
    k: { type: "string" },
    n: { type: "string" },
    "fixed-window": { type: "boolean", default: false },
    "max-buffered": { type: "string" },
    label: { type: "string" },
    "udp-cli": { type: "string", default: new URL("../../../tmp/v021/dist/src/cli.js", import.meta.url).pathname },
    chrome: { type: "string", default: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  },
})
const here = (path) => new URL(path, import.meta.url).pathname
const out = here("./out/bench/")
mkdirSync(out, { recursive: true })
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

const path = args.path.toUpperCase()
const ends = { A: ["native", "native"], B: ["chrome", "native"], C: ["native", "chrome"], D: ["chrome", "chrome"], E: ["chrome", "chrome"] }[path]
if (!ends) throw new Error("--path is A, B, C, D, or E")
const size = parseSize(args.size)
const delayMs = Number(args["delay-ms"])
const jitterMs = Number(args["jitter-ms"])
const loss = Number(args.loss)
const window = args.window ? Number(args.window) : null
const label =
  args.label ??
  `${args.production ? `live-${args.production}-${args["fixed-window"] ? "fixed-" : ""}` : ""}path${path}-${args.size}${delayMs ? `-delay${delayMs}` : ""}${jitterMs ? `-jitter${jitterMs}` : ""}${loss ? `-loss${loss}` : ""}${window ? `-window${window}` : ""}${args.shard ? `-shard${args.shard}` : ""}${args.sink !== "opfs" ? `-sink${args.sink}` : ""}${args.paths !== "3" ? `-paths${args.paths}` : ""}${args["kill-relay"] ? "-kill" : ""}${args.probe ? "-probe" : ""}`

// The page, built with the window this run asks for. Only the benchmark build changes it.
const windowPlugin = {
  name: "bench-window",
  setup(b) {
    b.onLoad({ filter: /src\/constants\.ts$/ }, (found) => {
      let text = readFileSync(found.path, "utf8")
      if (window) text = text.replace(/export const DEFAULT_WINDOW = \d+/, `export const DEFAULT_WINDOW = ${window}`)
      if (window && args["fixed-window"]) text = text.replace(/export const INITIAL_WINDOW = \d+/, `export const INITIAL_WINDOW = ${window}`)
      return { contents: text, loader: "ts" }
    })
    // --fixed-window holds the window where it starts: losses are still resent, but never cut it.
    b.onLoad({ filter: /src\/transport\/sender\.ts$/ }, (found) => {
      let text = readFileSync(found.path, "utf8")
      if (args["fixed-window"]) text = text.replace("if (!this.scheduler.hasObservation) return", "return")
      return { contents: text, loader: "ts" }
    })
  },
}
if (ends.includes("chrome")) {
  await build({ ...common, entryPoints: [here("./bench-page.js")], outfile: `${out}bench-page.js`, platform: "browser", target: "chrome120", plugins: [windowPlugin, clientRuntime()] })
}
if (window && ends.includes("native")) step(`--window ${window} applies to native ends through their option, and to pages through their build`)

const runs = []
for (let i = 1; i <= Number(args.repeat); i++) runs.push(await runOnce(i))
const summary = summarize(runs)
writeFileSync(`${out}${label}.json`, JSON.stringify({ label, args, runs, summary }, null, 2))
step(`${label}: ${JSON.stringify(summary)}`)
process.exit(runs.every((r) => r.ok) ? 0 : 1)

async function runOnce(index) {
  const seed = 1 + Math.floor(Math.random() * 0xfffffff0)
  const expected = digest(seed, size)
  const prof = args.profile ? `${out}prof-${label}-${index}/` : null
  if (prof) mkdirSync(prof, { recursive: true })
  const relayArgs = ["--delay-ms", String(delayMs), "--jitter-ms", String(jitterMs), "--loss", String(loss)]
  const live = args.production ? await liveNetwork(args.production) : null
  const A = live ? null : await attachRelay("a", relayArgs, prof)
  const E = path === "E" && !live ? await attachRelay("e", relayArgs, prof) : null
  const udp = []
  if (!live) for (const name of ["b", "c", "d"].slice(0, Number(args.paths))) udp.push(await udpRelay(name, prof))
  // --paths 0 forwards through relay A's own UDP side, as a lone public relay does in fast mode.
  const own = A && args.paths === "0" ? [{ host: "127.0.0.1", port: typeof A.udp === "object" ? A.udp.port : Number(String(A.udp).split(":").pop()) }] : null
  const relays = live ? live.relays : (own ?? udp.map((r) => ({ host: "127.0.0.1", port: r.port })))
  const entry = live ? live.entry : { url: `https://127.0.0.1:${A.webtransport.port}`, certificateHash: A.certificateHash }

  const mail = {}
  const reports = {}
  const failures = []
  let started = null
  const pages = {}
  const config = {
    relays,
    size,
    seed,
    probe: args.probe,
    sink: args.sink,
    entry,
    receiverEntry: E ? { url: `https://127.0.0.1:${E.webtransport.port}`, certificateHash: E.certificateHash } : entry,
    ...(args.k ? { coding: { k: Number(args.k), n: Number(args.n ?? args.k) } } : {}),
    native: { delayMs, jitterMs, loss },
    ...(window ? { window } : {}),
    ...(args.shard ? { shard: Number(args.shard), nativeMaxPacket: Number(args.shard) + 44 } : {}),
    ...(args["max-buffered"] ? { maxBufferedBytes: Number(args["max-buffered"]) } : {}),
  }
  const server = createServer(async (req, res) => {
    const body = req.method === "POST" ? JSON.parse((await text(req)) || "null") : null
    const url = new URL(req.url, "http://127.0.0.1")
    if (url.pathname === "/config") return json(res, config)
    if (url.pathname.startsWith("/signal/")) {
      const name = url.pathname.slice(8)
      if (req.method === "POST") {
        mail[name] = body
        if (name === "answer") {
          started = Date.now()
          for (const page of Object.values(pages)) if (prof) void startProfile(page)
        }
        return res.writeHead(204).end()
      }
      return mail[name] ? json(res, mail[name]) : res.writeHead(204).end()
    }
    if (url.pathname === "/report") {
      reports[body.role] = body
      return res.writeHead(204).end()
    }
    if (url.pathname === "/failed") {
      failures.push(body)
      step(`failed: ${JSON.stringify(body).slice(0, 2000)}`)
      return res.writeHead(204).end()
    }
    if (url.pathname === "/bench-page.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(`${out}bench-page.js`))
    if (url.pathname === "/send" || url.pathname === "/recv") {
      return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>bench</title><script type="module" src="/bench-page.js"></script>`)
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const browsers = {}
  const natives = {}
  for (const [role, kind] of [["send", ends[0]], ["recv", ends[1]]]) {
    if (kind === "chrome") {
      const profile = `${out}chrome-${role}`
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
      const browser = launch(args.chrome, profile)
      children.add(browser.proc)
      browsers[role] = browser
      pages[role] = await browser.page(`${base}/${role}?role=${role}`, {
        onConsole: (line) => step(`${role} console: ${line.slice(0, 500)}`),
      })
    } else {
      const proc = spawn(process.execPath, [...(prof ? ["--cpu-prof", `--cpu-prof-dir=${prof}`, `--cpu-prof-name=native-${role}.cpuprofile`] : []), here("./bench-native.mjs"), "--role", role, "--harness", base], { stdio: ["ignore", "inherit", "inherit"] })
      children.add(proc)
      natives[role] = proc
    }
  }

  const memory = { send: { heap: 0, rss: 0 }, recv: { heap: 0, rss: 0 } }
  let killed = null
  const until = Date.now() + 60_000 + (size / 1e6) * 3_000
  let cpuBefore = null
  while ((!reports.send || !reports.recv) && failures.length === 0 && Date.now() < until) {
    if (started && !cpuBefore) cpuBefore = cpuTable()
    for (const role of ["send", "recv"]) {
      const sample = await sampleMemory(browsers[role], pages[role], natives[role])
      memory[role].heap = Math.max(memory[role].heap, sample.heap)
      memory[role].rss = Math.max(memory[role].rss, sample.rss)
    }
    if (args["kill-relay"] && !killed && reports.send === undefined && started && Date.now() - started > 2000 + (size / 1e6) * 50) {
      killed = udp[2]
      killed.proc.kill("SIGKILL")
      step(`killed UDP relay ${killed.name}`)
    }
    await sleep(250)
  }
  const cpuAfter = cpuTable()
  const wall = started ? (Date.now() - started) / 1000 : 0
  const roots = { relayA: A?.proc.pid, relayE: E?.proc.pid, udp: udp.map((r) => r.proc.pid) }
  for (const role of ["send", "recv"]) roots[role] = browsers[role]?.proc.pid ?? natives[role]?.pid
  const cpu = cpuBefore ? cpuUse(cpuBefore, cpuAfter, wall, roots) : null
  const profiles = {}
  if (prof) for (const [role, page] of Object.entries(pages)) profiles[role] = await stopProfile(page, `${prof}${role}`).catch((err) => ({ error: err.message }))

  const relayReports = {}
  for (const r of [A, E].filter(Boolean)) relayReports[r.name] = await r.stop()
  for (const r of udp) r.proc.kill("SIGTERM")
  await sleep(300)
  for (const browser of Object.values(browsers)) await browser.close()
  for (const proc of Object.values(natives)) proc.kill("SIGKILL")
  server.close()

  const send = reports.send
  const recv = reports.recv
  const ok = !!recv && recv.sha256 === expected && failures.length === 0
  const mbps = recv ? recv.bytes / 1e6 / recv.seconds : null
  const sd = send?.diagnostics ?? {}
  const rd = recv?.diagnostics ?? {}
  const run = {
    index,
    ok,
    sha256Match: recv?.sha256 === expected,
    failures,
    killedRelay: killed?.name ?? null,
    seconds: recv?.seconds ?? null,
    throughputMBps: mbps,
    steadyMBps: recv?.timeline ? steadyRate(recv.timeline, size) : null,
    senderSeconds: send?.seconds ?? null,
    datagram: sd.datagramSize ?? null,
    blocks: sd.blocks ?? null,
    bytesPerBlock: sd.blocks ? sd.inputBytes / sd.blocks : null,
    tesseraSends: sd.tesseraSends ?? null,
    tesseraePerBlock: sd.blocks ? sd.tesseraSends / sd.blocks : null,
    retransmissions: sd.tesseraRetransmissions ?? null,
    windowCuts: sd.windowCuts ?? null,
    meanSampleRttMs: sd.sampleRttCount ? sd.sampleRttSumMs / sd.sampleRttCount : null,
    meanOpenWindow: sd.windowCount ? sd.windowSum / sd.windowCount : null,
    nacksSent: rd.nacksSent ?? null,
    acksSent: rd.acksSent ?? null,
    maxBufferedBlocks: rd.maxBufferedBlocks ?? null,
    maxUnreadBytes: rd.maxUnreadBytes ?? null,
    memoryPeakMB: { send: mb(memory.send), recv: mb(memory.recv) },
    cpuCores: cpu,
    relayPerf: Object.fromEntries(Object.entries(relayReports).map(([name, r]) => [name, r?.perf ?? null])),
    relayStats: Object.fromEntries(Object.entries(relayReports).map(([name, r]) => [name, r?.relay ?? null])),
    attachStats: Object.fromEntries(Object.entries(relayReports).map(([name, r]) => [name, r?.attach ?? null])),
    nativePerf: Object.fromEntries(["send", "recv"].map((role) => [role, reports[role]?.cpuSeconds !== undefined ? { cpuSeconds: reports[role].cpuSeconds, eventLoopDelayMs: reports[role].eventLoopDelayMs, rssMB: reports[role].rssMB, heapMB: reports[role].heapMB } : null])),
    userAgents: { send: send?.userAgent, recv: recv?.userAgent },
    profiles,
    probe: { send: send?.probe ?? null, recv: recv?.probe ?? null },
    timeline: recv?.timeline ?? null,
    diagnostics: { send: sd, recv: rd },
  }
  writeFileSync(`${out}${label}-${index}.json`, JSON.stringify(run, null, 2))
  step(
    `${label} #${index}: ${ok ? "ok" : "FAIL"} ${mbps?.toFixed(2)} MB/s (steady ${run.steadyMBps?.toFixed(2)}) over ${run.seconds?.toFixed(1)} s; ` +
      `datagram ${run.datagram}, ${run.tesseraePerBlock?.toFixed(2)} tesserae/block, ${run.retransmissions} retx, ${run.windowCuts} cuts, rtt ${run.meanSampleRttMs?.toFixed(1)} ms, window ${run.meanOpenWindow?.toFixed(1)}; ` +
      `cpu ${JSON.stringify(cpu)}; mem ${JSON.stringify(run.memoryPeakMB)}`,
  )
  return run
}

async function startProfile(page) {
  await page.call("Profiler.enable")
  await page.call("Profiler.setSamplingInterval", { interval: 250 })
  await page.call("Profiler.start")
  await page.call("HeapProfiler.enable")
  await page.call("HeapProfiler.startSampling", { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
}

/** Saves the CPU and allocation profiles, and returns the top self time and allocation by function. */
async function stopProfile(page, prefix) {
  const { profile } = await page.call("Profiler.stop")
  const { profile: heap } = await page.call("HeapProfiler.stopSampling")
  writeFileSync(`${prefix}.cpuprofile`, JSON.stringify(profile))
  writeFileSync(`${prefix}.heapprofile`, JSON.stringify(heap))
  return { cpu: topSelf(profile), allocation: topAllocation(heap) }
}

function topSelf(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const counts = new Map()
  const interval = (profile.endTime - profile.startTime) / Math.max(1, profile.samples.length)
  for (const id of profile.samples) {
    const frame = byId.get(id)?.callFrame
    const name = frame ? `${frame.functionName || "(anonymous)"} ${frame.url.split("/").pop()}:${frame.lineNumber + 1}` : "?"
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const total = profile.samples.length
  return {
    seconds: (profile.endTime - profile.startTime) / 1e6,
    sampleUs: Math.round(interval),
    top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name, n]) => [name, Math.round((n / total) * 1000) / 10]),
  }
}

function topAllocation(heap) {
  const totals = new Map()
  let all = 0
  const walk = (node) => {
    const self = node.selfSize
    all += self
    const frame = node.callFrame
    const name = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").pop()}:${frame.lineNumber + 1}`
    totals.set(name, (totals.get(name) ?? 0) + self)
    for (const child of node.children) walk(child)
  }
  walk(heap.head)
  return { totalMB: Math.round(all / 1e5) / 10, top: [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, bytes]) => [name, Math.round(bytes / 1e5) / 10]) }
}

/** The live network's entry relay and UDP relays: `fast` is the entry relay alone, `distributed` every listed relay. */
async function liveNetwork(mode) {
  const api = process.env.TESERA_API ?? "https://api.tesera.net"
  const { relays } = await (await fetch(`${api}/v1/relays`)).json()
  const entryRelay = relays.find((r) => r.transports.some((t) => t.type === "webtransport"))
  const wt = entryRelay.transports.find((t) => t.type === "webtransport")
  const udpOf = (r) => r.transports.find((t) => t.type === "udp")
  const chosen = mode === "fast" ? [entryRelay] : relays
  return {
    entry: { url: wt.url, certificateHash: wt.certificateHashes[0].sha256 },
    relays: chosen.map(udpOf).filter(Boolean).map((t) => ({ host: t.host, port: t.port })),
  }
}

async function attachRelay(name, extra, prof) {
  const argv = [...(prof ? ["--cpu-prof", `--cpu-prof-dir=${prof}`, `--cpu-prof-name=relay-${name}.cpuprofile`] : []), here("./attach-relay.mjs"), ...extra]
  const proc = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "inherit"] })
  children.add(proc)
  const lines = []
  let buffer = ""
  const waiters = []
  proc.stdout.on("data", (data) => {
    buffer += data
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      lines.push(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      for (const wake of waiters.splice(0)) wake()
    }
  })
  const line = async (n) => {
    while (lines.length < n) await new Promise((resolve) => waiters.push(resolve))
    return JSON.parse(lines[n - 1])
  }
  const ready = await line(1)
  return {
    name,
    proc,
    ...ready,
    stop: async () => {
      proc.kill("SIGTERM")
      return Promise.race([line(2), sleep(5000).then(() => null)])
    },
  }
}

async function udpRelay(name, prof) {
  const identity = `${out}identity-${name}`
  const { generateIdentity } = await import(new URL("../../../dist/src/identity/id.js", import.meta.url).href)
  writeFileSync(identity, `${generateIdentity().secret.toString("hex")}\n`, { mode: 0o600 })
  const open = ["--allow-remote", "--allow-dest", "127.0.0.0/8", "--access", "open", "--bandwidth", "4000mbps", "--datagram-rate", "1000000"]
  const argv = [...(prof ? ["--cpu-prof", `--cpu-prof-dir=${prof}`, `--cpu-prof-name=udp-${name}.cpuprofile`] : []), args["udp-cli"], "relay", "--listen", "127.0.0.1:0", "--identity", identity, ...open]
  const proc = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] })
  children.add(proc)
  let log = ""
  const port = await new Promise((resolve, reject) => {
    const check = (data) => {
      log += data
      const found = /event=listen addr=127\.0\.0\.1:(\d+)/.exec(log)
      if (found) resolve(Number(found[1]))
    }
    proc.stdout.on("data", check)
    proc.stderr.on("data", check)
    setTimeout(() => reject(new Error(`relay ${name} did not start: ${log}`)), 15_000)
  })
  return { name, proc, port }
}

async function sampleMemory(browser, page, native) {
  let heap = 0
  if (page) heap = await page.call("Runtime.getHeapUsage", {}).then((h) => h.usedSize).catch(() => 0)
  const root = browser?.proc.pid ?? native?.pid
  let rss = 0
  if (root) {
    try {
      const table = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number))
      const tree = new Set([root])
      for (let grew = true; grew; ) {
        grew = false
        for (const [pid, ppid] of table) if (tree.has(ppid) && !tree.has(pid)) (tree.add(pid), (grew = true))
      }
      for (const [pid, , kb] of table) if (tree.has(pid)) rss += kb * 1024
    } catch {}
  }
  return { heap, rss }
}

/** CPU seconds of every process, by pid, with its parent and Chrome process type. */
function cpuTable() {
  const rows = new Map()
  try {
    for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,time=,command="], { encoding: "utf8", maxBuffer: 64 << 20 }).trim().split("\n")) {
      const found = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
      if (!found) continue
      const seconds = found[3].split(":").reduce((sum, part) => sum * 60 + Number(part), 0)
      const type = /--type=(\S+)/.exec(found[4])?.[1]
      const sub = /--utility-sub-type=(\S+)/.exec(found[4])?.[1]
      rows.set(Number(found[1]), { ppid: Number(found[2]), seconds, type: sub ? sub.split(".")[0] : type ?? "main" })
    }
  } catch {}
  return rows
}

/** Cores used over `seconds` by each process tree, split by Chrome process type inside a browser. */
function cpuUse(before, after, seconds, roots) {
  const tree = (root) => {
    const pids = new Set([root])
    for (let grew = true; grew; ) {
      grew = false
      for (const [pid, row] of after) if (pids.has(row.ppid) && !pids.has(pid)) (pids.add(pid), (grew = true))
    }
    return pids
  }
  const used = (pid) => Math.max(0, (after.get(pid)?.seconds ?? 0) - (before.get(pid)?.seconds ?? 0))
  const cores = (value) => Math.round((value / seconds) * 100) / 100
  const result = {}
  for (const [name, root] of Object.entries(roots)) {
    if (root === undefined || root === null) continue
    if (Array.isArray(root)) {
      result[name] = root.map((pid) => cores(used(pid)))
      continue
    }
    const pids = tree(root)
    if (pids.size === 1) {
      result[name] = cores(used(root))
      continue
    }
    const types = {}
    for (const pid of pids) {
      const type = after.get(pid)?.type ?? "gone"
      types[type] = (types[type] ?? 0) + used(pid)
    }
    result[name] = Object.fromEntries(Object.entries(types).filter(([, v]) => v > 0).map(([k, v]) => [k, cores(v)]))
  }
  return result
}

function steadyRate(timeline, total) {
  const at = (share) => timeline.find(([, bytes]) => bytes >= total * share)
  const from = at(0.2)
  const to = at(0.8)
  if (!from || !to || to[0] <= from[0]) return null
  return (to[1] - from[1]) / 1e6 / ((to[0] - from[0]) / 1000)
}

function summarize(list) {
  const pick = (key) => list.map((r) => r[key]).filter((v) => typeof v === "number")
  const stats = (values) => {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    return { median: round(sorted[Math.floor(sorted.length / 2)]), min: round(sorted[0]), max: round(sorted[sorted.length - 1]), n: values.length }
  }
  return {
    ok: list.every((r) => r.ok),
    throughputMBps: stats(pick("throughputMBps")),
    steadyMBps: stats(pick("steadyMBps")),
    retransmissions: stats(pick("retransmissions")),
    meanSampleRttMs: stats(pick("meanSampleRttMs")),
    meanOpenWindow: stats(pick("meanOpenWindow")),
    tesseraePerBlock: stats(pick("tesseraePerBlock")),
  }
}

function round(value) {
  return Math.round(value * 100) / 100
}

function mb(m) {
  return { heap: Math.round(m.heap / 1e5) / 10, rss: Math.round(m.rss / 1e5) / 10 }
}

function json(res, value) {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value))
}

function text(req) {
  return new Promise((resolve) => {
    const parts = []
    req.on("data", (part) => parts.push(part))
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")))
  })
}

function digest(seed, length) {
  const hash = createHash("sha256")
  const bytes = payload(seed, length)
  for (let chunk = bytes.next(1 << 20); chunk; chunk = bytes.next(1 << 20)) hash.update(chunk)
  return hash.digest("hex")
}

function parseSize(value) {
  const found = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i.exec(value)
  if (!found) throw new Error(`bad size ${value}`)
  return Math.round(Number(found[1]) * { b: 1, kb: 1e3, mb: 1e6, gb: 1e9 }[(found[2] ?? "b").toLowerCase()])
}
