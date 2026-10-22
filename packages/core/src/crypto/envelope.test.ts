// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { InternalError } from "../error/pithyError";
import { decryptValue, EncryptedEnvelope, EncryptionConfig, encryptValue } from "./envelope";

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
  test("round-trips plaintext under the current key version, binding the context the caller passed", async () => {
    const cfg = config(1);
    const envelope = await encryptValue(cfg, "pithy/enc/1:patient:diagnosis:p_1", "asthma");
    expect(envelope.keyVersion).toBe(1);
    expect(envelope.encryptedValue).not.toContain("asthma");
    expect(await decryptValue(cfg, "pithy/enc/1:patient:diagnosis:p_1", envelope)).toBe("asthma");
  });

  test("seals under whichever version is current, and opens an older one while it is still in the set", async () => {
    const k1 = randomKeyB64();
    const sealed = await encryptValue(config(1, { "1": k1 }), "c", "rotate-me");
    const rotated = config(2, { "1": k1, "2": randomKeyB64() });
    expect((await encryptValue(rotated, "c", "new")).keyVersion).toBe(2);
    expect(await decryptValue(rotated, "c", sealed)).toBe("rotate-me");
  });

  test("uses a fresh IV per seal", async () => {
    const cfg = config();
    const a = await encryptValue(cfg, "c", "x");
    const b = await encryptValue(cfg, "c", "x");
    expect(a.iv).not.toBe(b.iv);
    expect(a.encryptedValue).not.toBe(b.encryptedValue);
  });

  test("a ciphertext sealed under one context does not open under another, or under a prefix of it", async () => {
    const cfg = config(1);
    const envelope = await encryptValue(cfg, "pithy/enc/1:patient:diagnosis:p_1", "asthma");
    for (const other of [
      "pithy/enc/1:patient:diagnosis:p_2",
      "pithy/enc/1:patient:notes:p_1",
      "pithy/enc/1:visit:diagnosis:p_1",
      "pithy/enc/1:patient:diagnosis:p_",
      "pithy.secrets.v1:patient",
    ]) {
      await expect(decryptValue(cfg, other, envelope)).rejects.toBeInstanceOf(InternalError);
    }
  });

  test("the refusal names the context and the key set, never the plaintext", async () => {
    const cfg = config(1);
    const envelope = await encryptValue(cfg, "right", "the-plaintext");
    const wrong = await decryptValue(cfg, "wrong", envelope, { keys: "PITHY_FIELD_KEYS" }).catch((e: unknown) => e);
    expect((wrong as InternalError).payload.detail).toContain("wrong");
    expect((wrong as InternalError).payload.detail).not.toContain("the-plaintext");

    const missing = await decryptValue(
      cfg,
      "right",
      { ...envelope, keyVersion: 9 },
      { keys: "PITHY_FIELD_KEYS" },
    ).catch((e: unknown) => e);
    expect((missing as InternalError).payload.detail).toBe("encryption key version 9 not present in PITHY_FIELD_KEYS");
  });

  test("an empty context is refused on both halves rather than binding nothing", async () => {
    const cfg = config(1);
    await expect(encryptValue(cfg, "", "v")).rejects.toBeInstanceOf(InternalError);
    const envelope = await encryptValue(cfg, "c", "v");
    await expect(decryptValue(cfg, "", envelope)).rejects.toBeInstanceOf(InternalError);
  });

  test("a tampered ciphertext does not open", async () => {
    const cfg = config(1);
    const envelope = await encryptValue(cfg, "c", "x");
    const flipped = (envelope.encryptedValue.startsWith("A") ? "B" : "A") + envelope.encryptedValue.slice(1);
    await expect(decryptValue(cfg, "c", { ...envelope, encryptedValue: flipped })).rejects.toBeInstanceOf(
      InternalError,
    );
  });
});

describe("the schemas", () => {
  test("an envelope parses as exactly what a seal returns", async () => {
    const envelope = await encryptValue(config(4), "c", "x");
    expect(EncryptedEnvelope.parse(envelope)).toEqual(envelope);
    expect(EncryptedEnvelope.safeParse({ encryptedValue: "", iv: "a", keyVersion: 1 }).success).toBe(false);
    expect(EncryptedEnvelope.safeParse("plaintext").success).toBe(false);
  });

  test("a config with a malformed rotation instant is refused", () => {
    expect(
      EncryptionConfig.safeParse({ currentVersion: "1", versions: { "1": "k" }, lastRotatedAt: "nope" }).success,
    ).toBe(false);
  });
});
