import { TeseraError } from "./errors.js"
import type { TransferAnswer, TransferOffer } from "./offer.js"

/** A rendezvous room, as the sender holds it. The token proves the sender; keep it in this process. */
export type Room = {
  /** Names the room. A receiver needs it to join, so it is shared with the receiver. */
  room: string
  token: string
  /** Unix seconds. */
  expiresAt: number
}

/**
 * A tesera control plane: discovery, and a rendezvous mailbox for one offer and one answer.
 * It never receives the session secret or any transfer data, and a transfer that has started no
 * longer needs it.
 *
 * `httpControlPlane` speaks the HTTP API that `tesera api` serves, at Tesera Labs or self-hosted.
 * An application may implement this itself, such as over its own signalling channel. Every method
 * returns what the control plane said; the client checks it before acting on it.
 */
export interface ControlPlane {
  /** The discovery document. */
  discover(signal?: AbortSignal): Promise<unknown>
  /** Leave an offer in a new room. */
  openRoom(offer: TransferOffer, signal?: AbortSignal): Promise<Room>
  /** The offer in a room, for a receiver. */
  readOffer(room: string, signal?: AbortSignal): Promise<unknown>
  /** Leave the receiver's answer. */
  postAnswer(room: string, answer: TransferAnswer, signal?: AbortSignal): Promise<void>
  /** The answer, waiting up to `waitSec` for one. Null when none came in time. */
  pollAnswer(room: Room, waitSec: number, signal?: AbortSignal): Promise<unknown | null>
  /** Close the room: the sender has its answer, or cancelled. */
  closeRoom(room: Room, signal?: AbortSignal): Promise<void>
}

export type HttpControlPlaneOptions = {
  /** A fetch implementation for runtimes without a global one. */
  fetch?: typeof fetch
}

/**
 * The control plane at `url`, such as the Tesera Labs API or a self-hosted `tesera api`.
 * There is no default: an application names the control plane it trusts with its metadata.
 */
export function httpControlPlane(url: string, opts: HttpControlPlaneOptions = {}): ControlPlane {
  let base: URL
  try {
    base = new URL(url)
  } catch (err) {
    throw new TeseraError("invalid", `not a URL: ${url}`, { cause: err })
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new TeseraError("invalid", `a control plane URL must be https or http, not ${base.protocol}`)
  }
  const root = base.href.endsWith("/") ? base.href : `${base.href}/`
  const call = async (path: string, init: RequestInit): Promise<Response> => {
    const doFetch = opts.fetch ?? globalThis.fetch
    if (typeof doFetch !== "function") throw new TeseraError("unsupported", "this runtime has no fetch")
    let response: Response
    try {
      response = await doFetch(new URL(path, root), { ...init, credentials: "omit", redirect: "error" })
    } catch (err) {
      if (init.signal?.aborted) throw new TeseraError("cancelled", "cancelled")
      throw new TeseraError("control", `the control plane at ${base.origin} could not be reached`, { cause: err, reason: "unreachable" })
    }
    if (response.ok) return response
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    const reason = typeof body?.error === "string" ? body.error : `http_${response.status}`
    throw new TeseraError("control", `the control plane refused: ${reason}`, { reason })
  }
  const json = async (response: Response): Promise<unknown> => {
    try {
      return await response.json()
    } catch (err) {
      throw new TeseraError("control", "the control plane sent a reply that is not JSON", { cause: err, reason: "malformed" })
    }
  }
  const roomPath = (room: string) => `v1/rooms/${encodeURIComponent(room)}`
  const auth = (room: Room) => ({ authorization: `Bearer ${room.token}` })
  return {
    async discover(signal) {
      return json(await call("v1/relays", { signal }))
    },
    async openRoom(offer, signal) {
      const body = await json(await call("v1/rooms", { method: "POST", body: JSON.stringify(offer), signal }))
      const { room, token, expiresAt } = (body ?? {}) as Record<string, unknown>
      if (typeof room !== "string" || typeof token !== "string" || typeof expiresAt !== "number") {
        throw new TeseraError("control", "the control plane sent a malformed room", { reason: "malformed" })
      }
      return { room, token, expiresAt }
    },
    async readOffer(room, signal) {
      return json(await call(roomPath(room), { signal }))
    },
    async postAnswer(room, answer, signal) {
      await call(`${roomPath(room)}/answer`, { method: "POST", body: JSON.stringify(answer), signal })
    },
    async pollAnswer(room, waitSec, signal) {
      const response = await call(`${roomPath(room.room)}/answer?wait=${Math.max(0, Math.floor(waitSec))}`, { headers: auth(room), signal })
      return response.status === 204 ? null : json(response)
    },
    async closeRoom(room, signal) {
      await call(roomPath(room.room), { method: "DELETE", headers: auth(room), signal })
    },
  }
}
