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
    const envelope = await encryptValue(cfg, "api-token", "super-secret");
    expect(envelope.keyVersion).toBe(1);
    expect(envelope.encryptedValue).not.toContain("super-secret");
    expect(await decryptValue(cfg, "api-token", envelope)).toBe("super-secret");
  });

  test("uses a fresh IV per encryption", async () => {
    const cfg = config();
    const a = await encryptValue(cfg, "k", "x");
    const b = await encryptValue(cfg, "k", "x");
    expect(a.iv).not.toBe(b.iv);
    expect(a.encryptedValue).not.toBe(b.encryptedValue);
  });

  test("decrypts an old key version during a rotation overlap window", async () => {
    const k1 = randomKeyB64();
    const v1 = config(1, { "1": k1 });
    const envelope = await encryptValue(v1, "k", "rotate-me");
    // The at-rest job adds v2 and keeps v1 until every row is re-encrypted.
    const v2 = config(2, { "1": k1, "2": randomKeyB64() });
    expect(await decryptValue(v2, "k", envelope)).toBe("rotate-me");
  });

  test("throws crypto_failed when the key version is absent", async () => {
    const cfg = config(1);
    const envelope = await encryptValue(cfg, "k", "x");
    await expect(decryptValue(cfg, "k", { ...envelope, keyVersion: 99 })).rejects.toBeInstanceOf(SecretCryptoError);
  });

  test("throws crypto_failed on tampered ciphertext", async () => {
    const cfg = config(1);
    const envelope = await encryptValue(cfg, "k", "x");
    const flipped = (envelope.encryptedValue.startsWith("A") ? "B" : "A") + envelope.encryptedValue.slice(1);
    await expect(decryptValue(cfg, "k", { ...envelope, encryptedValue: flipped })).rejects.toBeInstanceOf(
      SecretCryptoError,
    );
  });

  test("rejects a malformed config", () => {
    expect(() =>
      EncryptionConfig.parse({ currentVersion: "1", versions: { "1": "k" }, lastRotatedAt: "nope" }),
    ).toThrow();
  });
});

/**
 * The whole point of binding the name: the key alone is not enough to open a ciphertext.
 *
 * Every case here is one key and two names — so nothing passes because of a key mismatch, and the
 * only thing standing between a moved ciphertext and its plaintext is the authenticated data.
 */
describe("the bound name", () => {
  test("a ciphertext sealed for one secret does not open under another", async () => {
    const cfg = config(1);
    const envelope = await encryptValue(cfg, "billing-webhook-secret", "the-real-value");

    // One master key, the same envelope, a different row. This is the lift-and-move.
    await expect(decryptValue(cfg, "analytics-webhook-secret", envelope)).rejects.toBeInstanceOf(SecretCryptoError);
    expect(await decryptValue(cfg, "billing-webhook-secret", envelope)).toBe("the-real-value");
  });

  test("one keyspace member does not open under another member's key", async () => {
    const cfg = config(1);
    // `<entry>/<key>` is what the store persists for a keyspace member (keyspace.ts).
    const envelope = await encryptValue(cfg, "connection-signing-key/conn_alice", "alice-private-key");

    await expect(decryptValue(cfg, "connection-signing-key/conn_mallory", envelope)).rejects.toBeInstanceOf(
      SecretCryptoError,
    );
  });

  test("the refusal names the context it was attempted under, and is never a raw OperationError", async () => {
    const cfg = config(1);
    const envelope = await encryptValue(cfg, "right-name", "v");

    const error = await decryptValue(cfg, "wrong-name", envelope).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SecretCryptoError);
    const payload = (error as SecretCryptoError).payload;
    expect(payload.code).toBe("secrets/crypto_failed");
    expect(payload.detail).toContain("wrong-name");
    // The public half stays generic. Which of key, bytes or name failed is not the caller's business.
    expect(payload.message).not.toContain("wrong-name");
  });

  test("a prefix of another name is a different name — no separator confusion", async () => {
    const cfg = config(1);
    const envelope = await encryptValue(cfg, "token", "v");

    await expect(decryptValue(cfg, "token-2", envelope)).rejects.toBeInstanceOf(SecretCryptoError);
    await expect(decryptValue(cfg, "tok", envelope)).rejects.toBeInstanceOf(SecretCryptoError);
  });

  test("an empty name is refused on both halves rather than binding nothing", async () => {
    const cfg = config(1);
    await expect(encryptValue(cfg, "", "v")).rejects.toBeInstanceOf(SecretCryptoError);

    const envelope = await encryptValue(cfg, "k", "v");
    await expect(decryptValue(cfg, "", envelope)).rejects.toBeInstanceOf(SecretCryptoError);
  });

  test("an unbound ciphertext does not open — there is no legacy path", async () => {
    const cfg = config(1);
    const keyB64 = cfg.versions["1"] as string;
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(keyB64), (char) => char.charCodeAt(0)),
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    // Exactly what the old envelope wrote: correct key, correct IV, no additionalData.
    const raw = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode("pre-aad"));

    let binary = "";
    for (const byte of new Uint8Array(raw)) binary += String.fromCharCode(byte);
    let ivBinary = "";
    for (const byte of iv) ivBinary += String.fromCharCode(byte);

    await expect(
      decryptValue(cfg, "k", { encryptedValue: btoa(binary), iv: btoa(ivBinary), keyVersion: 1 }),
    ).rejects.toBeInstanceOf(SecretCryptoError);
  });
});
