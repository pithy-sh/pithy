import { describe, expect, test } from "vitest";
import { PaymentsInvalidReceiptError, PaymentsVerificationFailedError } from "../../error/errors";
import { APPLE_ROOT_CERTIFICATES } from "./certs";
import { decodeBase64 } from "./der";
import { mintChain } from "./fixtures/chain";
import { parseCertificate, verifyCertificateChain } from "./x509";

const appleRoot = () => decodeBase64(APPLE_ROOT_CERTIFICATES[0] as string);

describe("parseCertificate", () => {
  test("reads Apple Root CA - G3 — the pinned asset, parsed by the code that will meet it", () => {
    const certificate = parseCertificate(appleRoot());
    // A root is its own issuer, which is the one structural fact a self-signed certificate asserts.
    expect([...certificate.issuer]).toEqual([...certificate.subject]);
    expect(certificate.notBefore.toISOString()).toBe("2014-04-30T18:19:06.000Z");
    expect(certificate.notAfter.toISOString()).toBe("2039-04-30T18:19:06.000Z");
    expect(certificate.signatureAlgorithm).toBe("1.2.840.10045.4.3.3");
    expect(certificate.curve).toBe("P-384");
  });

  test("reads Apple Root CA - G3's extensions — a real certificate, not just our own minter's output", () => {
    // The point of this case: the extension reader and the fixture minter are both mine, so a bug they
    // share would make every other test agree with itself and still be wrong. Apple's real root is the
    // independent input that catches that, and it is the certificate the CA check will actually meet.
    const certificate = parseCertificate(appleRoot());
    expect(certificate.basicConstraints).toEqual({ ca: true });
    expect(certificate.keyCertSign).toBe(true);
    // 2.5.29.19 basicConstraints, 2.5.29.15 keyUsage, 2.5.29.14 subjectKeyIdentifier — all critical or not,
    // all present on Apple's root.
    expect([...certificate.extensions.keys()].sort()).toContain("2.5.29.19");
    expect(certificate.extensions.get("2.5.29.19")?.critical).toBe(true);
  });

  test("the tbs it keeps is the encoding the issuer signed, not the contents", () => {
    const certificate = parseCertificate(appleRoot());
    // A signature covers the tagged, length-prefixed tbsCertificate. Dropping the header would make every
    // signature fail, and reconstructing it would make a re-encoding bug into a verification bypass.
    expect(certificate.tbs[0]).toBe(0x30);
  });

  test("the public key it exposes imports as a verifying key", async () => {
    const certificate = parseCertificate(appleRoot());
    const key = await crypto.subtle.importKey(
      "spki",
      certificate.spki as unknown as ArrayBuffer,
      { name: "ECDSA", namedCurve: certificate.curve },
      false,
      ["verify"],
    );
    expect(key.type).toBe("public");
  });

  test("refuses bytes that are not a certificate", () => {
    expect(() => parseCertificate(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]))).toThrow(PaymentsInvalidReceiptError);
  });

  test("refuses a real RSA certificate — Apple's chain is elliptic-curve end to end", () => {
    // Apple Worldwide Developer Relations Certification Authority, OU=G7: a genuine, public, RSA-keyed
    // Apple certificate. It parses as DER and its SPKI names rsaEncryption with NULL parameters, so it
    // reaches the curve check and is refused there. Rejecting RSA is deliberate, not an oversight — see
    // certs.ts. A real certificate is used because a synthetic one could fail earlier for the wrong reason.
    const rsa = decodeBase64(
      "MIIEVTCCAz2gAwIBAgIUNBhY/wH+Bj+O8Z8f6TwBtMFG/8kwDQYJKoZIhvcNAQEFBQAwYjELMAkGA1UEBhMCVVMxEzARBgNVBAoTCkFwcGxlIEluYy4xJjAkBgNVBAsTHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRYwFAYDVQQDEw1BcHBsZSBSb290IENBMB4XDTIyMTExNzIwNDA1M1oXDTIzMTExNzIwNDA1MlowdTELMAkGA1UEBhMCVVMxEzARBgNVBAoMCkFwcGxlIEluYy4xCzAJBgNVBAsMAkc3MUQwQgYDVQQDDDtBcHBsZSBXb3JsZHdpZGUgRGV2ZWxvcGVyIFJlbGF0aW9ucyBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKyu0dO2irEbKJWt3lFRTD8z4U5cr7P8AtJlTyrUdGiMdRdlzyjkSAmYcVIyLBZOeI6SVmSp3YvN4tTHO6ISRTcCGWJkL39hxtNZIr+r+RSj7baembov8bHcMEJPtrayxnSqYla77UQ2D9HlIHSTVzpdntwB/HhvaRY1w24Bwp5y1HE2sXYJer4NKpfxsF4LGxKtK6sH32Mt9YjpMhKiVVhDdjw9F4AfKduxqZ+rlgWdFdzd204P5xN8WisuAkH27npqtnNg95cZFIuVMziT2gAlNq5VWnyf+fRiBAd06R2nlVcjrCsk2mRPKHLplrAIPIgbFGND14mumMHyLY7jUSUCAwEAAaOB7zCB7DASBgNVHRMBAf8ECDAGAQH/AgEAMB8GA1UdIwQYMBaAFCvQaUeUdgn+9GuNLkCm90dNfwheMEQGCCsGAQUFBwEBBDgwNjA0BggrBgEFBQcwAYYoaHR0cDovL29jc3AuYXBwbGUuY29tL29jc3AwMy1hcHBsZXJvb3RjYTAuBgNVHR8EJzAlMCOgIaAfhh1odHRwOi8vY3JsLmFwcGxlLmNvbS9yb290LmNybDAdBgNVHQ4EFgQUXUIQbBu7x1KXTkS9Eye5OhJ3gyswDgYDVR0PAQH/BAQDAgEGMBAGCiqGSIb3Y2QGAgEEAgUAMA0GCSqGSIb3DQEBBQUAA4IBAQBSowgpE2W3tR/mNAPt9hh3vD3KJ7Vw7OxsM0v2mSWUB54hMwNq9X0KLivfCKmC3kp/4ecLSwW4J5hJ3cEMhteBZK6CnMRF8eqPHCIw46IlYUSJ/oV6VvByknwMRFQkt7WknybwMvlXnWp5bEDtDzQGBkL/2A4xZW3mLgHZBr/Fyg2uR9QFF4g86ZzkGWRtipStEdwB9uV4r63ocNcNXYE+RiosriShx9Lgfb8d9TZrxd6pCpqAsRFesmR+s8FXzMJsWZm39LDdMdpI1mqB7rKLUDUW5udccWJusPJR4qht+CrLaHPGpsQaQ0kBPqmpAIqGbIOI0lxwV3ra+HbMGdWw",
    );
    expect(() => parseCertificate(rsa)).toThrow(PaymentsInvalidReceiptError);
    // The refusal is the key-algorithm check, not an earlier structural failure. Asserted on `detail`,
    // because `message` is the client-safe half and deliberately says nothing about why.
    let detail = "";
    try {
      parseCertificate(rsa);
    } catch (error) {
      detail = (error as PaymentsInvalidReceiptError).payload.detail ?? "";
    }
    // rsaEncryption's algorithm parameters are a NULL where an EC key names its curve.
    expect(detail).toMatch(/OBJECT IDENTIFIER|curve/);
  });
});

describe("verifyCertificateChain", () => {
  test("verifies a chain that roots in a pinned certificate, and returns the leaf's key", async () => {
    const chain = await mintChain();
    const leaf = await verifyCertificateChain(chain.x5c.map(decodeBase64), {
      roots: [chain.root],
      now: new Date(),
    });
    expect(leaf.key.type).toBe("public");
    expect(leaf.curve).toBe("P-256");
  });

  test("refuses a chain whose root is not pinned — the whole point of pinning", async () => {
    const trusted = await mintChain({ label: "trusted" });
    const rogue = await mintChain({ label: "rogue" });
    // The rogue chain is internally perfect: every signature checks out, every window is valid. It is
    // refused solely because its root is not one we shipped.
    await expect(
      verifyCertificateChain(rogue.x5c.map(decodeBase64), { roots: [trusted.root], now: new Date() }),
    ).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("refuses a chain with the root stripped off, rather than trusting the intermediate", async () => {
    const chain = await mintChain();
    await expect(
      verifyCertificateChain(chain.x5c.slice(0, 2).map(decodeBase64), { roots: [chain.root], now: new Date() }),
    ).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("refuses a chain of one certificate", async () => {
    const chain = await mintChain();
    await expect(
      verifyCertificateChain(chain.x5c.slice(0, 1).map(decodeBase64), { roots: [chain.root], now: new Date() }),
    ).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("refuses a chain whose links do not sign one another", async () => {
    const chain = await mintChain({ label: "a" });
    const other = await mintChain({ label: "b" });
    // Another chain's leaf, spliced in front of this chain's intermediate and root. The root is pinned and
    // the intermediate is genuine; only the leaf's signature is by a key that never signed it.
    const spliced = [other.x5c[0] as string, chain.x5c[1] as string, chain.x5c[2] as string];
    await expect(
      verifyCertificateChain(spliced.map(decodeBase64), { roots: [chain.root], now: new Date() }),
    ).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("refuses an expired leaf", async () => {
    const past = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const chain = await mintChain({ leafNotBefore: new Date(past.getTime() - 1000), leafNotAfter: past });
    await expect(
      verifyCertificateChain(chain.x5c.map(decodeBase64), { roots: [chain.root], now: new Date() }),
    ).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("refuses a leaf that is not yet valid", async () => {
    const future = new Date(Date.now() + 300 * 24 * 60 * 60 * 1000);
    const chain = await mintChain({ leafNotBefore: future, leafNotAfter: new Date(future.getTime() + 1000) });
    await expect(
      verifyCertificateChain(chain.x5c.map(decodeBase64), { roots: [chain.root], now: new Date() }),
    ).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("refuses an expired intermediate, not only an expired leaf", async () => {
    const past = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const chain = await mintChain({
      intermediateNotBefore: new Date(past.getTime() - 1000),
      intermediateNotAfter: past,
    });
    await expect(
      verifyCertificateChain(chain.x5c.map(decodeBase64), { roots: [chain.root], now: new Date() }),
    ).rejects.toThrow(PaymentsVerificationFailedError);
  });

  test("refuses an empty chain", async () => {
    await expect(verifyCertificateChain([], { roots: APPLE_ROOT_CERTIFICATES, now: new Date() })).rejects.toThrow(
      PaymentsVerificationFailedError,
    );
  });

  test("a chain minted a year ago verifies against a clock inside its window", async () => {
    // The clock is injected, so a validity refusal is a real comparison rather than an accident of when the
    // suite runs.
    const chain = await mintChain();
    await expect(
      verifyCertificateChain(chain.x5c.map(decodeBase64), {
        roots: [chain.root],
        now: new Date(Date.now() + 200 * 24 * 60 * 60 * 1000),
      }),
    ).resolves.toBeDefined();
  });
});

/** The `detail` of a refusal — where the specifics live, since `message` is deliberately client-safe. */
async function refusalDetail(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as PaymentsVerificationFailedError).payload.detail ?? "";
  }
  throw new Error("expected the chain to be refused, but it verified");
}

/**
 * The certificate-authority half of the chain check.
 *
 * Every case here is the same attack in a different disguise: a chain that links, sits inside every validity
 * window, and roots in the pinned certificate — but whose signing certificate was never entitled to sign
 * anything. Before these rules, the whole set verified. `intermediateNotCa` in particular is minted exactly
 * as an ordinary leaf certificate is, because that is what an attacker already has.
 */
describe("verifyCertificateChain — authority", () => {
  test("refuses a chain whose intermediate is not a CA, however well it links", async () => {
    const chain = await mintChain({ intermediateNotCa: true });
    // Everything else about this chain is correct: it links, the signatures verify, the windows contain the
    // clock, and it roots in the pinned certificate. `cA` is the only thing wrong, and it is enough.
    const detail = await refusalDetail(
      verifyCertificateChain(chain.x5c.map(decodeBase64), { roots: [chain.root], now: new Date() }),
    );
    expect(detail).toMatch(/is not a CA/);
  });

  test("refuses an intermediate whose keyUsage omits keyCertSign", async () => {
    const chain = await mintChain({ intermediateWithoutKeyCertSign: true });
    const detail = await refusalDetail(
      verifyCertificateChain(chain.x5c.map(decodeBase64), { roots: [chain.root], now: new Date() }),
    );
    expect(detail).toMatch(/keyCertSign/);
  });

  test("refuses a chain deeper than an intermediate's pathLenConstraint permits", async () => {
    // pathLen 0 says "no CAs beneath me". A sub-intermediate is one, so the four-certificate chain is refused
    // even though every signature in it verifies.
    const chain = await mintChain({ intermediatePathLen: 0, extraIntermediate: true });
    const detail = await refusalDetail(
      verifyCertificateChain(chain.x5c.map(decodeBase64), { roots: [chain.root], now: new Date() }),
    );
    expect(detail).toMatch(/intermediates beneath it/);
  });

  test("accepts a depth the pathLenConstraint does permit", async () => {
    const chain = await mintChain({ intermediatePathLen: 1, extraIntermediate: true });
    await expect(
      verifyCertificateChain(chain.x5c.map(decodeBase64), { roots: [chain.root], now: new Date() }),
    ).resolves.toBeDefined();
  });

  test("refuses a chain longer than the cap, before verifying a single signature", async () => {
    const chain = await mintChain();
    const leaf = decodeBase64(chain.x5c[0] as string);
    const padded = [...Array.from({ length: 11 }, () => leaf), decodeBase64(chain.root)];
    const detail = await refusalDetail(verifyCertificateChain(padded, { roots: [chain.root], now: new Date() }));
    expect(detail).toMatch(/longer than/);
  });
});

/**
 * The identity half. Rooting in Apple's CA proves Apple issued something in the path; Apple's two marker OIDs
 * prove the path is the one Apple signs App Store data with. Without them a genuine Apple sub-CA issued for
 * some other purpose could sign a notification.
 */
describe("verifyCertificateChain — Apple's marker extensions", () => {
  test("refuses a leaf that does not carry the receipt-signer OID", async () => {
    const chain = await mintChain({ leafWithoutSignerOid: true });
    const detail = await refusalDetail(
      verifyCertificateChain(chain.x5c.map(decodeBase64), { roots: [chain.root], now: new Date() }),
    );
    expect(detail).toMatch(/1\.2\.840\.113635\.100\.6\.11\.1/);
  });

  test("refuses an issuer that does not carry the WWDR OID", async () => {
    const chain = await mintChain({ intermediateWithoutWwdrOid: true });
    const detail = await refusalDetail(
      verifyCertificateChain(chain.x5c.map(decodeBase64), { roots: [chain.root], now: new Date() }),
    );
    expect(detail).toMatch(/1\.2\.840\.113635\.100\.6\.2\.1/);
  });

  test("an explicit null opts out, and undefined does not — the default must not be reachable by passing null", async () => {
    // `?? DEFAULT` would fold an explicit null back into the default, quietly re-enabling the very check the
    // caller asked to skip. This pins the distinction.
    const chain = await mintChain({ leafWithoutSignerOid: true, intermediateWithoutWwdrOid: true });
    const der = chain.x5c.map(decodeBase64);
    await expect(
      verifyCertificateChain(der, {
        roots: [chain.root],
        now: new Date(),
        requiredLeafExtension: null,
        requiredIssuerExtension: null,
      }),
    ).resolves.toBeDefined();
    await expect(verifyCertificateChain(der, { roots: [chain.root], now: new Date() })).rejects.toThrow();
  });
});
