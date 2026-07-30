// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { SecretCryptoError } from "../error/errors";
import { decryptValue, EncryptionConfig, encryptValue } from "./envelope";

function randomKeyB64(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function config(currentVersion = 1, versions?: Record<string, string>): EncryptionConfig {
  return {
    currentVersion: String(currentVersion),
    versions: versions ?? { [String(currentVersion)]: randomKeyB64() },
    lastRotatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("encryptValue / decryptValue", () => {
  test("round-trips plaintext under the current key version", async () => {
    const cfg = config(1);
    const envelope = await encryptValue(cfg, "super-secret");
    expect(envelope.keyVersion).toBe(1);
    expect(envelope.encryptedValue).not.toContain("super-secret");
    expect(await decryptValue(cfg, envelope.encryptedValue, envelope.iv, envelope.keyVersion)).toBe("super-secret");
  });

  test("uses a fresh IV per encryption", async () => {
    const cfg = config();
    const a = await encryptValue(cfg, "x");
    const b = await encryptValue(cfg, "x");
    expect(a.iv).not.toBe(b.iv);
    expect(a.encryptedValue).not.toBe(b.encryptedValue);
  });

  test("decrypts an old key version during a rotation overlap window", async () => {
    const k1 = randomKeyB64();
    const v1 = config(1, { "1": k1 });
    const envelope = await encryptValue(v1, "rotate-me");
    // The at-rest job adds v2 and keeps v1 until every row is re-encrypted.
    const v2 = config(2, { "1": k1, "2": randomKeyB64() });
    expect(await decryptValue(v2, envelope.encryptedValue, envelope.iv, envelope.keyVersion)).toBe("rotate-me");
  });

  test("throws crypto_failed when the key version is absent", async () => {
    const cfg = config(1);
    const envelope = await encryptValue(cfg, "x");
    await expect(decryptValue(cfg, envelope.encryptedValue, envelope.iv, 99)).rejects.toBeInstanceOf(SecretCryptoError);
  });

  test("throws crypto_failed on tampered ciphertext", async () => {
    const cfg = config(1);
    const envelope = await encryptValue(cfg, "x");
    const flipped = (envelope.encryptedValue.startsWith("A") ? "B" : "A") + envelope.encryptedValue.slice(1);
    await expect(decryptValue(cfg, flipped, envelope.iv, envelope.keyVersion)).rejects.toBeInstanceOf(
      SecretCryptoError,
    );
  });

  test("rejects a malformed config", () => {
    expect(() =>
      EncryptionConfig.parse({ currentVersion: "1", versions: { "1": "k" }, lastRotatedAt: "nope" }),
    ).toThrow();
  });
});
