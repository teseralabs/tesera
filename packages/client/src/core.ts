// Everything @tesera/client takes from tesera core, in one place. These are the same modules the
// native sender, receiver, and relay run, compiled into the bundle from ../../src, so the client
// has no second copy of the protocol, the coding, the session crypto, or the attach framing.
export { TeseraReceiver } from "../../../src/transport/receiver.js"
export { TeseraSender } from "../../../src/transport/sender.js"
export type { OpenTransport, PacketTransport, TransportEvents } from "../../../src/carrier/transport.js"
export type { Probe } from "../../../src/transport/probe.js"
export {
  ATTACH_PATH,
  ATTACH_VERSION,
  CLAIM,
  CLAIM_FULL,
  CLAIM_OK,
  CLAIM_TAKEN,
  decodeAddress,
  decodeControl,
  decodeFrame,
  encodeControl,
  encodeFrame,
  FRAME_HEADER_LEN,
  HELLO,
} from "../../../src/attach/framing.js"
export { assertCode, MAX_N, SESSION_ID_LEN } from "../../../src/constants.js"
export { randomBytes } from "../../../src/crypto/primitives.js"
