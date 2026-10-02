import { randomBytes } from "node:crypto"
import { type Socket } from "node:dgram"
import { bindUdp, closeUdp, createUdpSocket, normalizeHost, sendUdp, type Endpoint } from "../carrier/udp.js"
import { asError } from "../util.js"
import { decodeProof, encodeQuery, formatId, parseId, verifyProof } from "./id.js"

type ConfirmOptions = {
  timeoutMs?: number
  attempts?: number
}

/**
 * Ask the relay at `endpoint` to prove it holds the private key for `id`.
 * The reply has to come back from that same address. This is a startup check,
 * not a signature on later tesserae.
 */
export async function confirmRelay(endpoint: Endpoint, id: string, opts: ConfirmOptions = {}): Promise<void> {
  const expected = parseId(id)
  const attempts = opts.attempts ?? 3
  const timeoutMs = opts.timeoutMs ?? 300
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("confirm attempts must be >= 1")
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("confirm timeout must be >= 0")
  const socket = createUdpSocket()
  let opened = false
  try {
    await bindUdp(socket, "0.0.0.0", 0)
    opened = true
    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await oneAttempt(socket, endpoint, expected, timeoutMs)
      if (result === "ok") return
    }
    throw new Error(`relay ${endpoint.host}:${endpoint.port} did not prove ${formatId(expected)}`)
  } finally {
    if (opened) await closeUdp(socket)
  }
}

function oneAttempt(socket: Socket, endpoint: Endpoint, expected: Buffer, timeoutMs: number): Promise<"ok" | "timeout"> {
  const challenge = randomBytes(16)
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout
    const finish = (done: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off("message", onMessage)
      done()
    }
    const onMessage = (msg: Buffer, rinfo: { address: string; port: number }) => {
      if (rinfo.port !== endpoint.port) return
      let host: string
      try {
        host = normalizeHost(rinfo.address)
      } catch {
        return
      }
      if (host !== endpoint.host) return
      const proof = decodeProof(msg)
      if (!proof || !proof.challenge.equals(challenge) || !verifyProof(proof)) return
      if (!proof.publicKey.equals(expected)) {
        finish(() =>
          reject(
            new Error(
              `relay ${endpoint.host}:${endpoint.port} is ${formatId(proof.publicKey)}, not ${formatId(expected)}`,
            ),
          ),
        )
        return
      }
      finish(() => resolve("ok"))
    }
    timer = setTimeout(() => finish(() => resolve("timeout")), timeoutMs)
    socket.on("message", onMessage)
    sendUdp(socket, encodeQuery(challenge), endpoint).catch((err) => finish(() => reject(asError(err))))
  })
}