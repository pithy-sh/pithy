// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * **The client certificate a request arrived with, read off `request.cf.tlsClientAuth` (#560).**
 *
 * mTLS is the option that is sender-constrained at the edge: the zone refuses a caller without a
 * certificate **before the Worker runs**, through a WAF custom rule scoped to the hostname that blocks on
 * `not cf.tls_client_auth.cert_verified or cf.tls_client_auth.cert_revoked`. Both halves, because a revoked
 * certificate whose chain verifies still reports `cert_verified`. That rule is the gate. **This helper is not.** It is a defense-in-depth check
 * inside the Worker, for the one question the zone rule cannot answer — which of the certificates your CA
 * issued is this — and on its own it blocks nothing: a Worker with no zone rule in front of it still
 * receives every request, certificate or not, and a resolver that forgot to call this would trust them all.
 *
 * Cloudflare-managed client certificates are available on every plan. They need a proxied zone and a
 * hostname that matches exactly — no wildcards, so not `workers.dev`. `docs/server-authoritative.md` has
 * the rule and the setup.
 *
 * **Anything other than `certVerified === "SUCCESS"` is untrusted**, and so is a revoked certificate whose
 * chain did verify. "No certificate" and "a certificate that did not verify" are different states, because
 * the first is an ordinary device and the second is somebody presenting a certificate your CA did not issue,
 * and an adopter's log should be able to tell them apart.
 */

/** The fields of `request.cf.tlsClientAuth` this reads. Cloudflare sends more; nothing here needs them. */
export const TlsClientAuth = z
  .object({
    certPresented: z.string().describe('"1" when the client presented a certificate, "0" when it did not.'),
    certVerified: z
      .string()
      .describe(
        '"SUCCESS" when the certificate verified against the zone\'s CA; "NONE" or "FAILED:<reason>" otherwise.',
      ),
    certRevoked: z.string().describe('"1" when the certificate has been revoked, "0" when it has not.'),
    certIssuerDN: z.string().describe("The issuer's distinguished name."),
    certSubjectDN: z.string().describe("The subject's distinguished name."),
    certSerial: z.string().describe("The certificate's serial number."),
    certFingerprintSHA1: z.string().describe("The certificate's SHA-1 fingerprint, hex."),
    certFingerprintSHA256: z.string().describe("The certificate's SHA-256 fingerprint, hex."),
    certNotBefore: z.string().describe("When the certificate becomes valid."),
    certNotAfter: z.string().describe("When the certificate stops being valid."),
  })
  .describe("The client-certificate fields Cloudflare puts on `request.cf.tlsClientAuth`.");
export type TlsClientAuth = z.infer<typeof TlsClientAuth>;

/** A certificate that verified against the zone's CA and has not been revoked, and who it names. */
export interface VerifiedCertificate {
  state: "verified";
  issuerDN: string;
  subjectDN: string;
  serial: string;
  fingerprintSHA1: string;
  fingerprintSHA256: string;
  notBefore: string;
  notAfter: string;
}

/** What a request's client certificate turned out to be. Only `verified` is ever trusted. */
export type ClientCertificate =
  | VerifiedCertificate
  | { state: "absent" }
  | { state: "unverified"; verification: string }
  | { state: "revoked" };

/** Read the client certificate off a request. Never throws: anything it cannot read is not `verified`. */
export function readClientCertificate(request: Request): ClientCertificate {
  const cf = (request as { cf?: unknown }).cf;
  const raw = typeof cf === "object" && cf !== null ? (cf as { tlsClientAuth?: unknown }).tlsClientAuth : undefined;
  if (typeof raw !== "object" || raw === null) return { state: "absent" };
  const parsed = TlsClientAuth.safeParse(raw);
  if (!parsed.success) {
    // Present but unreadable. Not `absent` unless it says so, because a malformed record with a
    // certificate in it is not an ordinary device — and never `verified`, whatever it says.
    const presented = (raw as { certPresented?: unknown }).certPresented;
    if (presented === "0") return { state: "absent" };
    const verification = (raw as { certVerified?: unknown }).certVerified;
    return { state: "unverified", verification: typeof verification === "string" ? verification : "unreadable" };
  }
  const auth = parsed.data;
  if (auth.certPresented !== "1") return { state: "absent" };
  if (auth.certVerified !== "SUCCESS") return { state: "unverified", verification: auth.certVerified };
  if (auth.certRevoked !== "0") return { state: "revoked" };
  return {
    state: "verified",
    issuerDN: auth.certIssuerDN,
    subjectDN: auth.certSubjectDN,
    serial: auth.certSerial,
    fingerprintSHA1: auth.certFingerprintSHA1,
    fingerprintSHA256: auth.certFingerprintSHA256,
    notBefore: auth.certNotBefore,
    notAfter: auth.certNotAfter,
  };
}

/** Which certificates a resolver trusts. A fingerprint pin is required; the issuer is an extra check. */
export interface CertificatePins {
  /**
   * The issuer the certificate must also name, exactly — your CA's distinguished name. **Never enough on
   * its own**: on the Cloudflare-managed CA every certificate the zone verifies names the same issuer.
   */
  issuerDN?: string;
  /**
   * The SHA-256 fingerprints of the certificates you issued to your backend. Case and colons are ignored.
   * Required, and an empty list trusts nothing.
   */
  fingerprintsSHA256: readonly string[];
}

/** A fingerprint in one spelling: uppercase hex, no separators. */
function normalizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

/**
 * Whether a certificate is one this Worker trusts: verified, not revoked, one of the pinned fingerprints,
 * and from the pinned issuer when one is given.
 *
 * **No fingerprint is no trust.** Every certificate the zone's CA issued verifies, so with nothing pinned
 * this would trust a certificate minted for any other purpose under the same account. An issuer pin does
 * not close that: on a shared CA, every certificate behind the zone rule already names that issuer. Pin
 * the fingerprints of the certificates your backend holds, and add the issuer if you like.
 */
export function isTrustedCertificate(certificate: ClientCertificate, pins: CertificatePins): boolean {
  if (certificate.state !== "verified") return false;
  // Read defensively: a pin object built at runtime can arrive without the field the type requires.
  const fingerprints = Array.isArray(pins.fingerprintsSHA256) ? pins.fingerprintsSHA256 : [];
  if (fingerprints.length === 0) return false;
  if (pins.issuerDN !== undefined && certificate.issuerDN !== pins.issuerDN) return false;
  const presented = normalizeFingerprint(certificate.fingerprintSHA256);
  return presented !== "" && fingerprints.some((pin) => normalizeFingerprint(pin) === presented);
}
