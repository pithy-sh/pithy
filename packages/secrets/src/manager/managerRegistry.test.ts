// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { encodeVersionedValue, initialVersionedValue } from "../crypto/versionedValue";
import type { SecretsStoreEnv } from "../env/bindings";
import { secretsStore } from "../secretsStore";
import { managerRegistry } from "./managerRegistry";

function envWith(token: string): SecretsStoreEnv {
  return { CLOUDFLARE_API_TOKEN: token } as unknown as SecretsStoreEnv;
}

describe("managerRegistry", () => {
  test("declares the CF API token as a global, rotatable cf-secrets-store text secret", () => {
    expect(managerRegistry.CLOUDFLARE_API_TOKEN).toEqual({
      backend: "cf-secrets-store",
      scope: "global",
      rotatable: true,
      valueType: "text",
    });
  });

  test("the token resolves through the secretsStore accessor from the binding's uniform envelope", async () => {
    const binding = encodeVersionedValue(initialVersionedValue("scoped-cf-token"));
    const secrets = await secretsStore(envWith(binding), managerRegistry);
    expect(secrets.get("CLOUDFLARE_API_TOKEN")).toBe("scoped-cf-token");
  });

  test("the token resolves from a bare .dev.vars string (local dev)", async () => {
    const secrets = await secretsStore(envWith("bare-dev-token"), managerRegistry);
    expect(secrets.get("CLOUDFLARE_API_TOKEN")).toBe("bare-dev-token");
  });
});
