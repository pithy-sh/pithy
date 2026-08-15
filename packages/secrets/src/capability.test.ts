// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { afterEach, describe, expect, test } from "vitest";
import { isSecretsCapability, masterKeyRegistryEntry, secrets, secretsTokenProfile } from "./capability";
import { MASTER_KEY_BINDING } from "./env/bindings";
import { managerRegistry } from "./manager/managerRegistry";
import { defineSecretRegistry, isMintableSecret, type SecretRegistryEntry } from "./registry";
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
    expect(capability.secretRegistry).toMatchObject(registry);
    expect(capability.rotationIntervalDays).toBe(30);
    expect(isSecretsCapability(capability)).toBe(true);
  });

  test("declares its own master key, so the binding it requires has a secret that fills it", () => {
    // #179: `SECRETS_ENCRYPTION_KEYS` was a bare required binding with no backend, so nothing could
    // route it and dev needed a file and a special case of its own.
    expect(cap().secretRegistry.SECRETS_ENCRYPTION_KEYS).toEqual(masterKeyRegistryEntry);
    expect(masterKeyRegistryEntry.backend).toBe("cf-secrets-store");
    expect(masterKeyRegistryEntry.bootstrap).toBe(true);
  });

  test("an adopter's own entry for the master key wins — the default is a floor, not a ceiling", () => {
    const mine = defineSecretRegistry({
      SECRETS_ENCRYPTION_KEYS: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
    });
    expect(secrets({ registry: mine }).secretRegistry.SECRETS_ENCRYPTION_KEYS?.scope).toBe("global");
  });

  test("honors an explicit rotation interval", () => {
    expect(secrets({ registry, rotationIntervalDays: 7 }).rotationIntervalDays).toBe(7);
  });

  test("defaults the shared-secrets cache TTL to 60 seconds and honors an override", () => {
    expect(cap().secretsCacheTtlSeconds).toBe(60);
    expect(secrets({ registry, secretsCacheTtlSeconds: 10 }).secretsCacheTtlSeconds).toBe(10);
  });

  test("declares a management surface, always, behind its own scopes", () => {
    // Always declared and always mounted, so it is default-denied rather than absent: a surface that
    // appears only once `controlplane()` is composed is a surface nobody can discover.
    expect(cap().adminRoutes?.map((route) => `${route.method} ${route.path} ${route.scope}`)).toEqual([
      "GET /secrets/admin/status secrets:status:read",
      "GET /secrets/admin/status/:name/rotations secrets:status:read",
      // The write, behind a scope of its own. Spelled out beside the reads rather than checked in a loop,
      // because the pairing is the fact: a rotation quietly sharing `secrets:status:read` would confer
      // credential replacement on every adopter who ever granted a status pane.
      "POST /secrets/admin/status/:name/rotate secrets:rotate",
    ]);
  });

  test("moves the advertised paths with the mount point", () => {
    // The trap: a `?? "/secrets"` fallback living only in the route registrar would let the manifest
    // advertise one path while the routes mounted at another, and a management client composing its
    // calls from the manifest would 404 against exactly the adopters who customised anything.
    const moved = secrets({ registry, basePath: "/vault" });
    for (const route of moved.adminRoutes ?? []) expect(route.path.startsWith("/vault/")).toBe(true);
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

describe("the master key entry the capability merges in", () => {
  test("is held to the same define-time rules as every other secret", () => {
    // It was the one entry no `defineSecretRegistry` ever saw: `secrets()` merged it straight into the
    // registry it hands the accessor. So a contradiction in the kit's own most important secret would
    // have reached a Worker, while an adopter's identical mistake was refused at define time.
    expect(() => defineSecretRegistry({ [MASTER_KEY_BINDING]: masterKeyRegistryEntry })).not.toThrow();
    const contradiction = {
      backend: "d1",
      scope: "environment",
      rotatable: false,
      valueType: "text",
      origin: { kind: "obtained", issuer: "github", documentation: "https://github.com/settings" },
      rotation: { kind: "local" },
    } as unknown as SecretRegistryEntry;
    expect(() => secrets({ registry: { "adopter-secret": contradiction } })).toThrow(/rotation/);
  });
});

describe("pithy.manifest.json", () => {
  const manifest = CapabilityManifest.parse(
    JSON.parse(readFileSync(new URL("../pithy.manifest.json", import.meta.url), "utf8")),
  );

  /**
   * Everything this package declares for itself, and the reason the gate below spans two registries.
   *
   * `@pithy-sh/secrets` ships two: the capability's — an adopter's entries plus the master key merged in
   * — and the manager Worker's. Only the first was ever held to the manifest, so the manager's Cloudflare
   * token declared both axes correctly and reached no client: a gate over one of two registries is a gate
   * with a blind half, and the half it could not see is the one holding a live account credential.
   *
   * The adopter's own entries are excluded by passing an empty registry, not by filtering: what an
   * adopter declares is theirs and belongs in no manifest of ours.
   */
  const ownEntries: [string, SecretRegistryEntry][] = [
    ...Object.entries(secrets({ registry: {} }).secretRegistry),
    ...Object.entries(managerRegistry),
  ];

  test("declares the master key as minted, structured, and locally replaced", () => {
    // The correction #322 was built on, carried through to a client. A dashboard reading this sees a
    // secret the kit makes — not one to go and get from somewhere — and it sees that without being told
    // what an `EncryptionConfig` is.
    expect(manifest.secrets.find((secret) => secret.name === MASTER_KEY_BINDING)).toEqual({
      name: MASTER_KEY_BINDING,
      origin: { kind: "minted", recipe: { kind: "encryptionConfig" } },
      rotation: { kind: "local" },
    });
  });

  test("every entry of both its registries is in the manifest, with where it comes from and how it is replaced", () => {
    // Stated as the invariant, not as a filtered comparison. The filtered version could not fail for the
    // one case it existed to catch: an entry declaring neither axis is dropped from the expected list and
    // is absent from the manifest, so it vanishes from both sides and the comparison passes.
    expect(manifest.secrets.map((secret) => secret.name)).toEqual(ownEntries.map(([name]) => name));
    for (const [name, entry] of ownEntries) {
      expect(entry.origin, `${name} declares no origin`).toBeDefined();
      expect(entry.rotation, `${name} declares no rotation`).toBeDefined();
      expect(manifest.secrets.find((secret) => secret.name === name)).toEqual({
        name,
        origin: entry.origin,
        rotation: entry.rotation,
      });
    }
  });

  test("declares no devSecret for it — a random string is not an EncryptionConfig", () => {
    // Minted and not `devValue`-mintable are both true of this secret, which is the distinction the
    // recipe union exists to hold. `defineSecretRegistry` refuses the pair that would claim otherwise.
    expect(manifest.devSecrets).toEqual([]);
    expect(isMintableSecret(masterKeyRegistryEntry)).toBe(false);
  });
});

describe("the Cloudflare token the manager runs on", () => {
  test("needs exactly what the token profile mints, and nothing downstream repeats it", () => {
    // The drift this declaration exists to end: a dashboard composing `pithy token mint …` used to hold
    // its own copy of these. One list, two readers, and a test that they are the same list.
    const origin = managerRegistry.CLOUDFLARE_API_TOKEN.origin;
    expect(origin?.kind).toBe("helped");
    expect(origin?.kind === "helped" && origin.needs.cloudflare).toEqual(secretsTokenProfile.permissions);
  });

  test("is helped to create and provider to rotate — the pair one axis cannot express", () => {
    // We cannot mint it: that needs credentials for their account. Cloudflare can roll it and return the
    // new value, so it can still replace itself. Neither fact follows from the other.
    expect(managerRegistry.CLOUDFLARE_API_TOKEN.rotation).toMatchObject({ kind: "provider", issuer: "cloudflare" });
  });
});
