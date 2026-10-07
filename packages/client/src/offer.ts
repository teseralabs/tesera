import { assertCode, MAX_N, SESSION_ID_LEN } from "./core.js"
import { TeseraError } from "./errors.js"
import type { Endpoint } from "./transport.js"

export const OFFER_VERSION = 1
const SECRET_LEN = 32

/**
 * What a sender publishes so a receiver can join. It holds no key material, so it may travel
 * through a channel the application does not fully trust, such as a rendezvous service.
 */
export type TransferOffer = {
  v: typeof OFFER_VERSION
  /** 16 bytes, hex. Names the transfer at the relays; not a secret. */
  sessionId: string
  /** Where the receiver's acknowledgements go: the sender's attachment address. */
  sender: Endpoint
  /** The UDP relays that carry the transfer, in the order both ends use. */
  relays: Endpoint[]
  /** Any k of the n tesserae of a block rebuild it. */
  k: number
  n: number
  /** Total bytes, when the sender knows them. */
  size?: number
}

/** What a receiver sends back so the sender can start. It holds no key material. */
export type TransferAnswer = {
  v: typeof OFFER_VERSION
  sessionId: string
  /** Where the sender's tesserae go: the receiver's attachment address. */
  receiver: Endpoint
  /** The largest datagram the receiver's connection accepts. */
  maxPacketSize: number
}

export function parseOffer(value: unknown): TransferOffer {
  const offer = record(value, "offer")
  version(offer, "offer")
  const relays = offer["relays"]
  if (!Array.isArray(relays) || relays.length < 1 || relays.length > MAX_N) {
    throw new TeseraError("invalid", `an offer needs 1 to ${MAX_N} relays`)
  }
  const k = offer["k"]
  const n = offer["n"]
  if (typeof k !== "number" || typeof n !== "number") throw new TeseraError("invalid", "an offer needs k and n")
  code(k, n)
  const size = offer["size"]
  if (size !== undefined && !(typeof size === "number" && Number.isSafeInteger(size) && size >= 0)) {
    throw new TeseraError("invalid", "an offer's size must be a whole number of bytes")
  }
  return {
    v: OFFER_VERSION,
    sessionId: sessionHex(offer["sessionId"]),
    sender: endpoint(offer["sender"], "sender"),
    relays: relays.map((relay, i) => endpoint(relay, `relay ${i}`)),
    k,
    n,
    ...(size === undefined ? {} : { size }),
  }
}

export function parseAnswer(value: unknown): TransferAnswer {
  const answer = record(value, "answer")
  version(answer, "answer")
  const max = answer["maxPacketSize"]
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
    throw new TeseraError("invalid", "an answer needs the receiver's maxPacketSize")
  }
  return {
    v: OFFER_VERSION,
    sessionId: sessionHex(answer["sessionId"]),
    receiver: endpoint(answer["receiver"], "receiver"),
    maxPacketSize: max,
  }
}

/** A new random session secret, as hex. */
export function secretHex(bytes: Uint8Array): string {
  return toHex(bytes)
}

/** @internal */
export function parseSecret(value: unknown): Buffer {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${SECRET_LEN * 2}}$`).test(value)) {
    throw new TeseraError("invalid", `a session secret is ${SECRET_LEN} bytes of lowercase hex`)
  }
  return Buffer.from(value, "hex")
}

export function code(k: number, n: number): void {
  try {
    assertCode(k, n)
  } catch (err) {
    throw new TeseraError("invalid", (err as Error).message)
  }
}

export function endpoint(value: unknown, what: string): Endpoint {
  const at = record(value, what)
  const host = at["host"]
  const port = at["port"]
  if (typeof host !== "string" || host.length === 0) throw new TeseraError("invalid", `${what} needs a host`)
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TeseraError("invalid", `${what} needs a port from 1 to 65535`)
  }
  return { host, port }
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex")
}

function sessionHex(value: unknown): string {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${SESSION_ID_LEN * 2}}$`).test(value)) {
    throw new TeseraError("invalid", `a session id is ${SESSION_ID_LEN} bytes of lowercase hex`)
  }
  return value
}

function version(value: Record<string, unknown>, what: string): void {
  if (value["v"] !== OFFER_VERSION) throw new TeseraError("incompatible", `this client reads ${what} version ${OFFER_VERSION}, got ${String(value["v"])}`)
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TeseraError("invalid", `${what} must be an object`)
  return value as Record<string, unknown>
}
