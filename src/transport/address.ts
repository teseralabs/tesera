import type { Endpoint } from "../carrier/transport.js"

/** The peer's address: one for every relay, or one per relay in the same order as the relay list. */
export type PeerAddress = Endpoint | readonly Endpoint[]

/** The peer's address for each relay, by relay index. */
export function addressPerRelay(peer: PeerAddress, relays: readonly Endpoint[]): Endpoint[] {
  if (!isList(peer)) return relays.map(() => peer)
  if (peer.length !== relays.length) {
    throw new Error(`expected one peer address per relay (${relays.length}), got ${peer.length}`)
  }
  return [...peer]
}

function isList(peer: PeerAddress): peer is readonly Endpoint[] {
  return Array.isArray(peer)
}
