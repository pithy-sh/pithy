// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type CertificatePins, isTrustedCertificate, readClientCertificate } from "./certificate";

/** What Cloudflare puts on `request.cf.tlsClientAuth` for a verified certificate. */
const VERIFIED = {
  certPresented: "1",
  certVerified: "SUCCESS",
  certRevoked: "0",
  certIssuerDN: "CN=Example Game Server CA,O=Example",
  certSubjectDN: "CN=game-server,O=Example",
  certIssuerDNRFC2253: "CN=Example Game Server CA,O=Example",
  certSubjectDNRFC2253: "CN=game-server,O=Example",
  certIssuerDNLegacy: "/O=Example/CN=Example Game Server CA",
  certSubjectDNLegacy: "/O=Example/CN=game-server",
  certSerial: "5D3E1B",
  certIssuerSerial: "01",
  certSKI: "AA",
  certIssuerSKI: "BB",
  certFingerprintSHA1: "6B9109F323999E52259CDA7373FF0B7A3D8E6D3B",
  certFingerprintSHA256: "0B4D7A7C5B5C9F1E2A3B4C5D6E7F80910111213141516171819202122232425A",
  certNotBefore: "Oct 18 00:00:00 2026 GMT",
  certNotAfter: "Oct 18 00:00:00 2027 GMT",
  certRFC9440: ":MIIB…:",
  certRFC9440TooLarge: false,
  certChainRFC9440: "",
  certChainRFC9440TooLarge: false,
};

/** What it puts there when the client presented nothing. */
const PLACEHOLDER = {
  certPresented: "0",
  certVerified: "NONE",
  certRevoked: "0",
  certIssuerDN: "",
  certSubjectDN: "",
  certFingerprintSHA1: "",
  certFingerprintSHA256: "",
  certSerial: "",
  certNotBefore: "",
  certNotAfter: "",
};

/** A request as a Worker receives it, carrying `cf.tlsClientAuth` — or no `cf` at all, as off Cloudflare. */
function request(tlsClientAuth?: unknown): Request {
  const req = new Request("https://api.example.com/leaderboard/b1", { method: "POST" });
  if (tlsClientAuth !== undefined) Object.defineProperty(req, "cf", { value: { tlsClientAuth } });
  return req;
}

describe("readClientCertificate", () => {
  test("reads a verified certificate's identity", () => {
    expect(readClientCertificate(request(VERIFIED))).toEqual({
      state: "verified",
      issuerDN: VERIFIED.certIssuerDN,
      subjectDN: VERIFIED.certSubjectDN,
      serial: VERIFIED.certSerial,
      fingerprintSHA1: VERIFIED.certFingerprintSHA1,
      fingerprintSHA256: VERIFIED.certFingerprintSHA256,
      notBefore: VERIFIED.certNotBefore,
      notAfter: VERIFIED.certNotAfter,
    });
  });

  test("tells 'no certificate presented' apart from 'presented but not verified'", () => {
    expect(readClientCertificate(request(PLACEHOLDER))).toEqual({ state: "absent" });
    expect(readClientCertificate(request({ ...VERIFIED, certVerified: "FAILED:self signed certificate" }))).toEqual({
      state: "unverified",
      verification: "FAILED:self signed certificate",
    });
  });

  test("treats a revoked certificate as untrusted, even when Cloudflare verified its chain", () => {
    expect(readClientCertificate(request({ ...VERIFIED, certRevoked: "1" }))).toEqual({ state: "revoked" });
  });

  test("treats anything other than certVerified SUCCESS as unverified", () => {
    for (const verification of ["NONE", "FAILED:certificate has expired", "success", "", "SUCCESS "]) {
      expect(readClientCertificate(request({ ...VERIFIED, certVerified: verification })).state, verification).toBe(
        "unverified",
      );
    }
  });

  test("answers absent off Cloudflare, where a request carries no cf object at all", () => {
    expect(readClientCertificate(request())).toEqual({ state: "absent" });
    expect(readClientCertificate(request(null))).toEqual({ state: "absent" });
  });

  test("answers unverified for a cf object it cannot read, rather than guessing", () => {
    expect(readClientCertificate(request({ certPresented: "1", certVerified: "SUCCESS" })).state).toBe("unverified");
    expect(readClientCertificate(request("SUCCESS")).state).toBe("absent");
  });
});

describe("isTrustedCertificate", () => {
  const verified = readClientCertificate(request(VERIFIED));

  test("trusts a verified certificate from the pinned issuer with a pinned fingerprint", () => {
    expect(
      isTrustedCertificate(verified, {
        issuerDN: VERIFIED.certIssuerDN,
        fingerprintsSHA256: [VERIFIED.certFingerprintSHA256],
      }),
    ).toBe(true);
  });

  test("compares fingerprints without regard to case or colons", () => {
    const spelled = VERIFIED.certFingerprintSHA256.toLowerCase().replace(/(..)(?!$)/g, "$1:");
    expect(isTrustedCertificate(verified, { fingerprintsSHA256: [spelled] })).toBe(true);
  });

  test("refuses another issuer, and a fingerprint it was not told about", () => {
    const pinned = [VERIFIED.certFingerprintSHA256];
    expect(isTrustedCertificate(verified, { issuerDN: "CN=Somebody Else", fingerprintsSHA256: pinned })).toBe(false);
    expect(isTrustedCertificate(verified, { fingerprintsSHA256: ["00".repeat(32)] })).toBe(false);
  });

  test("refuses every state but verified, whatever the pins say", () => {
    for (const cert of [
      readClientCertificate(request(PLACEHOLDER)),
      readClientCertificate(request({ ...VERIFIED, certRevoked: "1" })),
      readClientCertificate(request({ ...VERIFIED, certVerified: "FAILED:unable to get issuer certificate" })),
    ]) {
      const pins = { issuerDN: VERIFIED.certIssuerDN, fingerprintsSHA256: [VERIFIED.certFingerprintSHA256] };
      expect(isTrustedCertificate(cert, pins), cert.state).toBe(false);
    }
  });

  test("refuses to trust on no pin at all, because any certificate the zone's CA issued would pass", () => {
    expect(isTrustedCertificate(verified, {} as unknown as CertificatePins)).toBe(false);
    expect(isTrustedCertificate(verified, { fingerprintsSHA256: [] })).toBe(false);
  });

  test("refuses an issuer pin on its own, because on a shared CA every verified certificate names that issuer", () => {
    // The zone rule has already refused every certificate the CA did not issue, so behind it the issuer
    // check matches all of them. Cast, because the type already refuses this; the runtime must as well.
    const issuerOnly = { issuerDN: VERIFIED.certIssuerDN } as unknown as CertificatePins;
    expect(isTrustedCertificate(verified, issuerOnly)).toBe(false);
    expect(isTrustedCertificate(verified, { issuerDN: VERIFIED.certIssuerDN, fingerprintsSHA256: [] })).toBe(false);
  });
});
