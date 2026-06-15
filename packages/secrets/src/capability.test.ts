import { describe, expect, test } from "vitest";
import { isSecretsCapability, secrets } from "./capability";
import { defineSecretRegistry } from "./registry";

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
});
