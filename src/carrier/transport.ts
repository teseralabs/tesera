export type Endpoint = { host: string; port: number }

export interface PacketTransport {
  /** The address this transport is bound to. */
  readonly endpoint: Endpoint
  /** The largest packet `send` can carry, so a sender can choose a shard size that fits. */
  readonly maxPacketSize: number
  /** Resolves once the packet is handed off, not when it arrives. Rejects when it can't be sent. */
  send(packet: Uint8Array, to: Endpoint): Promise<void>
  close(): Promise<void>
}

export type TransportEvents = {
  packet: (packet: Uint8Array, from: Endpoint) => void
  error: (err: Error) => void
}

export type OpenTransport = (events: TransportEvents) => Promise<PacketTransport>

/**
 * The caller's transport, or a UDP socket on `bindHost:bindPort`, which
 * defaults to 127.0.0.1 and a free port. UDP is loaded only when it's used,
 * so a caller with its own transport never loads Node's sockets.
 */
export function transportOrUdp(opts: { transport?: OpenTransport; bindHost?: string; bindPort?: number }): OpenTransport {
  if (opts.transport && (opts.bindHost !== undefined || opts.bindPort !== undefined)) {
    throw new Error("use either transport or bindHost and bindPort")
  }
  if (opts.transport) return opts.transport
  const host = opts.bindHost ?? "127.0.0.1"
  const port = opts.bindPort ?? 0
  return async (events) => {
    const { udpTransport } = await import("./udp.js")
    return udpTransport(host, port)(events)
  }
}
