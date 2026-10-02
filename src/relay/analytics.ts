import { readFile, rename, writeFile } from "node:fs/promises"

export type AnalyticsTotals = {
  bytes: number
  transfers: number
}

export async function readAnalytics(path: string): Promise<AnalyticsTotals> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (err) {
    if (isEnoent(err)) return { bytes: 0, transfers: 0 }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("metrics file is not valid JSON")
  }
  if (!parsed || typeof parsed !== "object") throw new Error("metrics file is not an object")
  const record = parsed as { bytes?: unknown; transfers?: unknown }
  if (!isCount(record.bytes)) throw new Error("metrics bytes must be a non-negative integer")
  if (!isCount(record.transfers)) throw new Error("metrics transfers must be a non-negative integer")
  return { bytes: record.bytes, transfers: record.transfers }
}

export async function writeAnalytics(path: string, totals: AnalyticsTotals): Promise<void> {
  if (!isCount(totals.bytes) || !isCount(totals.transfers)) throw new Error("metrics totals must be non-negative integers")
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify({ bytes: totals.bytes, transfers: totals.transfers })}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT"
}
