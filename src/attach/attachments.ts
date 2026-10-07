import { FRAME_ACK, FRAME_DATA, FRAME_NACK, FRAME_SAMPLE, PROTOCOL_VERSION, SESSION_ID_LEN } from "../constants.js"
import type { Endpoint } from "../carrier/transport.js"
import { decodeEnvelope } from "../protocol/envelope.js"

/** Deliver a return frame to the attached endpoint, with the UDP address it arrived from. */
export type SendToAttachment = (packet: Buffer, from: Endpoint) => void

/**
 * One end of a transfer. Every frame type is sent by exactly one end: DATA by the sending end, and
 * ACK, NACK, and SAMPLE by the receiving end. The type is the frame's second byte, in the clear on
 * every hop, so a relay can tell the ends apart without any key.
 */
export type Side = "sending" | "receiving"

/**
 * One attached endpoint. The registry owns the bookkeeping; a listener only reads `ip` for per-source
 * caps and calls `send` to pass a return frame on. The registry never decrypts anything, and it never
 * learns what the endpoint is: a session is matched by its 16-byte id, which is routing, not a secret.
 */
export interface Attachment {
  readonly ip: string
  readonly send: SendToAttachment
  closed: boolean
  lastActive: number
  /** The session ends this attachment holds, as registry keys. */
  readonly sessions: Set<string>
}

export type ClaimResult = "ok" | "taken" | "full" | "ignored"

export type AttachmentLimits = {
  /** Live attachments at once. */
  maxAttachments: number
  /** Held session ends across all attachments. Both ends of one transfer on this relay count as 2. */
  maxSessions: number
  /** Session ends one attachment may hold. One transfer needs one. */
  maxSessionsPerConnection: number
  /** Live attachments from one source address. */
  maxAttachmentsPerIp: number
  /** Session ends held by all attachments from one source address. */
  maxSessionsPerIp: number
  /** A claim or an attachment with no traffic for this long is dropped, even if the connection lingers. */
  idleMs: number
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxAttachments: 64,
  maxSessions: 1024,
  maxSessionsPerConnection: 8,
  maxAttachmentsPerIp: 16,
  maxSessionsPerIp: 64,
  idleMs: 60_000,
}

type Claim = { owner: Attachment; lastActive: number }

/**
 * The attachment registry. It routes return frames back to the attachment that holds the end of the
 * session they are addressed to, and it is where the isolation and resource rules live, so it can be
 * tested on its own.
 *
 * A key is a session id and a side. The sending and the receiving end of one transfer may attach to
 * the same relay, since their frames never share a side. First writer wins per side: an end belongs to
 * the first live attachment to claim it or send a frame from it, until that attachment closes or the
 * claim goes idle. One attachment holds at most one end of a session. Closing one attachment never
 * removes another's claim.
 */
export class Attachments {
  private readonly limits: AttachmentLimits
  private readonly live = new Set<Attachment>()
  private readonly byKey = new Map<string, Claim>()
  private readonly attachmentsByIp = new Map<string, number>()
  private readonly now: () => number

  constructor(limits: Partial<AttachmentLimits> = {}, now: () => number = Date.now) {
    this.limits = { ...DEFAULT_ATTACHMENT_LIMITS, ...limits }
    this.now = now
  }

  get size(): number {
    return this.live.size
  }

  /** Held session ends. */
  get sessions(): number {
    return this.byKey.size
  }

  get idleMs(): number {
    return this.limits.idleMs
  }

  full(): boolean {
    return this.live.size >= this.limits.maxAttachments
  }

  /** A new attachment, or null when a total or per-source cap refuses it. */
  add(ip: string, send: SendToAttachment): Attachment | null {
    if (this.live.size >= this.limits.maxAttachments) return null
    if ((this.attachmentsByIp.get(ip) ?? 0) >= this.limits.maxAttachmentsPerIp) return null
    const attachment: Attachment = { ip, send, closed: false, lastActive: this.now(), sessions: new Set() }
    this.live.add(attachment)
    this.attachmentsByIp.set(ip, (this.attachmentsByIp.get(ip) ?? 0) + 1)
    return attachment
  }

  /**
   * An outbound frame from `attachment`, which holds the end that sends it: a sender's DATA, or a
   * receiver's ACK, NACK, or SAMPLE. Only "ok" means the frame may be forwarded. Anything else is a
   * frame this attachment has no right to send, or one that is not a tesera frame at all.
   */
  learn(frame: Uint8Array, attachment: Attachment): ClaimResult {
    const side = sentBy(frame)
    if (!side) return "ignored"
    return this.associate(sessionOf(frame), side, attachment)
  }

  /** A receiver's end of a session, claimed explicitly before any data arrives. */
  claim(sessionHex: string | null, attachment: Attachment): ClaimResult {
    return this.associate(sessionHex, "receiving", attachment)
  }

  /** Mark an attachment as active, so an idle sweep does not drop it mid-transfer. */
  touch(attachment: Attachment): void {
    if (attachment.closed) return
    attachment.lastActive = this.now()
  }

  close(attachment: Attachment): void {
    if (!this.live.has(attachment)) {
      attachment.closed = true
      return
    }
    attachment.closed = true
    this.live.delete(attachment)
    const count = this.attachmentsByIp.get(attachment.ip) ?? 0
    if (count <= 1) this.attachmentsByIp.delete(attachment.ip)
    else this.attachmentsByIp.set(attachment.ip, count - 1)
    for (const key of attachment.sessions) {
      if (this.byKey.get(key)?.owner === attachment) this.byKey.delete(key)
    }
    attachment.sessions.clear()
  }

  /**
   * Route a bare return frame to the attachment holding the end it is addressed to: DATA to the
   * receiving end, ACK, NACK, and SAMPLE to the sending end. False means the relay drops it. This
   * only ever hands a frame to an attachment; it never sends anything over UDP.
   */
  deliverReturn(packet: Buffer, from: Endpoint): boolean {
    const side = sentBy(packet)
    const sessionHex = sessionOf(packet)
    if (!side || !sessionHex) return false
    const claim = this.byKey.get(keyOf(sessionHex, other(side)))
    if (!claim || claim.owner.closed) return false
    claim.lastActive = this.now()
    claim.owner.lastActive = claim.lastActive
    claim.owner.send(packet, from)
    return true
  }

  /** Drop idle claims and idle attachments. Returns the attachments it closed, so a listener can tear them down. */
  sweep(): Attachment[] {
    const now = this.now()
    for (const [key, claim] of this.byKey) {
      if (now - claim.lastActive >= this.limits.idleMs) {
        claim.owner.sessions.delete(key)
        this.byKey.delete(key)
      }
    }
    const closed: Attachment[] = []
    for (const attachment of this.live) {
      if (now - attachment.lastActive >= this.limits.idleMs) closed.push(attachment)
    }
    for (const attachment of closed) this.close(attachment)
    return closed
  }

  private associate(sessionHex: string | null, side: Side, attachment: Attachment): ClaimResult {
    if (!sessionHex || !this.live.has(attachment) || attachment.closed) return "ignored"
    const key = keyOf(sessionHex, side)
    const existing = this.byKey.get(key)
    if (existing?.owner === attachment) {
      existing.lastActive = this.now()
      return "ok"
    }
    // First writer wins: a live owner keeps its end. A closed owner's claim is reclaimed safely.
    if (existing && !existing.owner.closed) return "taken"
    // Holding both ends would hand an attachment its own frames back; nothing needs it, so refuse.
    if (attachment.sessions.has(keyOf(sessionHex, other(side)))) return "taken"
    if (attachment.sessions.size >= this.limits.maxSessionsPerConnection) return "full"
    const freed = existing ? 1 : 0
    if (this.byKey.size - freed >= this.limits.maxSessions) return "full"
    if (this.sessionsForIp(attachment.ip) - freed >= this.limits.maxSessionsPerIp) return "full"
    if (existing) existing.owner.sessions.delete(key)
    this.byKey.set(key, { owner: attachment, lastActive: this.now() })
    attachment.sessions.add(key)
    return "ok"
  }

  private sessionsForIp(ip: string): number {
    let total = 0
    for (const attachment of this.live) if (attachment.ip === ip) total += attachment.sessions.size
    return total
  }
}

function keyOf(sessionHex: string, side: Side): string {
  return `${side === "sending" ? "s" : "r"}:${sessionHex}`
}

function other(side: Side): Side {
  return side === "sending" ? "receiving" : "sending"
}

/** The end of a transfer that sends this frame, or null when it isn't a tesera frame. */
export function sentBy(frame: Uint8Array): Side | null {
  if (frame.length < 2 + SESSION_ID_LEN || frame[0] !== PROTOCOL_VERSION) return null
  const type = frame[1]
  if (type === FRAME_DATA) return "sending"
  if (type === FRAME_ACK || type === FRAME_NACK || type === FRAME_SAMPLE) return "receiving"
  return null
}

/** The inner bytes of an envelope, or the packet itself when it isn't one. */
export function innerOf(packet: Uint8Array): Uint8Array {
  const env = decodeEnvelope(Buffer.from(packet))
  return env ? env.inner : packet
}

/** The 16-byte session id of a tesera frame, hex, or null when the bytes aren't one. */
export function sessionOf(frame: Uint8Array): string | null {
  if (frame.length < 2 + SESSION_ID_LEN || frame[0] !== PROTOCOL_VERSION) return null
  return Buffer.from(frame.subarray(2, 2 + SESSION_ID_LEN)).toString("hex")
}
