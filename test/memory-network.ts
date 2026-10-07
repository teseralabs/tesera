import type { Endpoint } from "../src/carrier/transport.js"
import type { OpenTransport, PacketTransport, TransportEvents } from "../src/carrier/transport.js"
import { decodeEnvelope, startsEnvelope } from "../src/protocol/envelope.js"

/**
 * Packets between transports in one process, for tests. Each packet arrives
 * once, in send order, on a later turn of the event loop, from the sender's
 * bound address. Packets to an address nobody holds are dropped.
 */
export class MemoryNetwork {
  readonly sent: Array<{ from: Endpoint; to: Endpoint; packet: Buffer }> = []
  private readonly nodes = new Map<string, TransportEvents>()
  private readonly aliases = new Map<string, string>()
  private nextPort = 40000

  transport(host = "127.0.0.1", port = 0, maxPacketSize = 65535): OpenTransport {
    return async (events) => {
      const endpoint = { host, port: port || this.freePort(host) }
      const key = keyOf(endpoint)
      if (this.nodes.has(key)) throw Object.assign(new Error(`${key} is in use`), { code: "EADDRINUSE" })
      this.nodes.set(key, events)
      let closed = false
      const transport: PacketTransport = {
        endpoint,
        maxPacketSize,
        send: async (packet, to) => {
          if (closed) throw new Error("transport is closed")
          if (packet.length > maxPacketSize) throw new Error(`packet of ${packet.length} exceeds ${maxPacketSize}`)
          const copy = Buffer.from(packet)
          this.sent.push({ from: endpoint, to, packet: copy })
          setImmediate(() => this.deliver(copy, endpoint, to))
        },
        close: async () => {
          closed = true
          if (this.nodes.get(key) === events) this.nodes.delete(key)
        },
      }
      return transport
    }
  }

  /** Packets sent to `from` reach whoever is bound at `to`, as a second address for the same machine. */
  alias(from: Endpoint, to: Endpoint): void {
    this.aliases.set(keyOf(from), keyOf(to))
  }

  private deliver(packet: Buffer, from: Endpoint, to: Endpoint): void {
    const key = keyOf(to)
    this.nodes.get(this.aliases.get(key) ?? key)?.packet(packet, { ...from })
  }

  private freePort(host: string): number {
    while (this.nodes.has(keyOf({ host, port: this.nextPort }))) this.nextPort++
    return this.nextPort++
  }
}

/** A forwarder that keeps only the relay's forwarding rule: open one envelope and send its inner bytes on. */
export async function memoryRelay(network: MemoryNetwork): Promise<{ endpoint: Endpoint; close: () => Promise<void> }> {
  let transport: PacketTransport | null = null
  transport = await network.transport()({
    packet: (packet) => {
      const env = decodeEnvelope(packet)
      if (!env || startsEnvelope(env.inner)) return
      void transport?.send(env.inner, env.dest).catch(() => {})
    },
    error: () => {},
  })
  return { endpoint: transport.endpoint, close: () => transport.close() }
}

function keyOf(endpoint: Endpoint): string {
  return `${endpoint.host}:${endpoint.port}`
}
