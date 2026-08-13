// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { authSecretsRegistry } from "@pithy-sh/auth/src/instance/secrets";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { emailSigningRegistry } from "@pithy-sh/email/src/crypto/signingKey";
import { masterKeyRegistryEntry } from "@pithy-sh/secrets/src/capability";
import type { SecretWriteRequest } from "@pithy-sh/secrets/src/cli/dispatch";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/bindings";
import { managerRegistry } from "@pithy-sh/secrets/src/manager/managerRegistry";
import { isMintableSecret, type SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { mintDeclaredSecrets } from "../capabilities/mintSecrets";
import { secretsStoreBindings } from "./secretBindings";

/**
 * **The gate #321 shipped without, and the reason it could ship broken.**
 *
 * `pithy provision` gained a minter, and the minter could never fire. It iterated the list of secrets
 * that get a `secrets_store_secrets` binding — `backend === "cf-secrets-store"` — and then asked
 * {@link isMintableSecret}, which is `devValue !== undefined`. Every `cf-secrets-store` secret the kit
 * declares is one no random string can satisfy: `SECRETS_ENCRYPTION_KEYS` is an `EncryptionConfig` the
 * master-key provisioner writes, `CLOUDFLARE_API_TOKEN` is issued by Cloudflare. Every secret that
 * declares a `devValue` is `d1`. The two predicates had an empty intersection, so no project could
 * supply an input, and the feature's own tests passed because each of them built a registry out of
 * literals rather than reading one the kit ships.
 *
 * So this test does not build a registry. It reads the four the kit actually ships, and it does not
 * restate which backend which creator covers — restating the rule is how the rule stops being checked.
 * It **runs every creator there is** and asks what came out. A secret the kit calls arbitrary and no
 * creator produces is named here, by name, and the suite is red until something makes it.
 */

/**
 * Every secret registry the kit itself ships, keyed by the capability an adopter composes to get it.
 *
 * The master key is listed as the one-entry registry `secrets()` merges in rather than by constructing
 * the capability: the capability wants a config and a Worker, and the entry is what is under test.
 */
const SHIPPED_REGISTRIES: Record<string, SecretRegistry> = {
  auth: authSecretsRegistry,
  email: emailSigningRegistry,
  secrets: { [MASTER_KEY_BINDING]: masterKeyRegistryEntry },
  "secrets manager": managerRegistry,
};

/** Every shipped registry merged by secret name — the set one project can declare at once. */
function everyShippedSecret(): SecretRegistry {
  return Object.assign({}, ...Object.values(SHIPPED_REGISTRIES)) as SecretRegistry;
}

/** The names a registry declares arbitrary: the set something is obliged to be able to create. */
function declaredMintable(registry: SecretRegistry): string[] {
  return Object.entries(registry)
    .filter(([, entry]) => isMintableSecret(entry))
    .map(([name]) => name)
    .sort();
}

/**
 * Run every creator the CLI has over one registry and return what each said it created.
 *
 * Both are driven with the I/O that describes a freshly provisioned environment — nothing in the store,
 * nothing in the manager — so what comes back is the set a first provision would produce. The stubs
 * record names and nothing else; no creator here is asked for, or given, a value.
 */
async function everythingTheCliCreates(registry: SecretRegistry): Promise<string[]> {
  const created = new Set<string>();

  const store = await secretsStoreBindings({
    registry,
    scope: environmentScope("kit", "staging"),
    storeId: "store-id",
    exists: async () => false,
    mint: async ({ binding }) => {
      created.add(binding);
    },
  });
  for (const name of store.minted) created.add(name);

  const dispatched: SecretWriteRequest[] = [];
  await mintDeclaredSecrets({
    registry,
    dispatcher: {
      dispatch: async (request) => {
        dispatched.push(request);
      },
    },
    environments: ["staging", "prod"],
  });
  for (const request of dispatched) created.add(request.name);

  return [...created].sort();
}

describe("what the kit declares mintable, and what the CLI can actually mint", () => {
  test("every secret the kit ships as arbitrary is created by a creator that exists", async () => {
    const registry = everyShippedSecret();
    const mintable = declaredMintable(registry);

    // The gate cannot pass by the kit declaring nothing arbitrary. If this ever empties, the check
    // below becomes `[] === []` and stops being a check — which is the shape #321's tests had.
    expect(mintable.length).toBeGreaterThan(0);

    expect(await everythingTheCliCreates(registry)).toEqual(mintable);
  });

  test.each(Object.entries(SHIPPED_REGISTRIES))("%s leaves nothing arbitrary for a human", async (_, registry) => {
    expect(await everythingTheCliCreates(registry)).toEqual(declaredMintable(registry));
  });
});
