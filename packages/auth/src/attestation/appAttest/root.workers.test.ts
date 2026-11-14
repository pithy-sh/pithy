// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { APPLE_APP_ATTESTATION_ROOT } from "./root";
import { parseCertificate } from "./x509";

describe("the pinned Apple App Attestation Root CA", () => {
  test("is the certificate Apple publishes, by its SHA-256 fingerprint", async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", APPLE_APP_ATTESTATION_ROOT));
    expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(
      "1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932",
    );
  });

  test("is a P-384 CA valid until 2045", () => {
    const root = parseCertificate(APPLE_APP_ATTESTATION_ROOT);
    expect(root.isCA).toBe(true);
    expect(root.publicKey.curve).toBe("P-384");
    expect(root.notAfter).toEqual(new Date("2045-03-15T00:00:00Z"));
    expect(new TextDecoder().decode(root.subject)).toContain("Apple App Attestation Root CA");
  });
});
