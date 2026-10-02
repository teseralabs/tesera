export type LogFields = Record<string, string | number>

export type LogLevel = "error" | "info" | "debug"

const LOG_RANK: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 }

/** True when an event at `event` should print for a relay configured at `level`. */
export function allowsLog(level: LogLevel, event: LogLevel): boolean {
  return LOG_RANK[event] <= LOG_RANK[level]
}

/** One operational log line. Command results such as `tesera session` are not logs. */
export function formatLog(role: string, event: string, fields: LogFields = {}, now = new Date()): string {
  const parts = [stamp(now), `role=${role}`, `event=${event}`]
  for (const [key, value] of Object.entries(fields)) {
    if (/\s/.test(String(value))) throw new Error(`log value for ${key} contains whitespace`)
    parts.push(`${key}=${value}`)
  }
  return parts.join(" ")
}

export function stamp(now = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
}
