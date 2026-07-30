// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { SecretCryptoError } from "../error/errors";
import { resolveBinding, resolveEncryptionConfig, type SecretsStoreEnv } from "./bindings";

function envWith(keys: unknown): SecretsStoreEnv {
  return { SECRETS_ENCRYPTION_KEYS: JSON.stringify(keys) } as unknown as SecretsStoreEnv;
}

describe("resolveBinding", () => {
  test("a literal string (local dev .dev.vars) passes through", async () => {
    expect(await resolveBinding("plain-value", "TOKEN")).toBe("plain-value");
  });

  test("a CF Secrets Store binding resolves via .get()", async () => {
    expect(await resolveBinding({ get: async () => "from-binding" }, "TOKEN")).toBe("from-binding");
  });

  test("a missing binding fails loudly", async () => {
    await expect(resolveBinding(undefined, "TOKEN")).rejects.toThrow();
  });
});

describe("resolveEncryptionConfig", () => {
  test("resolves the versioned-value shape", async () => {
    const config = { currentVersion: "1", versions: { "1": "k1" }, lastRotatedAt: "2026-01-01T00:00:00.000Z" };
    expect(await resolveEncryptionConfig(envWith(config))).toEqual(config);
  });

  test("a malformed config is a crypto fault", async () => {
    await expect(resolveEncryptionConfig(envWith({ nope: true }))).rejects.toBeInstanceOf(SecretCryptoError);
  });
});
