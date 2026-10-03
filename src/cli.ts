#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { open, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { DEFAULT_RELAY_PORT, resolveEndpoint, resolveRelayRef, splitRelayRef } from "./carrier/resolve.js"
import { listenPublicApi } from "./api/public.js"
import { isLoopback, normalizeHost, parseEndpoint, parseListen, type Endpoint } from "./carrier/udp.js"
import { confirmRelay } from "./identity/confirm.js"
import { identityFromSecret, generateIdentity, type Identity } from "./identity/id.js"
import {
  decodeRecord,
  DEFAULT_RECORD_TTL_SEC,
  fetchRelayRecord,
  recordDocument,
  recordFresh,
  verifyRecord,
} from "./identity/record.js"
import { discoverRelays } from "./identity/peers.js"
import { readRelaySnapshot } from "./identity/stats.js"
import { allowsLog, formatLog, type LogFields, type LogLevel } from "./log.js"
import { parseLogLevel, parsePeerTtl } from "./relay/config.js"
import { canonicalRelayId, DEFAULT_DATAGRAM_RATE, fillPolicy, parseAccess, parseBandwidth, readPolicy, writePolicy } from "./relay/policy.js"
import { formatSession, parseSession } from "./crypto/session.js"
import { Relay } from "./relay/relay.js"
import { fillAdversity, type Adversity } from "./sim/network.js"
import { TeseraReceiver } from "./transport/receiver.js"
import { TeseraSender } from "./transport/sender.js"
import { asError } from "./util.js"

const HELP = `tesera session
tesera id [--out FILE]
tesera relay --listen 0.0.0.0:4101 [--identity FILE] [--join [relay:ID@]relay.tesera.net] [--allow-remote] [--allow-dest CIDR] [--advertise HOST:PORT] [--name TEXT] [--record-file FILE] [--record-ttl SECONDS] [--access private] [--bandwidth 5mbps] [--max-sessions 8] [--peer-rate 6] [--datagram-rate 2000] [--policy-file FILE] [--allow RELAY] [--block RELAY] [--log-level info] [--metrics-file FILE] [--peers-file FILE] [--api HOST:PORT] [--peer-ttl 30d]
tesera info relay:ID@host:port [--json]
tesera allow RELAY --policy-file FILE
tesera block RELAY --policy-file FILE
tesera unblock RELAY --policy-file FILE
tesera forget RELAY --policy-file FILE
tesera api --listen 127.0.0.1:4190 [--discover [relay:ID@]relay.tesera.net] [--advertise 127.0.0.1] [--trust-proxy ADDR] [--log-level info]
tesera recv --listen 0.0.0.0:4200 --sender HOST:4300 --discover [relay:ID@]relay.tesera.net --session SESSION --output FILE
tesera send --listen 0.0.0.0:4300 --receiver HOST:4200 --discover [relay:ID@]relay.tesera.net --session SESSION --input FILE
tesera stats --via relay.tesera.net [--json]
`

type Flags = Map<string, string | true>

function parseFlags(argv: string[]): Flags {
  const flags: Flags = new Map()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token?.startsWith("--")) throw new Error(`unexpected argument ${token ?? ""}`)
    const key = token.slice(2)
    if (!key) throw new Error("empty flag")
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) flags.set(key, true)
    else {
      flags.set(key, next)
      i++
    }
  }
  return flags
}

function optionalString(flags: Flags, key: string): string | undefined {
  const value = flags.get(key)
  if (value === undefined) return undefined
  if (value === true) throw new Error(`--${key} needs a value`)
  return value
}

function requiredString(flags: Flags, key: string): string {
  const value = optionalString(flags, key)
  if (value === undefined) throw new Error(`missing --${key}`)
  return value
}

function numberFlag(flags: Flags, key: string, fallback: number): number {
  const value = optionalString(flags, key)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid --${key}`)
  return parsed
}

function intFlag(flags: Flags, key: string, fallback: number): number {
  const parsed = numberFlag(flags, key, fallback)
  if (!Number.isInteger(parsed)) throw new Error(`--${key} must be an integer`)
  return parsed
}

function flagOn(flags: Flags, key: string): boolean {
  return flags.get(key) === true
}

function repeated(argv: string[], key: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== `--${key}`) continue
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) throw new Error(`--${key} needs a value`)
    out.push(next)
    i++
  }
  return out
}

function commandArgs(argv: string[]): { id: string; flags: Flags } {
  const positional: string[] = []
  const flagArgs: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token) continue
    if (token.startsWith("--")) {
      flagArgs.push(token)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        flagArgs.push(next)
        i++
      }
      continue
    }
    positional.push(token)
  }
  if (positional.length !== 1) throw new Error("expected one relay id")
  return { id: positional[0] ?? "", flags: parseFlags(flagArgs) }
}

async function editPolicy(op: "allow" | "block" | "unblock" | "forget", argv: string[]): Promise<void> {
  const { id: raw, flags } = commandArgs(argv)
  const path = resolve(requiredString(flags, "policy-file"))
  const id = canonicalRelayId(raw)
  const file = await readPolicy(path)
  if (op === "allow") {
    file.blocked = file.blocked.filter((item) => item !== id)
    if (!file.allowed.includes(id)) file.allowed.push(id)
  } else if (op === "block") {
    file.allowed = file.allowed.filter((item) => item !== id)
    if (!file.blocked.includes(id)) file.blocked.push(id)
  } else if (op === "unblock") {
    file.blocked = file.blocked.filter((item) => item !== id)
  } else if (!file.forget.includes(id)) file.forget.push(id)
  await writePolicy(path, file)
}

function peerTtl(flags: Flags): number | undefined {
  const value = optionalString(flags, "peer-ttl")
  if (value === undefined) return undefined
  return parsePeerTtl(value)
}

function emit(level: LogLevel, configured: LogLevel, role: string, event: string, fields: LogFields = {}): void {
  if (!allowsLog(configured, level)) return
  console.log(formatLog(role, event, fields))
}

async function resolveRelays(flags: Flags, role: "sender" | "receiver"): Promise<Endpoint[]> {
  const discover = optionalString(flags, "discover")
  const listed = optionalString(flags, "relays")
  if (discover !== undefined && listed !== undefined) throw new Error("use either --discover or --relays")
  if (discover !== undefined) {
    const ref = await resolveRelayRef(discover)
    const seed = ref.endpoint
    const found = await discoverRelays(seed, { pinned: ref.id })
    console.log(formatLog(role, "discover", { relays: found.length, via: `${seed.host}:${seed.port}` }))
    return found.map((relay) => relay.endpoint)
  }
  return confirmedRelays(flags)
}

async function confirmedRelays(flags: Flags): Promise<Endpoint[]> {
  const refs = await Promise.all(
    requiredString(flags, "relays")
      .split(",")
      .filter((part) => part.length > 0)
      .map((part) => resolveRelayRef(part)),
  )
  await Promise.all(refs.flatMap((ref) => (ref.id === null ? [] : [confirmRelay(ref.endpoint, ref.id)])))
  return refs.map((ref) => ref.endpoint)
}

async function loadIdentity(value: string): Promise<Identity> {
  const trimmed = value.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed) && !existsSync(trimmed)) return identityFromSecret(trimmed)
  return identityFromSecret(await readFile(trimmed, "utf8"))
}

function adversityFromFlags(flags: Flags): Partial<Adversity> {
  return fillAdversity({
    lossRate: numberFlag(flags, "loss", 0),
    delayMs: numberFlag(flags, "delay-ms", 0),
    jitterMs: numberFlag(flags, "jitter-ms", 0),
    reorderMs: numberFlag(flags, "reorder-ms", 0),
    bandwidthBps: numberFlag(flags, "bandwidth-bps", 0),
    blackhole: flagOn(flags, "blackhole"),
  })
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP)
    return
  }
  if (command === "allow" || command === "block" || command === "unblock" || command === "forget") {
    await editPolicy(command, rest)
    return
  }
  if (command === "relay") {
    await runRelay(rest)
    return
  }
  if (command === "info") {
    await runInfo(rest)
    return
  }
  const flags = parseFlags(rest)
  if (command === "session") {
    console.log(formatSession(randomBytes(32)))
    return
  }
  if (command === "id") {
    await runId(flags)
    return
  }
  if (command === "api") await runApi(rest)
  else if (command === "recv") await runRecv(flags)
  else if (command === "send") await runSend(flags)
  else if (command === "stats") await runStats(flags)
  else throw new Error(`unknown command ${command}`)
}

async function runId(flags: Flags): Promise<void> {
  const identity = generateIdentity()
  const out = optionalString(flags, "out")
  if (out) await writeFile(resolve(out), `${identity.secret.toString("hex")}\n`, { mode: 0o600 })
  else console.error(`secret ${identity.secret.toString("hex")}`)
  console.log(identity.id)
}

async function runRelay(argv: string[]): Promise<void> {
  const flags = parseFlags(argv)
  const listen = parseListen(requiredString(flags, "listen"))
  const identityValue = optionalString(flags, "identity")
  const identity = identityValue ? await loadIdentity(identityValue) : undefined
  const recordName = optionalString(flags, "name") ?? ""
  const recordFileFlag = optionalString(flags, "record-file")
  const advertise = repeated(argv, "advertise").map((value) => parseEndpoint(value))
  if ((recordName || recordFileFlag || advertise.length > 0 || flags.has("record-ttl")) && !identity) {
    throw new Error("a signed record needs --identity")
  }
  const joinText = optionalString(flags, "join")
  if (joinText && !identity) throw new Error("--join needs --identity")
  const access = parseAccess(optionalString(flags, "access") ?? "private")
  if (access === "open" && !identity) {
    throw new Error("--access open needs --identity, because a relay without one cannot answer joins")
  }
  const join = joinText ? splitRelayRef(joinText) : null
  const allowRemote = flagOn(flags, "allow-remote")
  if (join && !allowRemote && !isLoopbackName(join.host)) {
    throw new Error("--join needs --allow-remote, because a relay without it cannot answer a remote seed")
  }
  const logLevel = parseLogLevel(optionalString(flags, "log-level") ?? "info")
  const metricsFile = optionalString(flags, "metrics-file")
  const peersFile = optionalString(flags, "peers-file")
  const policyFile = optionalString(flags, "policy-file")
  const apiText = optionalString(flags, "api")
  const policy = fillPolicy({
    access,
    bandwidthBps: parseBandwidth(optionalString(flags, "bandwidth") ?? "5mbps"),
    maxSessions: intFlag(flags, "max-sessions", 8),
    peerRatePerMin: intFlag(flags, "peer-rate", 6),
    datagramRatePerSec: intFlag(flags, "datagram-rate", DEFAULT_DATAGRAM_RATE),
    allowed: repeated(argv, "allow").map(canonicalRelayId),
    blocked: repeated(argv, "block").map(canonicalRelayId),
  })
  const relay = new Relay({
    host: listen.host,
    port: listen.port,
    seed: intFlag(flags, "seed", 1),
    allowRemote,
    allowDest: repeated(argv, "allow-dest"),
    adversity: adversityFromFlags(flags),
    identity,
    log: (line) => console.log(line),
    logLevel,
    analyticsFile: metricsFile ? resolve(metricsFile) : undefined,
    peersFile: peersFile ? resolve(peersFile) : undefined,
    api: apiText ? parseListen(apiText) : undefined,
    peerTtlMs: peerTtl(flags),
    policy,
    policyFile: policyFile ? resolve(policyFile) : undefined,
    advertise,
    recordName,
    recordTtlSec: intFlag(flags, "record-ttl", DEFAULT_RECORD_TTL_SEC),
    recordFile: recordFileFor(identityValue, recordFileFlag),
  })
  const endpoint = await relay.start()
  emit("info", logLevel, "relay", "listen", { addr: `${endpoint.host}:${endpoint.port}` })
  if (identity) emit("info", logLevel, "relay", "id", { id: identity.id })
  if (joinText && join) {
    try {
      await relay.stayJoined({
        label: `${join.host}:${join.port}`,
        id: join.id,
        resolve: async () => (await resolveRelayRef(joinText)).endpoint,
      })
    } catch (err) {
      await relay.close()
      throw err
    }
  }
  await new Promise<void>((resolve) => {
    const stop = () => {
      resolve()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  await relay.close()
  const stats = relay.stats
  emit("info", logLevel, "relay", "done", {
    forwarded: stats.forwarded,
    loss: stats.droppedLoss,
    blackhole: stats.droppedBlackhole,
    denied: stats.droppedDenied,
    invalid: stats.droppedInvalid,
    limited: stats.droppedLimited,
    bytes: stats.forwardedBytes,
  })
}

function isLoopbackName(host: string): boolean {
  try {
    return isLoopback(normalizeHost(host))
  } catch {
    return false
  }
}

function recordFileFor(identityValue: string | undefined, explicit: string | undefined): string | undefined {
  if (explicit) return resolve(explicit)
  if (!identityValue) return undefined
  const trimmed = identityValue.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed) && !existsSync(trimmed)) return undefined
  return resolve(`${trimmed}.record`)
}

async function runInfo(argv: string[]): Promise<void> {
  const positional: string[] = []
  const flagArgs: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token) continue
    if (token.startsWith("--")) {
      flagArgs.push(token)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        flagArgs.push(next)
        i++
      }
      continue
    }
    positional.push(token)
  }
  if (positional.length !== 1) throw new Error("expected relay:ID@host:port")
  const flags = parseFlags(flagArgs)
  const ref = await resolveRelayRef(positional[0] ?? "")
  if (!ref.id) throw new Error("tesera info needs relay:ID@host:port")
  const pinned = ref.id
  const endpoint = ref.endpoint
  const [packet, reachable] = await Promise.all([
    fetchRelayRecord(endpoint).then(
      (body) => body,
      () => null,
    ),
    confirmRelay(endpoint, pinned).then(
      () => true,
      () => false,
    ),
  ])
  if (!packet) throw new Error(`relay ${endpoint.host}:${endpoint.port} did not return a record`)
  const decoded = decodeRecord(packet)
  const verified = decoded ? verifyRecord(decoded) : false
  const idMatch = Boolean(verified && decoded && decoded.id === pinned)
  const fresh = Boolean(verified && decoded && recordFresh(decoded, Math.floor(Date.now() / 1000)))
  const advertised = Boolean(
    verified && decoded && decoded.addresses.some((item) => item.host === endpoint.host && item.port === endpoint.port),
  )
  const doc = recordDocument(packet)
  if (flagOn(flags, "json")) {
    console.log(
      JSON.stringify({
        packet: packet.toString("base64"),
        record: doc?.record ?? null,
        checks: {
          signature: verified ? "valid" : "invalid",
          pinned: !verified ? "unchecked" : idMatch ? "match" : "mismatch",
          fresh,
          reachable,
          advertised,
        },
      }),
    )
  } else {
    const lines = [
      `id=${decoded?.id ?? ""}`,
      `signature=${verified ? "valid" : "invalid"}`,
      `pinned=${!verified ? "unchecked" : idMatch ? "match" : "mismatch"}`,
      `fresh=${fresh ? "yes" : "no"}`,
      `reachable=${reachable ? "yes" : "no"}`,
      `advertised=${advertised ? "yes" : "no"}`,
    ]
    if (decoded && verified) {
      lines.push(
        `seq=${decoded.seq.toString()}`,
        `issued=${decoded.issuedAt}`,
        `ttl=${decoded.ttl}`,
        `wire=${decoded.wire}`,
        `implementation=${decoded.implementation}`,
        `version=${decoded.software}`,
        `build=${decoded.build}`,
        `manifest=${decoded.manifest}`,
        `capabilities=${decoded.capabilities.join(",")}`,
        `addresses=${decoded.addresses.map((item) => `${item.host}:${item.port}`).join(",")}`,
        `name=${decoded.name}`,
      )
    }
    console.log(lines.join("\n"))
  }
  if (!verified || !idMatch || !fresh || !reachable || !advertised) process.exitCode = 1
}

async function runApi(argv: string[]): Promise<void> {
  const flags = parseFlags(argv)
  const listen = parseListen(requiredString(flags, "listen"))
  const logLevel = parseLogLevel(optionalString(flags, "log-level") ?? "info")
  const discover = await resolveRelayRef(optionalString(flags, "discover") ?? "relay.tesera.net")
  const advertise = normalizeHost(optionalString(flags, "advertise") ?? "127.0.0.1")
  const api = await listenPublicApi(listen.host, listen.port, {
    discover: discover.endpoint,
    discoverId: discover.id,
    advertise,
    trustProxy: repeated(argv, "trust-proxy"),
    log: (event, fields) => {
      emit(event === "error" ? "error" : "info", logLevel, "api", event, fields)
    },
  })
  await new Promise<void>((resolve) => {
    const stop = () => {
      resolve()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  await api.close()
}

async function runRecv(flags: Flags): Promise<void> {
  const listen = parseListen(requiredString(flags, "listen"))
  const session = parseSession(requiredString(flags, "session"))
  const receiver = new TeseraReceiver({
    session,
    relays: await resolveRelays(flags, "receiver"),
    sender: await resolveEndpoint(requiredString(flags, "sender")),
    bindHost: listen.host,
    bindPort: listen.port,
    nackAfterMs: intFlag(flags, "nack-after-ms", 40),
  })
  const endpoint = await receiver.start()
  console.log(formatLog("receiver", "listen", { addr: `${endpoint.host}:${endpoint.port}` }))
  const output = await open(resolve(requiredString(flags, "output")), "w")
  const hash = createHash("sha256")
  let bytes = 0
  try {
    for (;;) {
      const chunk = await receiver.read()
      if (!chunk) break
      await output.write(chunk)
      hash.update(chunk)
      bytes += chunk.length
    }
    await output.close()
    const stats = receiver.stats
    const recovery = receiver.recoveryCounts()
    const latencyMs = stats.latencyCount > 0 ? stats.latencySumMs / stats.latencyCount : 0
    console.log(
      formatLog("receiver", "done", {
        bytes,
        sha256: hash.digest("hex"),
        blocks: stats.blocksDecoded,
        partial: recovery.blocksWithoutAllTesserae,
        acks: stats.acksSent,
        nacks: stats.nacksSent,
        "latency-ms": latencyMs.toFixed(1),
      }),
    )
    await receiver.linger()
  } finally {
    await output.close().catch(() => {})
    await receiver.close()
  }
}

async function runSend(flags: Flags): Promise<void> {
  const listen = parseListen(requiredString(flags, "listen"))
  const session = parseSession(requiredString(flags, "session"))
  const sender = new TeseraSender({
    session,
    relays: await resolveRelays(flags, "sender"),
    receiver: await resolveEndpoint(requiredString(flags, "receiver")),
    bindHost: listen.host,
    bindPort: listen.port,
    k: intFlag(flags, "k", 2),
    n: intFlag(flags, "n", 3),
    shardSize: intFlag(flags, "shard", 1024),
    window: intFlag(flags, "window", 32),
    maxSends: intFlag(flags, "max-sends", 24),
    retxAfterMs: intFlag(flags, "retx-after-ms", 120),
  })
  const endpoint = await sender.start()
  console.log(formatLog("sender", "listen", { addr: `${endpoint.host}:${endpoint.port}` }))
  const input = await open(resolve(requiredString(flags, "input")), "r")
  const started = performance.now()
  let bytes = 0
  try {
    const buf = Buffer.alloc(64 * 1024)
    for (;;) {
      const { bytesRead } = await input.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      await sender.write(buf.subarray(0, bytesRead))
      bytes += bytesRead
    }
    await sender.end()
  } finally {
    await input.close()
    await sender.close()
  }
  const elapsedMs = performance.now() - started
  const overhead = bytes > 0 ? sender.stats.dataWireBytes / bytes : 0
  const mbps = elapsedMs > 0 ? (bytes * 8) / elapsedMs / 1000 : 0
  console.log(
    formatLog("sender", "done", {
      bytes,
      seconds: (elapsedMs / 1000).toFixed(3),
      mbps: mbps.toFixed(2),
      overhead: overhead.toFixed(2),
      blocks: sender.stats.blocks,
      tesserae: sender.stats.tesseraSends,
      retransmits: sender.stats.tesseraRetransmissions,
    }),
  )
}

async function runStats(flags: Flags): Promise<void> {
  const via = await resolveEndpoint(requiredString(flags, "via"), DEFAULT_RELAY_PORT)
  const snapshot = await readRelaySnapshot(via)
  if (flagOn(flags, "json")) console.log(JSON.stringify(snapshot))
  else console.log(`relays=${snapshot.relays} bytes=${snapshot.bytes} transfers=${snapshot.transfers}`)
}

main().catch((err) => {
  console.error(asError(err).message)
  process.exitCode = 1
})
