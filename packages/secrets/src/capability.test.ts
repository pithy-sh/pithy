// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, describe, expect, test } from "vitest";
import { isSecretsCapability, secrets } from "./capability";
import { defineSecretRegistry } from "./registry";
import { resetSharedSecrets, sharedSecretsStore } from "./sharedSecretsStore";

const registry = defineSecretRegistry({
  "auth-signing-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
});

function cap() {
  return secrets({ registry });
}

describe("secrets capability", () => {
  test("contributes a dedicated SECRETS database with both tables", () => {
    const db = cap().databases?.secrets;
    expect(db?.binding).toBe("SECRETS");
    expect(Object.keys(db?.tables ?? {}).sort()).toEqual(["pithySecretsRotations", "pithySecretsSystemSecrets"]);
  });

  // Table keys are camelCase (CamelCasePlugin emits the snake_case `pithy_secrets_` SQL);
  // every provided table is namespaced under the capability so it can't clash with an adopter's.
  test("every provided table is namespaced under pithySecrets", () => {
    for (const name of Object.keys(cap().databases?.secrets?.tables ?? {})) {
      expect(name.startsWith("pithySecrets")).toBe(true);
    }
  });

  test("requires the SECRETS d1 binding and the encryption-key secret binding", () => {
    const byName = Object.fromEntries(cap().requiredBindings.map((b) => [b.name, b.type]));
    expect(byName.SECRETS).toBe("d1");
    expect(byName.SECRETS_ENCRYPTION_KEYS).toBe("secret");
  });

  test("ships the 0001_init migration at its declared order", () => {
    const db = cap().databases?.secrets;
    expect(Object.keys(db?.migrations ?? {})).toEqual(["0001_init"]);
    expect(db?.migrationOrder).toBe(100);
  });

  test("carries the registry and defaults the rotation interval, discoverable via isSecretsCapability", () => {
    const capability = cap();
    expect(capability.secretRegistry).toBe(registry);
    expect(capability.rotationIntervalDays).toBe(30);
    expect(isSecretsCapability(capability)).toBe(true);
  });

  test("honors an explicit rotation interval", () => {
    expect(secrets({ registry, rotationIntervalDays: 7 }).rotationIntervalDays).toBe(7);
  });

  test("defaults the shared-secrets cache TTL to 60 seconds and honors an override", () => {
    expect(cap().secretsCacheTtlSeconds).toBe(60);
    expect(secrets({ registry, secretsCacheTtlSeconds: 10 }).secretsCacheTtlSeconds).toBe(10);
  });
});

describe("secrets capability compose hook", () => {
  afterEach(() => resetSharedSecrets());

  test("aggregates every capability's registry into the shared accessor", async () => {
    const capability = secrets({ registry });
    // The email capability declares its own slice; compose must merge it into the shared registry.
    const emailSlice = defineSecretRegistry({
      "email-link-signing-key": { backend: "d1", scope: "global", rotatable: true, valueType: "text" },
    });
    const emailCap = defineCapability({ name: "email", requiredBindings: [], secretRegistry: emailSlice });
    capability.compose?.({ capabilities: [capability, emailCap] });

    // The shared accessor is now configured with the merged registry: a name no capability declared
    // fails the membership guard, proving compose aggregated and configured it.
    const undeclared = defineSecretRegistry({
      nope: { backend: "d1", scope: "global", rotatable: false, valueType: "text" },
    });
    const env = {} as Parameters<typeof sharedSecretsStore>[0];
    await expect(sharedSecretsStore(env, undeclared)).rejects.toThrowError(/not in the aggregated registry/);
    // Both the project secret and the email slice are members, so the guard passes and resolution
    // proceeds — against an empty env, which no longer fails the resolution: an unresolvable secret
    // holds its error for its own read (#170).
    await expect(sharedSecretsStore(env, emailSlice)).resolves.toBeDefined();
  });
});
