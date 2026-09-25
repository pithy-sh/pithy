// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { managerCfApiTokenSecretName, masterKeySecretName } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import {
  classifyStoreEntry,
  MASTER_KEY_ENTRY_SUFFIX,
  type StoreEntryCensusInput,
  storeEntryCensus,
} from "./storeEntryCensus";

/**
 * The census answers one question — *does this project compose that name?* — and the cost of the two
 * possible mistakes is wildly asymmetric. A missed orphan costs another run of the command. A false one
 * is a live Secrets Store entry printed under a heading an operator deletes from, and one of the names
 * in reach makes an environment's whole D1 permanently undecryptable.
 *
 * So every case below is paired: the name that is accounted for beside the name that is not, the
 * complete census beside the withheld one.
 */

const ENVIRONMENTS: ManagedEnvironment[] = ["staging", "prod"];

const registry = defineSecretRegistry({
  "auth-session-secret": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
  "email-link-signing-key": { backend: "cf-secrets-store", scope: "environment", rotatable: true, valueType: "text" },
  "stripe-live-key": { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
  SECRETS_ENCRYPTION_KEYS: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "text",
    bootstrap: true,
  },
});

function census(overrides: Partial<StoreEntryCensusInput> = {}) {
  return storeEntryCensus({
    project: "acme",
    environments: ENVIRONMENTS,
    registry,
    registryComplete: true,
    tokenEntries: [],
    ...overrides,
  });
}

describe("the accounted set", () => {
  test("an environment-scoped store secret contributes one name per declared environment", () => {
    const { accounted } = census();

    // Composed through the same function provisioning calls, so the assertion cannot drift from it.
    for (const env of ENVIRONMENTS) {
      const entry = environmentScope("acme", env).secretEntry("email-link-signing-key", "environment");
      expect(accounted.has(entry)).toBe(true);
    }
  });

  test("a global store secret contributes exactly one name, with the literal `global` in the environment slot", () => {
    const { accounted } = census();

    expect(accounted.has("acme-global-stripe-live-key")).toBe(true);
    expect(accounted.has("acme-prod-stripe-live-key")).toBe(false);
    expect(accounted.has("acme-staging-stripe-live-key")).toBe(false);
  });

  test("a d1 secret contributes no store entry at all", () => {
    // Its value is a row in the manager's database. A name here would be an entry nothing ever writes,
    // which is a false *absence* rather than a false orphan — but still a wrong answer.
    const { accounted } = census();

    expect([...accounted].some((name) => name.includes("auth-session-secret"))).toBe(false);
  });

  test("each environment's master key and the manager's token are accounted without being restated", () => {
    const { accounted } = census();

    for (const env of ENVIRONMENTS) expect(accounted.has(masterKeySecretName("acme", env))).toBe(true);
    expect(accounted.has(managerCfApiTokenSecretName("acme"))).toBe(true);
  });

  test("token store entries handed in are accounted for", () => {
    const { accounted } = census({ tokenEntries: ["acme-prod-cf-token-ci-system"] });

    expect(accounted.has("acme-prod-cf-token-ci-system")).toBe(true);
    expect(census().accounted.has("acme-prod-cf-token-ci-system")).toBe(false);
  });

  test("MASTER_KEY_ENTRY_SUFFIX is the tail a composed master-key name actually carries", () => {
    // The classification recognizes key material in an environment this checkout does not declare, so
    // it cannot compose the name to compare against. This is what keeps the constant honest.
    expect(masterKeySecretName("acme", "prod").endsWith(MASTER_KEY_ENTRY_SUFFIX)).toBe(true);
  });
});

describe("classifyStoreEntry", () => {
  test("a composed name is accounted", () => {
    expect(classifyStoreEntry("acme-prod-secrets-encryption-keys", census())).toBe("accounted");
  });

  test("a bare master-key binding beside it is unscoped — the headline case", () => {
    // The #647 fingerprint: the value that should have reached `acme-prod-secrets-encryption-keys` sat
    // under `SECRETS_ENCRYPTION_KEYS`, which nothing binds and nothing reads.
    expect(classifyStoreEntry("SECRETS_ENCRYPTION_KEYS", census())).toBe("unscoped");
  });

  test("a bare registry key and its derived binding are both unscoped", () => {
    expect(classifyStoreEntry("email-link-signing-key", census())).toBe("unscoped");
    expect(classifyStoreEntry("EMAIL_LINK_SIGNING_KEY", census())).toBe("unscoped");
  });

  test("a scoped name nothing composes is an orphan", () => {
    expect(classifyStoreEntry("acme-prod-leftover", census())).toBe("orphan");
  });

  test("a feature's entry is a feature's, not an orphan", () => {
    expect(classifyStoreEntry("acme-f647-demo-db", census())).toBe("feature");
  });

  test("another project's entry is foreign", () => {
    expect(classifyStoreEntry("beta-prod-db", census())).toBe("foreign");
  });

  test("an environment this checkout does not declare is unknown-scope, never an orphan", () => {
    // `pithy.config.ts` differs between branches and checkouts. A branch predating `dev` must not report
    // every dev entry as dead.
    expect(classifyStoreEntry("acme-dev-leftover", census())).toBe("unknown-scope");
    // And the same name under a declared environment still is one, so this is not a blanket amnesty.
    expect(classifyStoreEntry("acme-prod-leftover", census())).toBe("orphan");
  });

  test("a master key nothing composes is key material, never an orphan", () => {
    // The entry whose deletion is unrecoverable. It gets its own class under every scope — declared,
    // undeclared, or a feature's.
    expect(classifyStoreEntry("acme-prod-legacy-secrets-encryption-keys", census())).toBe("key-material");
    expect(classifyStoreEntry("acme-dev-secrets-encryption-keys", census())).toBe("key-material");
  });

  test("a project whose name is a prefix of another's feature marker is still classified by segment", () => {
    // `acme-f1-prod-db` belongs to a second project literally named `acme-f1`. From `acme`'s side the
    // second segment is `f1`, which is a feature marker, so it reads as this project's feature. The
    // limitation is stated rather than silently wrong: a feature is never presented as debris either.
    expect(classifyStoreEntry("acme-f1-prod-db", census())).toBe("feature");
  });
});

describe("withholding", () => {
  test("a complete census withholds nothing", () => {
    expect(census().unresolved).toBeNull();
  });

  test("a registry that is not every Worker's withholds the orphan verdict, and says why", () => {
    const withheld = census({ registryComplete: false });

    expect(withheld.unresolved).toContain("registry could not be read");
  });

  test("token profiles that could not be resolved withhold it too", () => {
    expect(census({ tokenEntries: null }).unresolved).toContain("token profiles");
  });

  test("an unscoped name is still classified when the verdict is withheld", () => {
    // `ours` is built from the registry alone and does not depend on the accounted set being complete.
    // This is the one check that finds the #647 fingerprint, and a project whose census cannot be
    // completed is if anything more likely to be the one holding it.
    expect(classifyStoreEntry("SECRETS_ENCRYPTION_KEYS", census({ registryComplete: false }))).toBe("unscoped");
  });
});
