// A relay's signed statement of how a client attaches to it: the transport, its version, and the
// certificate hashes a client may pin. It is not part of the signed relay record, which is unchanged.
// The relay signs it with its identity key, so a control plane that knows the relay id can check that
// the certificate hashes came from that relay. The public host of the listener is not in it: the
// control plane's operator configures that.

import { ID_PREFIX, parseId, signIdentity, verifyIdentity, type Identity } from "../identity/id.js"

export const STATEMENT_VERSION = 1
/** Signatures cover this prefix, so a statement can't be confused with any other message a relay signs. */
export const STATEMENT_DOMAIN = Buffer.from("tesera-transport-statement-v1\0")
/** How long a statement is good for after the relay signs it. A control plane drops it after that. */
export const STATEMENT_TTL_SEC = 10 * 60
const MAX_STATEMENT_BYTES = 2048
const MAX_CERTIFICATES = 4

/** One certificate a client may pin, by the sha256 of its DER, with its expiry in seconds since the epoch. */
export type PinnedCertificate = { sha256: string; notAfter: number }

export type TransportStatement = {
  v: number
  relay: string
  type: "webtransport"
  /** The attach version, which is also the version in the attach path. */
  attach: number
  /** Empty when the listener's certificate is from a public authority and needs no pin. */
  certificates: PinnedCertificate[]
  issuedAt: number
  expiresAt: number
}

/** What a relay serves and a control plane fetches: the statement as signed bytes. */
export type SignedStatement = { statement: string; signature: string }

export function signStatement(
  identity: Identity,
  fields: { attach: number; certificates: PinnedCertificate[] },
  nowSec = Math.floor(Date.now() / 1000),
): SignedStatement {
  const statement: TransportStatement = {
    v: STATEMENT_VERSION,
    relay: identity.id,
    type: "webtransport",
    attach: fields.attach,
    certificates: fields.certificates.slice(0, MAX_CERTIFICATES),
    issuedAt: nowSec,
    expiresAt: nowSec + STATEMENT_TTL_SEC,
  }
  const body = Buffer.from(JSON.stringify(statement))
  return {
    statement: body.toString("base64url"),
    signature: signIdentity(identity, Buffer.concat([STATEMENT_DOMAIN, body])).toString("base64url"),
  }
}

/**
 * The statement, if `relay` signed it, it is current, and it is well formed. Certificates that have
 * expired are dropped, and a statement left with none of the pins it named is null. Anything else is
 * null too: a control plane lists nothing it can't check.
 */
export function verifyStatement(doc: unknown, relay: string, nowSec = Math.floor(Date.now() / 1000)): TransportStatement | null {
  if (!doc || typeof doc !== "object") return null
  const { statement, signature } = doc as Record<string, unknown>
  if (typeof statement !== "string" || typeof signature !== "string" || statement.length > MAX_STATEMENT_BYTES * 2) return null
  let publicKey: Buffer
  try {
    publicKey = parseId(relay)
  } catch {
    return null
  }
  const body = Buffer.from(statement, "base64url")
  if (body.length === 0 || body.length > MAX_STATEMENT_BYTES) return null
  if (!verifyIdentity(publicKey, Buffer.concat([STATEMENT_DOMAIN, body]), Buffer.from(signature, "base64url"))) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString("utf8"))
  } catch {
    return null
  }
  const s = parsed as Partial<TransportStatement>
  if (s.v !== STATEMENT_VERSION || s.relay !== relay || !relay.startsWith(ID_PREFIX) || s.type !== "webtransport") return null
  if (!isInt(s.attach) || !isInt(s.issuedAt) || !isInt(s.expiresAt) || !Array.isArray(s.certificates)) return null
  if (s.expiresAt <= nowSec || s.issuedAt > nowSec + 5 * 60) return null
  const certificates: PinnedCertificate[] = []
  for (const cert of s.certificates.slice(0, MAX_CERTIFICATES)) {
    if (!cert || typeof cert.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(cert.sha256) || !isInt(cert.notAfter)) return null
    if (cert.notAfter > nowSec) certificates.push({ sha256: cert.sha256, notAfter: cert.notAfter })
  }
  // Every pin expired: that is not the same as a listener that needs none.
  if (s.certificates.length > 0 && certificates.length === 0) return null
  return { v: s.v, relay, type: "webtransport", attach: s.attach, certificates, issuedAt: s.issuedAt, expiresAt: s.expiresAt }
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
