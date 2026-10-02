import { readFile, rename, writeFile } from "node:fs/promises"
import { normalizeHost } from "../carrier/udp.js"
import { parseId } from "../identity/id.js"
import { MAX_INTRODUCED } from "../identity/peers.js"

export type StoredPeer = {
  id: string
  host: string
  port: number
  seenAt: number
  seq: number
  bytes: number
  transfers: number
}

export async function readPeers(path: string): Promise<StoredPeer[]> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (err) {
    if (isEnoent(err)) return []
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("peers file is not valid JSON")
  }
  if (!parsed || typeof parsed !== "object") throw new Error("peers file is not an object")
  const peers = (parsed as { peers?: unknown }).peers
  if (!Array.isArray(peers)) throw new Error("peers file needs a peers array")
  if (peers.length > MAX_INTRODUCED) throw new Error("peers file lists too many relays")
  const seen = new Set<string>()
  return peers.map((entry) => {
    const peer = readPeer(entry)
    if (seen.has(peer.id)) throw new Error("peers file lists a relay twice")
    seen.add(peer.id)
    return peer
  })
}

export async function writePeers(path: string, peers: StoredPeer[]): Promise<void> {
  const body = {
    peers: peers.map((peer) => ({
      id: peer.id,
      host: peer.host,
      port: peer.port,
      seenAt: peer.seenAt,
      seq: peer.seq,
      bytes: peer.bytes,
      transfers: peer.transfers,
    })),
  }
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

function readPeer(entry: unknown): StoredPeer {
  if (!entry || typeof entry !== "object") throw new Error("peers file has a bad relay")
  const record = entry as {
    id?: unknown
    host?: unknown
    port?: unknown
    seenAt?: unknown
    seq?: unknown
    bytes?: unknown
    transfers?: unknown
  }
  if (typeof record.id !== "string") throw new Error("peers file has a bad relay id")
  const id = record.id.trim().toLowerCase()
  try {
    parseId(id)
  } catch {
    throw new Error("peers file has a bad relay id")
  }
  if (typeof record.host !== "string") throw new Error("peers file has a bad relay address")
  let host: string
  try {
    host = normalizeHost(record.host)
  } catch {
    throw new Error("peers file has a bad relay address")
  }
  if (!isPort(record.port) || !isCount(record.seenAt) || !isCount(record.seq)) {
    throw new Error("peers file has a bad relay address")
  }
  if (!isCount(record.bytes) || !isCount(record.transfers)) throw new Error("peers file has bad relay totals")
  return { id, host, port: record.port, seenAt: record.seenAt, seq: record.seq, bytes: record.bytes, transfers: record.transfers }
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT"
}
