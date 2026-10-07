import { transportOf, type IncomingTransfer, type OutgoingTransfer, type ReceiveOptions, type SendOptions, type TeseraClient, type TransferResult } from "./client.js"
import type { ControlPlane, Room } from "./control.js"
import { asTeseraError, TeseraError } from "./errors.js"
import { parseAnswer, parseOffer, parseSecret } from "./offer.js"
import { codedPaths, freshDirectoryVia, parseDirectory } from "./network.js"
import type { Source } from "./source.js"
import type { Endpoint } from "./transport.js"

const DEFAULT_PATHS = 3
/** One long-poll. The control plane caps it too. */
const POLL_SEC = 25
const RETRY_MS = [1_000, 2_000, 5_000]

export type ShareOptions = Omit<SendOptions, "relays"> & {
  /** The UDP relays that carry the transfer. Defaults to `paths` relays from discovery, chosen as `codedPaths` describes. */
  relays?: Endpoint[]
  /** How many relays to use when `relays` is not given. Defaults to 3. */
  paths?: number
}

/** A transfer waiting in a rendezvous room for its receiver. */
export type SharedTransfer = {
  /** The room, which the receiver needs. It went to the control plane. */
  room: string
  /**
   * The session secret as hex, which the receiver needs too. It did not go to the control plane,
   * and must not: send it to the receiver another way, such as a URL fragment, which a browser
   * keeps out of every request.
   */
  secret: string
  /** Unix seconds after which the room is gone and a receiver can't join. */
  expiresAt: number
  transfer: OutgoingTransfer
  /** Settles once the receiver has answered and the transfer completes, fails, or is cancelled. */
  done: Promise<TransferResult>
  /** Stop waiting or sending, and close the room. `done` rejects with a `cancelled` error. */
  cancel(): void
}

/**
 * Send through a rendezvous: connect, leave the offer in a new room, and start sending as soon as
 * the receiver's answer arrives. The control plane sees the offer and the answer, never the secret
 * or the data, and once the transfer starts it is no longer needed.
 */
export async function shareTransfer(client: TeseraClient, control: ControlPlane, source: Source, opts: ShareOptions = {}): Promise<SharedTransfer> {
  const relays = opts.relays ?? (await listedRelays(client, control, opts.paths ?? DEFAULT_PATHS, opts.signal))
  const transfer = await client.send(source, { ...opts, relays })
  let room: Room
  try {
    room = await control.openRoom(transfer.offer, opts.signal)
  } catch (err) {
    transfer.cancel()
    throw asTeseraError(err, "control")
  }
  const stop = new AbortController()
  const closeRoom = () => void control.closeRoom(room).catch(() => {})
  const done = (async () => {
    let answer: unknown
    try {
      answer = await Promise.race([waitForAnswer(control, room, stop.signal), transfer.done.then(() => null)])
    } catch (err) {
      transfer.cancel()
      closeRoom()
      if (stop.signal.aborted) return transfer.done
      throw asTeseraError(err, "control")
    }
    // The answer is all the transfer needs from the control plane; closing the room is a courtesy.
    closeRoom()
    let parsed
    try {
      parsed = parseAnswer(answer)
    } catch (err) {
      transfer.cancel()
      throw err
    }
    return transfer.start(parsed)
  })()
  done.catch(() => {})
  const cancel = () => {
    stop.abort()
    transfer.cancel()
  }
  opts.signal?.addEventListener("abort", cancel, { once: true })
  return { room: room.room, secret: transfer.secret, expiresAt: room.expiresAt, transfer, done, cancel }
}

export type JoinOptions = Omit<ReceiveOptions, "offer"> & {
  /** The room the sender shared. */
  room: string
}

/**
 * Receive through a rendezvous: read the offer from the room, connect and claim the session, and
 * leave the answer. The secret is checked here and goes nowhere but this client.
 */
export async function joinTransfer(client: TeseraClient, control: ControlPlane, opts: JoinOptions): Promise<IncomingTransfer> {
  const { room, ...receive } = opts
  parseSecret(receive.secret)
  if (typeof room !== "string" || room.length === 0) throw new TeseraError("invalid", "join needs a room")
  let offer
  try {
    offer = parseOffer(await control.readOffer(room, opts.signal))
  } catch (err) {
    throw asTeseraError(err, "control")
  }
  const incoming = await client.receive({ ...receive, offer })
  try {
    await control.postAnswer(room, incoming.answer, opts.signal)
  } catch (err) {
    incoming.cancel()
    throw asTeseraError(err, "control")
  }
  return incoming
}

/** The client's discovery transport keeps this read, so connecting right after needs no second fetch. */
async function listedRelays(client: TeseraClient, control: ControlPlane, paths: number, signal?: AbortSignal): Promise<Endpoint[]> {
  if (!Number.isInteger(paths) || paths < 1) throw new TeseraError("invalid", "paths must be a whole number of at least 1")
  const viaTransport = freshDirectoryVia(transportOf(client), control)
  const directory = viaTransport ? await viaTransport(signal) : parseDirectory(await control.discover(signal))
  const relays = codedPaths(directory, paths)
  if (relays.length === 0) throw new TeseraError("control", "discovery lists no UDP relays", { reason: "no_relays" })
  return relays
}

/** Long-poll for the answer until the room expires. A control plane that drops out briefly is retried. */
async function waitForAnswer(control: ControlPlane, room: Room, signal: AbortSignal): Promise<unknown> {
  let failures = 0
  while (!signal.aborted) {
    const left = room.expiresAt - Date.now() / 1000
    if (left <= 0) throw new TeseraError("control", "the room expired before a receiver answered", { reason: "expired" })
    try {
      const answer = await control.pollAnswer(room, Math.min(POLL_SEC, Math.ceil(left)), signal)
      failures = 0
      if (answer !== null) return answer
    } catch (err) {
      const failure = asTeseraError(err, "control")
      if (signal.aborted) break
      if (failure.reason !== "unreachable") throw failure
      await pause(RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)] ?? 5_000, signal)
    }
  }
  throw new TeseraError("cancelled", "the transfer was cancelled")
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}
