import { createSocket, type Socket } from "node:dgram"
import { MAX_FORWARD_DATAGRAM } from "../constants.js"
import type { Endpoint, OpenTransport } from "./transport.js"

export type { Endpoint }

export function normalizeHost(host: string): string {
  if (host === "localhost") return "127.0.0.1"
  const parts = host.split(".")
  if (parts.length !== 4) throw new Error(`tesera is IPv4 only, got ${host}`)
  const octets = parts.map((part) => Number(part))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`invalid IPv4 address ${host}`)
  }
  return octets.join(".")
}

export function isLoopback(host: string): boolean {
  return host.startsWith("127.")
}

export function normalizeEndpoint(host: string, port: number): Endpoint {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid UDP port ${port}`)
  }
  return { host: normalizeHost(host), port }
}

export function parseEndpoint(value: string): Endpoint {
  const index = value.lastIndexOf(":")
  if (index <= 0) throw new Error(`expected host:port, got ${value}`)
  const port = Number(value.slice(index + 1))
  if (!Number.isInteger(port)) throw new Error(`expected host:port, got ${value}`)
  return normalizeEndpoint(value.slice(0, index), port)
}

export function parseListen(value: string): { host: string; port: number } {
  const index = value.lastIndexOf(":")
  if (index <= 0) throw new Error(`expected host:port, got ${value}`)
  const port = Number(value.slice(index + 1))
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid listen port in ${value}`)
  }
  return { host: normalizeHost(value.slice(0, index)), port }
}

export function createUdpSocket(): Socket {
  return createSocket({ type: "udp4" })
}

export async function bindUdp(socket: Socket, host: string, port: number): Promise<Endpoint> {
  const normalized = normalizeHost(host)
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        socket.off("listening", onListening)
        reject(err)
      }
      const onListening = () => {
        socket.off("error", onError)
        resolve()
      }
      socket.once("error", onError)
      socket.once("listening", onListening)
      socket.bind(port, normalized)
    })
  } catch (err) {
    socket.close()
    throw err
  }
  try {
    socket.setRecvBufferSize(4 * 1024 * 1024)
    socket.setSendBufferSize(4 * 1024 * 1024)
  } catch {
    // The OS cap is fine; the send window is small.
  }
  const address = socket.address()
  return { host: address.address, port: address.port }
}

export function sendUdp(socket: Socket, packet: Uint8Array, dest: Endpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(packet, dest.port, dest.host, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

export function closeUdp(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.close(() => resolve())
  })
}

/** A UDP socket bound to `host:port`. Port 0 picks a free port. */
export function udpTransport(host: string, port: number): OpenTransport {
  return async (events) => {
    const socket = createUdpSocket()
    const endpoint = await bindUdp(socket, host, port)
    socket.on("message", (msg, rinfo) => events.packet(msg, { host: rinfo.address, port: rinfo.port }))
    socket.on("error", (err) => events.error(err))
    return {
      endpoint,
      // The relay's own datagram ceiling, so a UDP sender keeps the shard size it has always used.
      maxPacketSize: MAX_FORWARD_DATAGRAM,
      send: (packet, to) => sendUdp(socket, packet, to),
      close: () => closeUdp(socket),
    }
  }
}
