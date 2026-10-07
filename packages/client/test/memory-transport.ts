// A ClientTransport over tesera's in-memory test network: what a third-party transport looks like.
// Each connection owns its own address, so claiming a session has nothing to do.
import { MemoryNetwork, memoryRelay } from "../../../test/memory-network.js"
import type { ClientTransport, Endpoint } from "../src/index.js"

export type MemoryWorld = {
  network: MemoryNetwork
  relays: Array<{ endpoint: Endpoint; close: () => Promise<void> }>
  transport: (maxPacketSize?: number) => ClientTransport & { open: () => number }
  close: () => Promise<void>
}

export async function memoryWorld(relayCount = 3): Promise<MemoryWorld> {
  const network = new MemoryNetwork()
  const relays: MemoryWorld["relays"] = []
  for (let i = 0; i < relayCount; i++) relays.push(await memoryRelay(network))
  return {
    network,
    relays,
    transport: (maxPacketSize = 65535) => {
      let open = 0
      return {
        name: "memory",
        open: () => open,
        connect: async (events) => {
          const transport = await network.transport("127.0.0.1", 0, maxPacketSize)(events)
          open++
          let closed = false
          return {
            endpoint: transport.endpoint,
            maxPacketSize: transport.maxPacketSize,
            send: (packet, to) => transport.send(packet, to),
            claimSession: async () => {},
            close: async () => {
              if (closed) return
              closed = true
              open--
              await transport.close()
            },
          }
        },
      }
    },
    close: async () => {
      for (const relay of relays) await relay.close()
    },
  }
}
