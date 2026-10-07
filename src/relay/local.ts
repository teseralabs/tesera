import type { Endpoint } from "../carrier/transport.js"

/**
 * A relay can hand some packets to local endpoints instead of UDP peers, such as a
 * browser that reaches the relay over another transport. The relay stays generic: it
 * never learns what the endpoint is, only that a packet belongs to one. There is no
 * mention of any particular transport here.
 */
export interface LocalDelivery {
  /**
   * A packet arrived over UDP that is neither an envelope nor an identity packet.
   * Deliver it to a local endpoint when it belongs to one, and return true when handled.
   */
  deliverReturn(packet: Buffer, from: Endpoint): boolean
}

/** Why a local endpoint's outbound packet was accepted or refused. */
export type ForwardResult = "ok" | "denied" | "too-large" | "limited" | "closed" | "invalid"
