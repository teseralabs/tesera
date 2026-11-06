import { SESSION_ID_LEN } from "../constants.js"
import { constantTimeEqual, hkdfSha256, hmacSha256 } from "./primitives.js"

// A rendezvous answer that only someone with the session secret can make.
//
// The offer carries `answerCheck`, a one-way value from the secret. The receiver's answer carries
// `proof`, which the control plane checks against it, so a party that only knows the room cannot
// take the answer slot. The proof says nothing about the answer's fields, and the control plane
// sees it, so the answer also carries `mac` over its fields under a key the control plane never
// sees. The sender checks the mac, so the control plane cannot forge an answer either.

const PROOF_INFO = Buffer.from("tesera-answer-proof-v1")
const MAC_INFO = Buffer.from("tesera-answer-mac-v1")
const CHECK_LABEL = Buffer.from("tesera-answer-check-v1")

/** The answer fields the mac covers. */
export type AnswerFields = {
  v: number
  sessionId: string
  receiver: { host: string; port: number }
  maxPacketSize: number
  ahead?: number
}

export const ANSWER_HEX = /^[0-9a-f]{64}$/

export function answerProof(secret: Uint8Array, sessionId: Uint8Array): Buffer {
  return hkdfSha256(secret, sessionIdBytes(sessionId), PROOF_INFO, 32)
}

/** What the offer publishes. Knowing it does not give the proof. */
export function answerCheck(proof: Uint8Array): Buffer {
  return hmacSha256(proof, CHECK_LABEL)
}

/** Whether a proof, as hex, matches an offer's check, as hex. False for anything malformed. */
export function proofMatches(checkHex: string, proofHex: unknown): boolean {
  if (!ANSWER_HEX.test(checkHex) || typeof proofHex !== "string" || !ANSWER_HEX.test(proofHex)) return false
  return constantTimeEqual(answerCheck(Buffer.from(proofHex, "hex")), Buffer.from(checkHex, "hex"))
}

export function answerMac(secret: Uint8Array, sessionId: Uint8Array, fields: AnswerFields): Buffer {
  const key = hkdfSha256(secret, sessionIdBytes(sessionId), MAC_INFO, 32)
  return hmacSha256(key, canonical(fields))
}

/** Whether a mac, as hex, covers these fields under this secret. False for anything malformed. */
export function answerMacMatches(secret: Uint8Array, sessionId: Uint8Array, fields: AnswerFields, macHex: unknown): boolean {
  if (typeof macHex !== "string" || !ANSWER_HEX.test(macHex)) return false
  return constantTimeEqual(answerMac(secret, sessionId, fields), Buffer.from(macHex, "hex"))
}

/** A fixed order, so both ends hash the same bytes whatever order the JSON had. */
function canonical(fields: AnswerFields): Buffer {
  return Buffer.from(
    JSON.stringify([fields.v, fields.sessionId, fields.receiver.host, fields.receiver.port, fields.maxPacketSize, fields.ahead ?? 0]),
    "utf8",
  )
}

function sessionIdBytes(sessionId: Uint8Array): Uint8Array {
  if (sessionId.length !== SESSION_ID_LEN) throw new Error("session id must be 16 bytes")
  return sessionId
}
