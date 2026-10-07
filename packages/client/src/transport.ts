/** An IPv4 or IPv6 host and a UDP port. */
export type Endpoint = { host: string; port: number }

export interface TransportEvents {
  /** A tesera datagram arrived, from the relay address `from`. */
  packet(packet: Uint8Array, from: Endpoint): void
  /** The connection failed or closed underneath the client. */
  error(err: Error): void
}

/**
 * How a TeseraClient reaches tesera relays. The client opens one connection for each transfer, and
 * everything above it, the session crypto, coding, retransmission, streaming, and progress, is the
 * same whichever transport carries the packets.
 *
 * WebTransport is the transport @tesera/client ships. An application may supply its own, as long as
 * it carries whole tesera datagrams, one per `send`, to and from the relays named in a transfer.
 */
export interface ClientTransport {
  /** A short name for errors and diagnostics, such as `webtransport`. */
  readonly name: string
  connect(events: TransportEvents, signal?: AbortSignal, hints?: ConnectHints): Promise<TransportConnection>
}

export type ConnectHints = {
  /**
   * Addresses the new connection should not have, such as the sender's entry when a receiver wants
   * its own for availability. A transport with a choice of entry points picks another, and fails with
   * a `path` error when there is none. Correctness never needs it: one relay holds both ends of a transfer.
   */
  avoid?: Endpoint[]
}

export interface TransportConnection {
  /** The address a peer sends to, through the relays, to reach this connection. */
  readonly endpoint: Endpoint
  /** The largest tesera datagram `send` carries. The client fits its shards to this and the peer's. */
  readonly maxPacketSize: number
  /** Resolves once the datagram is handed off, not when it arrives. Datagrams may be lost. */
  send(packet: Uint8Array, to: Endpoint): Promise<void>
  /**
   * Ask for one session's datagrams to be delivered to this connection, before any arrive.
   * A connection that shares its address with others, such as a relay attachment, reserves the
   * session there. A connection that owns its address has nothing to do and resolves.
   */
  claimSession(sessionId: Uint8Array): Promise<void>
  close(): Promise<void>
}
