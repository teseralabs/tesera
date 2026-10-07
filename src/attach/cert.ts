import { spawnSync } from "node:child_process"
import { createHash, X509Certificate } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Browsers accept a pinned certificate only when it is valid for at most this long. */
export const MAX_PINNED_VALIDITY_MS = 14 * 24 * 60 * 60 * 1000

/**
 * A certificate and key for the HTTP/3 listener, with the sha256 of the DER a browser pins and its
 * validity in milliseconds since the epoch.
 */
export type WebTransportCert = { cert: string; privKey: string; hash: Buffer; notBefore: number; notAfter: number }

/** The sha256 of a PEM certificate's DER bytes, which `serverCertificateHashes` pins. */
export function certHash(certPem: string): Buffer {
  return createHash("sha256").update(new X509Certificate(certPem).raw).digest()
}

/** A certificate and key as PEM text. */
export function webTransportCert(cert: string, privKey: string): WebTransportCert {
  const x509 = new X509Certificate(cert)
  return {
    cert,
    privKey,
    hash: createHash("sha256").update(x509.raw).digest(),
    notBefore: Date.parse(x509.validFrom),
    notAfter: Date.parse(x509.validTo),
  }
}

/** Whether a browser would accept this certificate by its hash alone. A longer one needs a public authority. */
export function pinnable(cert: WebTransportCert): boolean {
  return cert.notAfter - cert.notBefore <= MAX_PINNED_VALIDITY_MS
}

/** A certificate and key from files, for a relay that has its own certificate, with its pin. */
export function loadCert(certFile: string, keyFile: string): WebTransportCert {
  return webTransportCert(readFileSync(certFile, "utf8"), readFileSync(keyFile, "utf8"))
}

/**
 * A short-lived self-signed P-256 certificate, for a relay with no domain: the browser pins it by the
 * sha256 hash, published out of band through discovery. WebTransport refuses a certificate valid for
 * more than 14 days, so this is deliberately short, and the relay rotates it. Generation uses the
 * system `openssl`, which avoids a certificate-building dependency; a relay with its own certificate
 * passes files instead and never needs openssl.
 */
export function generateSelfSigned(days = 10): WebTransportCert {
  const dir = mkdtempSync(join(tmpdir(), "tesera-webtransport-cert-"))
  try {
    const certFile = join(dir, "cert.pem")
    const keyFile = join(dir, "key.pem")
    const result = spawnSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-days", String(days), "-subj", "/CN=tesera-relay", "-keyout", keyFile, "-out", certFile,
      ],
      { stdio: "ignore" },
    )
    if (result.status !== 0) {
      throw new Error("could not generate a self-signed certificate; install openssl or pass --webtransport-cert and --webtransport-key")
    }
    return loadCert(certFile, keyFile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
