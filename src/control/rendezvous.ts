// A short-lived mailbox where a sender leaves an offer and a receiver leaves an answer.
// It holds the two documents and nothing else. It never sees the session secret, so it can't
// derive a key, and no file data passes through it: that goes over the relays.
// Rooms live in memory. A restart forgets every room, and an endpoint that loses its room starts again.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/** 128 random bits each, base64url without padding: 22 characters. */
export const ROOM_BYTES = 16
export const TOKEN_BYTES = 16
export const RENDEZVOUS_TTL_MS = 10 * 60 * 1000
export const MAX_ROOMS = 1_000
/** The largest offer or answer, as the JSON text received. */
export const MAX_DOCUMENT_BYTES = 4 * 1024
export const MAX_WAIT_MS = 25_000

export type RendezvousLimits = {
  ttlMs: number
  maxRooms: number
  maxDocumentBytes: number
  maxWaitMs: number
}

export const DEFAULT_RENDEZVOUS_LIMITS: RendezvousLimits = {
  ttlMs: RENDEZVOUS_TTL_MS,
  maxRooms: MAX_ROOMS,
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  maxWaitMs: MAX_WAIT_MS,
}

/** A refusal: an HTTP status and a short code for the error body. */
export class RendezvousError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

export type CreatedRoom = { room: string; token: string; expiresAt: number }

type Room = {
  tokenHash: Buffer
  sessionId: string
  offer: string
  answer: string | null
  expiresAt: number
  waiters: Set<(answer: string | null) => void>
}

const ROOM_PATTERN = /^[A-Za-z0-9_-]{22}$/

export function isRoomId(value: string): boolean {
  return ROOM_PATTERN.test(value)
}

/**
 * The rooms. Documents are kept as the exact text received, after a check that each is a JSON
 * object of version 1 or later with a 32-hex `sessionId`. Every other field is the endpoints'
 * business and passes through untouched. Unknown and expired rooms look the same: not found.
 */
export class Rendezvous {
  private readonly rooms = new Map<string, Room>()
  private readonly limits: RendezvousLimits

  constructor(
    limits: Partial<RendezvousLimits> = {},
    private readonly now: () => number = Date.now,
    private readonly random: (n: number) => Buffer = randomBytes,
  ) {
    this.limits = { ...DEFAULT_RENDEZVOUS_LIMITS, ...limits }
  }

  get size(): number {
    this.sweep()
    return this.rooms.size
  }

  /** Open a room for an offer. The token proves the sender in later calls; only its hash is kept. */
  create(text: string): CreatedRoom {
    this.sweep()
    const sessionId = this.document(text)
    if (this.rooms.size >= this.limits.maxRooms) throw new RendezvousError(503, "busy")
    let room = this.random(ROOM_BYTES).toString("base64url")
    while (this.rooms.has(room)) room = this.random(ROOM_BYTES).toString("base64url")
    const token = this.random(TOKEN_BYTES).toString("base64url")
    const expiresAt = this.now() + this.limits.ttlMs
    this.rooms.set(room, { tokenHash: hashToken(token), sessionId, offer: text, answer: null, expiresAt, waiters: new Set() })
    return { room, token, expiresAt }
  }

  /** The offer, for a receiver. Gone once a receiver has answered, so a second joiner learns it is late. */
  offer(room: string): { offer: string; expiresAt: number } {
    const found = this.find(room)
    if (found.answer !== null) throw new RendezvousError(409, "answered")
    return { offer: found.offer, expiresAt: found.expiresAt }
  }

  /**
   * Leave an answer. The first one wins. The same answer again is accepted, so a receiver that lost
   * the reply can retry; a different one is refused. An answer for another session id is refused too.
   */
  answer(room: string, text: string): void {
    const found = this.find(room)
    const sessionId = this.document(text)
    if (found.answer !== null) {
      if (found.answer === text) return
      throw new RendezvousError(409, "answered")
    }
    if (sessionId !== found.sessionId) throw new RendezvousError(409, "session")
    found.answer = text
    for (const wake of found.waiters) wake(text)
    found.waiters.clear()
  }

  /**
   * The answer, for the sender, waiting up to `waitMs` for one. Null when the wait ends first.
   * The answer stays readable until the sender closes the room, so a sender that reconnects asks again.
   */
  async waitAnswer(room: string, token: string, waitMs: number, signal?: AbortSignal): Promise<string | null> {
    const found = this.owned(room, token)
    if (found.answer !== null) return found.answer
    const wait = Math.min(Math.max(0, waitMs), this.limits.maxWaitMs, found.expiresAt - this.now())
    if (wait <= 0) return null
    // One wait per room: a sender that reconnects replaces its old request, which ends empty.
    for (const wake of [...found.waiters]) wake(null)
    return new Promise((resolve) => {
      const done = (answer: string | null) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", stop)
        found.waiters.delete(done)
        resolve(answer)
      }
      const stop = () => done(null)
      const timer = setTimeout(stop, wait)
      found.waiters.add(done)
      signal?.addEventListener("abort", stop, { once: true })
    })
  }

  /** Close a room: a sender cancelling, or a sender that has its answer. */
  close(room: string, token: string): void {
    this.owned(room, token)
    this.drop(room)
  }

  /** Forget every room and release every waiter. */
  clear(): void {
    for (const room of [...this.rooms.keys()]) this.drop(room)
  }

  /** Drop expired rooms. */
  sweep(): void {
    const now = this.now()
    for (const [room, found] of this.rooms) if (found.expiresAt <= now) this.drop(room)
  }

  private find(room: string): Room {
    if (!isRoomId(room)) throw new RendezvousError(400, "room")
    const found = this.rooms.get(room)
    if (!found) throw new RendezvousError(404, "not_found")
    if (found.expiresAt <= this.now()) {
      this.drop(room)
      throw new RendezvousError(404, "not_found")
    }
    return found
  }

  private owned(room: string, token: string): Room {
    const found = this.find(room)
    if (!timingSafeEqual(found.tokenHash, hashToken(token))) throw new RendezvousError(403, "token")
    return found
  }

  private drop(room: string): void {
    const found = this.rooms.get(room)
    if (!found) return
    this.rooms.delete(room)
    for (const wake of found.waiters) wake(null)
    found.waiters.clear()
  }

  /** The session id of a well-formed document, or a refusal. */
  private document(text: string): string {
    if (Buffer.byteLength(text, "utf8") > this.limits.maxDocumentBytes) throw new RendezvousError(413, "size")
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new RendezvousError(400, "document")
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RendezvousError(400, "document")
    const { v, sessionId } = parsed as Record<string, unknown>
    if (!Number.isInteger(v) || (v as number) < 1) throw new RendezvousError(400, "document")
    if (typeof sessionId !== "string" || !/^[0-9a-f]{32}$/.test(sessionId)) throw new RendezvousError(400, "document")
    return sessionId
  }
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest()
}
