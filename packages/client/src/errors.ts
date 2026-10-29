/**
 * What went wrong, at the level an application can act on:
 *
 * - `unsupported`: this runtime lacks what the transport needs, such as WebTransport
 * - `connection`: the transport could not connect to its relay, or lost the connection.
 *   `reason` is `closed` when an attachment that was up closes or fails. Setup failures leave it unset
 * - `incompatible`: the relay speaks another attach or protocol version
 * - `claim`: the relay would not deliver this session here, because another connection holds it or its table is full
 * - `path`: a relay in the transfer cannot be reached through this transport
 * - `transfer`: the transfer failed in flight. `reason` is `idle` when nothing arrived in time, `integrity`
 *   when a block failed its checks, or `stopped` when the cause is not one of those
 * - `cancelled`: the application cancelled, or an authenticated close said the other peer stopped.
 *   `reason` is `sender` or `receiver` when that peer cancelled, and `peer` when that peer
 *   stopped because it failed. A silent peer is not a cancel
 * - `source`: reading the input failed
 * - `sink`: writing the output failed
 * - `invalid`: an option, offer, answer, or secret is malformed
 * - `control`: the control plane could not be reached, or refused: `reason` carries its error, such
 *   as `not_found` for a room that expired or was closed, or `answered` for a room another receiver joined
 */
export type TeseraErrorCode =
  | "unsupported"
  | "connection"
  | "incompatible"
  | "claim"
  | "path"
  | "transfer"
  | "cancelled"
  | "source"
  | "sink"
  | "invalid"
  | "control"

export class TeseraError extends Error {
  override readonly name = "TeseraError"
  /** For a `control` error, the control plane's short error code, or `unreachable`. */
  readonly reason: string | undefined

  constructor(
    readonly code: TeseraErrorCode,
    message: string,
    options?: { cause?: unknown; reason?: string },
  ) {
    super(message, options)
    this.reason = options?.reason
  }
}

/** `err` as a TeseraError, keeping one that already is. */
export function asTeseraError(err: unknown, code: TeseraErrorCode): TeseraError {
  if (err instanceof TeseraError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new TeseraError(code, message, { cause: err })
}

/** Why an in-flight transfer failed, when the wire can say. A silent peer is `idle`, not a cancel. */
export type TransferFailureReason = "idle" | "integrity" | "stopped"

/**
 * The error a transfer should reject with. A local cancel replaces only the error its own close
 * produced. An integrity failure, a stall, or a dropped attachment that is already in `err` stays.
 */
export function reportedFailure(err: unknown, cancelled: boolean): TeseraError {
  const peer = peerClose(err)
  if (peer) return peer
  if (err instanceof TeseraError && err.code === "cancelled") return err
  if (cancelled && localClose(err)) return new TeseraError("cancelled", "the transfer was cancelled")
  return classifyFailure(err)
}

/** An authenticated close, already worded for a person. Anything else is not one. */
function peerClose(err: unknown): TeseraError | null {
  const message = err instanceof Error ? err.message : ""
  const reason = message === "the sender cancelled the transfer" ? "sender" : message === "the receiver cancelled the transfer" ? "receiver" : message === "the other person ended the transfer" ? "peer" : ""
  if (!reason) return null
  return new TeseraError("cancelled", message, { cause: err, reason })
}

function localClose(err: unknown): boolean {
  const message = err instanceof Error ? err.message : ""
  return message === "receiver closed before completion" || message === "sender closed before completion"
}

function classifyFailure(err: unknown): TeseraError {
  if (!(err instanceof Error)) return new TeseraError("transfer", String(err), { reason: "stopped" })
  if (err instanceof TeseraError) {
    if (err.reason || (err.code !== "transfer" && err.code !== "connection")) return err
    if (err.code === "connection") {
      return attachmentClosed(err.message) ? new TeseraError("connection", err.message, { cause: err, reason: "closed" }) : err
    }
    return new TeseraError("transfer", err.message, { cause: err, reason: transferReason(err.message) ?? "stopped" })
  }
  const reason = transferReason(err.message)
  if (reason) return new TeseraError("transfer", err.message, { cause: err, reason })
  if (attachmentClosed(err.message)) return new TeseraError("connection", err.message, { cause: err, reason: "closed" })
  return new TeseraError("transfer", err.message, { cause: err, reason: "stopped" })
}

function transferReason(message: string): TransferFailureReason | undefined {
  if (
    message.startsWith("no block was acknowledged for ") ||
    message.startsWith("no progress for ") ||
    message === "transfer timed out" ||
    /^block \d+ exceeded \d+ transmissions$/.test(message)
  ) {
    return "idle"
  }
  if (message.includes("failed integrity check") || message.includes("tesserae disagree on ")) return "integrity"
  return undefined
}

function attachmentClosed(message: string): boolean {
  return message === "the relay closed the attachment" || message === "the attachment to the relay failed" || message === "the attachment is closed"
}
