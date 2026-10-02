import { decodeEnvelope } from "../protocol/envelope.js"
import { decodeProof, decodeQuery, isIdentityPacket } from "../identity/id.js"
import { decodeAgain, decodeLookup, decodeResume, decodeTable, isJoin } from "../identity/peers.js"
import { decodeRecord, isRecordAsk } from "../identity/record.js"
import { decodeSnapshotQuery, decodeUsage } from "../identity/stats.js"

/** A datagram that parses as a tesera envelope or a tesera identity packet. */
export function isStructuralTesera(packet: Uint8Array): boolean {
  if (decodeEnvelope(packet)) return true
  if (!isIdentityPacket(packet)) return false
  return (
    isJoin(packet) ||
    decodeLookup(packet) !== null ||
    decodeQuery(packet) !== null ||
    decodeProof(packet) !== null ||
    decodeUsage(packet) !== null ||
    decodeSnapshotQuery(packet) !== null ||
    decodeTable(packet) !== null ||
    decodeAgain(packet) !== null ||
    decodeResume(packet) !== null ||
    isRecordAsk(packet) ||
    decodeRecord(packet) !== null
  )
}
