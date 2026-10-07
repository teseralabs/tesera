/**
 * What went wrong, at the level an application can act on:
 *
 * - `unsupported`: this runtime lacks what the transport needs, such as WebTransport
 * - `connection`: the transport could not connect to its relay, or lost the connection
 * - `incompatible`: the relay speaks another attach or protocol version
 * - `claim`: the relay would not deliver this session here, because another connection holds it or its table is full
 * - `path`: a relay in the transfer cannot be reached through this transport
 * - `transfer`: the transfer failed in flight, such as the peer going silent or a block failing its integrity check
 * - `cancelled`: the application cancelled
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
