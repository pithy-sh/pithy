// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { authSecretsRegistry } from "@pithy-sh/auth/src/instance/secrets";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { emailSigningRegistry } from "@pithy-sh/email/src/crypto/signingKey";
import { mediaSecretsRegistry } from "@pithy-sh/media/src/secret/registry";
import { paymentsSecretsRegistry } from "@pithy-sh/payments/src/secret/registry";
import { masterKeyRegistryEntry } from "@pithy-sh/secrets/src/capability";
import type { SecretWriteRequest } from "@pithy-sh/secrets/src/cli/dispatch";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/bindings";
import { managerRegistry } from "@pithy-sh/secrets/src/manager/managerRegistry";
import { isMintableSecret, type SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { storageSecretsRegistry } from "@pithy-sh/storage/src/secret/registry";
import { turnstileSecretsRegistry } from "@pithy-sh/turnstile/src/secret/registry";
import { describe, expect, test } from "vitest";
import { managerMintedSecrets, mintDeclaredSecrets } from "../capabilities/mintSecrets";
import { isShippedSource, readSource, sourcePaths } from "../ci/sourceFiles";
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
 * So this test does not build a registry. It reads the ones the kit actually ships, and it does not
 * restate which backend which creator covers — restating the rule is how the rule stops being checked.
 * It **runs every creator there is** and asks what came out. A secret the kit calls arbitrary and no
 * creator produces is named here, by name, and the suite is red until something makes it.
 *
 * ## And the list of registries is held to the repository, not to memory
 *
 * The paragraph above used to say *"it reads the four the kit actually ships"* while eight shipped:
 * media, payments, storage and turnstile each define one and none of them was here. A hand-written list
 * that claims to be exhaustive is the same defect as a hand-written rule that claims to be complete —
 * this gate was itself written during a wave that closed a can't-fail gate, which is how easy it is.
 *
 * So {@link REGISTRY_SITES} is scanned out of the packages, and every site must be accounted for by an
 * entry below. A ninth `defineSecretRegistry` anywhere in the kit fails this file until somebody says
 * which registry it is and what creates its arbitrary secrets.
 */

/** The repo's `packages/`, from this file — `packages/cli/src/provision` is four levels down. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..", "..", "packages");

/**
 * Every module in the kit that calls `defineSecretRegistry`. **A frozen literal**, and the population
 * {@link SHIPPED_REGISTRIES} must cover.
 *
 * Not `packages/secrets/src/registry.ts`: that declares the helper (`defineSecretRegistry<const R…>`)
 * rather than calling it, and `packages/secrets/src/index.ts` only re-exports the name.
 */
const REGISTRY_SITES = [
  "auth/src/instance/secrets.ts",
  "email/src/crypto/signingKey.ts",
  "media/src/secret/registry.ts",
  "payments/src/secret/registry.ts",
  "secrets/src/capability.ts",
  "secrets/src/manager/managerRegistry.ts",
  "storage/src/secret/registry.ts",
  "turnstile/src/secret/registry.ts",
];

/** Every module that calls `defineSecretRegistry`, as the repository has them right now. */
function registrySites(): string[] {
  const found: string[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const path of sourcePaths(join(PACKAGES, pkg.name, "src"), { keep: isShippedSource })) {
      // Comments blanked: three modules discuss the helper by name in prose, and a scan that read a
      // sentence as a call site would put this gate's own docstring on the list. The shared walk, so a
      // `//` in a URL cannot blank the rest of a line and hide a real registration on it (#439).
      const source = blankComments(readSource(path) ?? "");
      if (!source.includes("defineSecretRegistry(")) continue;
      found.push(relative(PACKAGES, path).split("\\").join("/"));
    }
  }
  return found.sort();
}

/**
 * Every secret registry the kit itself ships, keyed by the capability an adopter composes to get it,
 * with the module that defines it — so {@link REGISTRY_SITES} can be checked against this rather than
 * against itself.
 *
 * The master key is listed as the one-entry registry `secrets()` merges in rather than by constructing
 * the capability: the capability wants a config and a Worker, and the entry is what is under test.
 * Storage's is a factory (`r2CredentialsRegistry`) and `storageSecretsRegistry` is the one call of it
 * the kit ships under its own name; media applies the same factory again, and media's registry carries
 * both halves.
 */
const SHIPPED_REGISTRIES: Record<string, { site: string; registry: SecretRegistry }> = {
  auth: { site: "auth/src/instance/secrets.ts", registry: authSecretsRegistry },
  email: { site: "email/src/crypto/signingKey.ts", registry: emailSigningRegistry },
  media: { site: "media/src/secret/registry.ts", registry: mediaSecretsRegistry },
  payments: { site: "payments/src/secret/registry.ts", registry: paymentsSecretsRegistry },
  secrets: { site: "secrets/src/capability.ts", registry: { [MASTER_KEY_BINDING]: masterKeyRegistryEntry } },
  "secrets manager": { site: "secrets/src/manager/managerRegistry.ts", registry: managerRegistry },
  storage: { site: "storage/src/secret/registry.ts", registry: storageSecretsRegistry },
  turnstile: { site: "turnstile/src/secret/registry.ts", registry: turnstileSecretsRegistry },
};

/** The registries alone, in the shape the checks below iterate. */
const REGISTRIES: [string, SecretRegistry][] = Object.entries(SHIPPED_REGISTRIES).map(([name, { registry }]) => [
  name,
  registry,
]);

/** Every shipped registry merged by secret name — the set one project can declare at once. */
function everyShippedSecret(): SecretRegistry {
  return Object.assign({}, ...REGISTRIES.map(([, registry]) => registry)) as SecretRegistry;
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
    // A manager holding nothing, which is what a freshly provisioned environment is. The gate is about
    // whether a creator *exists* for every arbitrary secret, so this is the state where every one of
    // them has work to do — an `always present` probe would make the whole check vacuously green.
    probe: { probe: async () => false },
    environments: ["staging", "prod"],
  });
  for (const request of dispatched) created.add(request.name);

  return [...created].sort();
}

describe("the registries this file claims to read are the ones the kit ships", () => {
  test("every module that defines a registry is one of these", () => {
    // Both directions against the repository, so neither list can drift on its own. The scan is the
    // authority for what exists; the frozen list is what stops a broken scan from making that vacuous.
    expect(registrySites()).toEqual(REGISTRY_SITES);
    expect(
      Object.values(SHIPPED_REGISTRIES)
        .map(({ site }) => site)
        .sort(),
    ).toEqual([...REGISTRY_SITES].sort());
  });

  test("and each of them really parsed into a registry with entries", () => {
    // A registry that imported as an empty object would make every sweep below `[] === []`.
    for (const [name, registry] of REGISTRIES) {
      expect(Object.keys(registry).length, `${name} contributes no secrets`).toBeGreaterThan(0);
    }
  });

  test("which of them declare an arbitrary secret is pinned, so a per-registry sweep cannot go quiet", () => {
    // The per-registry `test.each` below is `[] === []` for a registry that declares nothing arbitrary,
    // and four of these eight declare nothing arbitrary — legitimately, since a Stripe key and an R2
    // credential are obtained rather than minted. That is fine as long as it is *stated*: a registry
    // whose arbitrary secret silently disappeared would turn its case from a real check into an empty
    // one, and nothing else here would notice.
    expect(Object.fromEntries(REGISTRIES.map(([name, registry]) => [name, declaredMintable(registry)]))).toEqual({
      auth: ["auth-session-secret"],
      email: ["email-link-signing-key"],
      media: [],
      payments: [],
      secrets: [],
      "secrets manager": [],
      storage: [],
      turnstile: [],
    });
  });
});

describe("what the kit declares mintable, and what the CLI can actually mint", () => {
  test("every secret the kit ships as arbitrary is created by a creator that exists", async () => {
    const registry = everyShippedSecret();
    const mintable = declaredMintable(registry);

    // The gate cannot pass by the kit declaring nothing arbitrary. If this ever empties, the check
    // below becomes `[] === []` and stops being a check — which is the shape #321's tests had.
    expect(mintable.length).toBeGreaterThan(0);

    expect(await everythingTheCliCreates(registry)).toEqual(mintable);
  });

  test.each(REGISTRIES)("%s leaves nothing arbitrary for a human", async (_, registry) => {
    expect(await everythingTheCliCreates(registry)).toEqual(declaredMintable(registry));
  });
});

/**
 * **The half of provisioning that runs before the thing that could do the work.**
 *
 * `pithy provision --env` and `pithy provision --feature` create an environment's resources, and they
 * run before its secrets manager is necessarily deployed. A `d1` secret is sealed under a master key
 * inside that manager, so only the manager can say whether one exists — which means these two commands
 * cannot create a single one of them, and cannot be made to without deploying a manager first.
 *
 * That limit is real. Finishing quietly was not: a run reported `Provisioned prod. Migrated.` with the
 * session signing key and the link signing key absent, and the next thing to find out was a request.
 *
 * So `pithy provision` names them, out of the same predicate the creator uses. That shared predicate is
 * the whole gate — a capability that adds an arbitrary `d1` secret tomorrow is named by the warning
 * without anyone remembering to add it to a list.
 */
describe("what pithy provision declares and cannot create", () => {
  test.each(REGISTRIES)(
    "%s: the names provision defers are exactly the ones secrets provision creates",
    async (_, registry) => {
      const deferred = managerMintedSecrets(registry);
      const dispatched: SecretWriteRequest[] = [];
      await mintDeclaredSecrets({
        registry,
        dispatcher: { dispatch: async (request) => void dispatched.push(request) },
        probe: { probe: async () => false },
        environments: ["staging", "prod"],
      });

      expect(deferred).toEqual([...new Set(dispatched.map((request) => request.name))].sort());
    },
  );

  /**
   * The gate cannot pass by there being nothing to defer. As the kit ships, a project composing auth and
   * email has two secrets `pithy provision` will not create — so the warning fires on a real project
   * rather than being a branch nothing enters.
   */
  test("the kit as shipped gives provision something to warn about", () => {
    expect(managerMintedSecrets(everyShippedSecret()).length).toBeGreaterThan(0);
  });
});
