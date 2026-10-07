import type { LogLevel } from "../log.js"

/** How long a seed remembers a relay after it stops reporting. */
export const DEFAULT_PEER_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Three missed usage reports. A relay reports every 5 seconds. */
export const DEFAULT_PEER_OFFLINE_MS = 15_000

/**
 * Relay settings. Command flags set these today. A new switch should be a field
 * here, with a default that leaves a relay started without the flag unchanged.
 */
export type RelaySettings = {
  logLevel: LogLevel
  /** Cumulative bytes and transfers, reloaded on the next start. Null leaves counters in memory. */
  analyticsFile: string | null
  /** TCP address for the relay API. Null leaves the API off. */
  api: { host: string; port: number } | null
  /** How long a quiet relay stays remembered, in milliseconds. */
  peerTtlMs: number
  /** Remembered relays, reloaded on the next start. Null keeps them in memory. */
  peersFile: string | null
}

export function defaultRelaySettings(): RelaySettings {
  return { logLevel: "info", analyticsFile: null, api: null, peerTtlMs: DEFAULT_PEER_TTL_MS, peersFile: null }
}

/** `--peer-ttl`. A bare number is days. `0s` forgets a relay as soon as it goes quiet. */
export function parsePeerTtl(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value)
  if (!match?.[1]) throw new Error("--peer-ttl must be a duration such as 30d, 12h, 30m, or 45s")
  const count = Number(match[1])
  const unit = match[2] ?? "d"
  const scale = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  const ms = count * scale
  if (!Number.isSafeInteger(ms)) throw new Error("--peer-ttl is too large")
  return ms
}

export function parseLogLevel(value: string): LogLevel {
  if (value === "error" || value === "info" || value === "debug") return value
  throw new Error("--log-level must be error, info, or debug")
}
