// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { environmentScope, featureScope } from "@pithy-sh/core/src/naming/provisionScope";
import { secrets } from "@pithy-sh/secrets/src/capability";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { secretsStoreBindings, workerSecretRegistry } from "./secretBindings";

/** A project registry beside the master key the capability merges in for itself. */
const registry: SecretRegistry = {
  CONNECTION_KEY_ENCRYPTION_KEY: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: true,
    valueType: "text",
  },
  RELEASE_INGEST_SECRET: { backend: "cf-secrets-store", scope: "global", rotatable: false, valueType: "text" },
  // A `d1` secret lives in the environment's secrets database, never in a binding.
  WEBHOOK_SIGNING_KEY: { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
  // A keyspace has no single value, so no single entry to bind.
  TENANT_CREDENTIALS: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "text",
    keyed: true,
  },
};

const all = async () => true;

describe("secretsStoreBindings", () => {
  test("binds every cf-secrets-store secret, and nothing else", async () => {
    const { bound } = await secretsStoreBindings({
      registry,
      scope: environmentScope("replay", "staging"),
      storeId: "store-1",
      exists: all,
    });

    expect(bound).toEqual([
      {
        binding: "CONNECTION_KEY_ENCRYPTION_KEY",
        store_id: "store-1",
        secret_name: "replay-staging-connection-key-encryption-key",
      },
      { binding: "RELEASE_INGEST_SECRET", store_id: "store-1", secret_name: "replay-global-release-ingest-secret" },
    ]);
  });

  /** The binding is the join key and never moves; only the entry behind it is scoped. */
  test("a feature binds its own entries under the same binding names", async () => {
    const { bound } = await secretsStoreBindings({
      registry,
      scope: featureScope({ project: "replay", issue: "239", slug: "secrets" }),
      storeId: "store-1",
      exists: all,
    });

    expect(bound.map((entry) => [entry.binding, entry.secret_name])).toEqual([
      ["CONNECTION_KEY_ENCRYPTION_KEY", "replay-f239-secrets-connection-key-encryption-key"],
      // `global` is one account-level value every environment binds — a feature binds it, not a copy.
      ["RELEASE_INGEST_SECRET", "replay-global-release-ingest-secret"],
    ]);
  });

  /**
   * Cloudflare rejects a deploy whose binding names an entry that is not in the store, so a declared
   * but unwritten secret must be reported rather than bound — otherwise one missing value fails the
   * whole Worker's deploy instead of one read.
   */
  test("reports a declared secret with no entry rather than binding it", async () => {
    const { bound, missing } = await secretsStoreBindings({
      registry,
      scope: environmentScope("replay", "staging"),
      storeId: "store-1",
      exists: async (name) => name === "replay-global-release-ingest-secret",
    });

    expect(bound.map((entry) => entry.binding)).toEqual(["RELEASE_INGEST_SECRET"]);
    expect(missing).toEqual(["CONNECTION_KEY_ENCRYPTION_KEY"]);
  });

  test("the master key the secrets capability merges in is one of them", async () => {
    const capability = secrets({ registry: {} });
    const found = workerSecretRegistry([capability]);
    expect(found).not.toBeNull();

    const { bound } = await secretsStoreBindings({
      registry: found as SecretRegistry,
      scope: environmentScope("replay", "prod"),
      storeId: "store-1",
      exists: all,
    });
    expect(bound).toEqual([
      {
        binding: "SECRETS_ENCRYPTION_KEYS",
        store_id: "store-1",
        secret_name: "replay-prod-secrets-encryption-keys",
      },
    ]);
  });

  test("a Worker composing no secrets capability has no registry and no bindings", () => {
    expect(workerSecretRegistry([])).toBeNull();
  });
});
