// The client's src/carrier/udp.ts. The client always passes its own transport to the sender and
// receiver, so tesera's UDP default is never opened, and this keeps node:dgram out of the bundle.
import type { OpenTransport } from "../../../../src/carrier/transport.js"
import type * as Native from "../../../../src/carrier/udp.js"

export function udpTransport(host: string, port: number): OpenTransport {
  throw new Error(`@tesera/client has no UDP transport (asked for ${host}:${port}), pass a client transport`)
}

type Matches<T extends Pick<typeof Native, "udpTransport">> = T
export type UdpMatchesNative = Matches<typeof import("./udp.js")>
