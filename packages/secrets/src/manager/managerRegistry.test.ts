// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { RUNTIME_TOKEN_SECRET } from "@pithy-sh/cloudflare/src/tokens/runtime";
import { describe, expect, test } from "vitest";
import { encodeVersionedValue, initialVersionedValue } from "../crypto/versionedValue";
import type { SecretsStoreEnv } from "../env/bindings";
import { secretsStore } from "../secretsStore";
import { runtimeTokenRegistry } from "../tokens/runtimeTokenRegistry";
import { managerRegistry } from "./managerRegistry";

function envWith(token: string): SecretsStoreEnv {
  return { [RUNTIME_TOKEN_SECRET]: token } as unknown as SecretsStoreEnv;
}

describe("managerRegistry", () => {
  test("reads the one runtime token and no Cloudflare token of its own (#728)", () => {
    expect(Object.keys(managerRegistry)).toEqual([RUNTIME_TOKEN_SECRET]);
    // The same declaration every other reader of the token makes, from the one factory, so a Worker
    // composing the manager's registry beside another reader's boots.
    expect(managerRegistry[RUNTIME_TOKEN_SECRET]).toEqual(
      runtimeTokenRegistry(["secrets:read", "secrets:write"])[RUNTIME_TOKEN_SECRET],
    );
  });

  test("declares it per environment — each manager reads its own environment's token", () => {
    expect(managerRegistry[RUNTIME_TOKEN_SECRET]).toMatchObject({
      backend: "cf-secrets-store",
      scope: "environment",
      valueType: "text",
    });
  });

  test("the token resolves through the secretsStore accessor from the binding's uniform envelope", async () => {
    const binding = encodeVersionedValue(initialVersionedValue("scoped-cf-token"));
    const secrets = await secretsStore(envWith(binding), managerRegistry);
    expect(secrets.get(RUNTIME_TOKEN_SECRET)).toBe("scoped-cf-token");
  });

  test("the token resolves from a bare .dev.vars string (local dev)", async () => {
    const secrets = await secretsStore(envWith("bare-dev-token"), managerRegistry);
    expect(secrets.get(RUNTIME_TOKEN_SECRET)).toBe("bare-dev-token");
  });
});
