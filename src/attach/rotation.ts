import type { WebTransportCert } from "./cert.js"

const DAY_MS = 24 * 60 * 60 * 1000

/** The schedule for a relay's own self-signed certificates, by the current certificate's age. */
export type RotationSchedule = {
  /** Make the next certificate this long after the current one starts, so discovery can publish both. */
  nextAfterMs: number
  /** Switch to the next certificate once the current one is this old and no attachment is open. */
  switchIdleAfterMs: number
  /** Switch regardless once the current one is this old, ahead of its expiry. */
  switchByMs: number
}

/** For a 10-day certificate: the next one at day 4, a switch when idle from day 6, and by day 9. */
export const DEFAULT_ROTATION: RotationSchedule = {
  nextAfterMs: 4 * DAY_MS,
  switchIdleAfterMs: 6 * DAY_MS,
  switchByMs: 9 * DAY_MS,
}

/**
 * Rotates a relay's self-signed WebTransport certificates with an overlap. The next certificate exists,
 * and is published beside the current one, days before the listener switches to it, so a client that
 * pinned both keeps connecting across the switch. A switch restarts the HTTP/3 listener, so it waits
 * for a moment with no attachment open, and only the hard deadline closes open ones.
 */
export class CertRotation {
  private current: WebTransportCert
  private next: WebTransportCert | null = null

  constructor(
    first: WebTransportCert,
    private readonly generate: () => WebTransportCert,
    private readonly schedule: RotationSchedule = DEFAULT_ROTATION,
    private readonly now: () => number = Date.now,
  ) {
    this.current = first
  }

  /** The certificate the listener should present. */
  get active(): WebTransportCert {
    return this.current
  }

  /** Certificates a client may pin now: the active one, and the next one once it exists. Expired ones are left out. */
  published(): WebTransportCert[] {
    const now = this.now()
    return [this.current, this.next].filter((cert): cert is WebTransportCert => cert !== null && cert.notAfter > now)
  }

  /** Advance the schedule. Returns the certificate to switch the listener to, or null. */
  tick(idle: boolean): WebTransportCert | null {
    const age = this.now() - this.current.notBefore
    if (!this.next && age >= this.schedule.nextAfterMs) this.next = this.generate()
    if (!this.next) return null
    if (age < this.schedule.switchByMs && !(idle && age >= this.schedule.switchIdleAfterMs)) return null
    this.current = this.next
    this.next = null
    return this.current
  }
}
