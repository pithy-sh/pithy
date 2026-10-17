// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Migration, MigrationProvider } from "kysely/migration";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import { PithyError } from "../error/pithyError";
import { buildRegistryFromCapabilities, collectMigrationSets } from "./capabilitySets";

const noop: Migration = { up: async () => {}, down: async () => {} };

/** A table schema, for the retained cases — the declaration only reads the keys. */
const Vault = z.object({ id: z.string().describe("The row id.") }).describe("A retained table.");

/** The provider for a database name, asserting it was registered. */
function providerFor(registry: Record<string, MigrationProvider>, database: string): MigrationProvider {
  const provider = registry[database];
  if (!provider) throw new Error(`expected a provider for database "${database}"`);
  return provider;
}

describe("collectMigrationSets", () => {
  test("one set per capability per database, namespaced by the capability's name", () => {
    const auth = defineCapability({
      name: "auth",
      requiredBindings: [],
      databases: { app: { binding: "DB", tables: {}, migrations: { "0001_init": noop }, migrationOrder: 300 } },
    });
    const sets = collectMigrationSets([auth]);
    expect(sets).toEqual([{ database: "app", namespace: "auth", order: 300, migrations: { "0001_init": noop } }]);
  });

  test("carries a retained declaration, and only a non-empty one", () => {
    const secrets = defineCapability({
      name: "secrets",
      requiredBindings: [],
      databases: {
        secrets: {
          binding: "SECRETS_DB",
          tables: { vault: Vault },
          migrations: { "0001_init": noop },
          migrationOrder: 400,
          retained: ["vault"],
        },
      },
    });
    expect(collectMigrationSets([secrets])[0]?.retained).toEqual(["vault"]);
  });

  test("refuses a retained table its database spec does not declare", () => {
    // A misspelled key would count a table that does not exist, find no rows, and let the `down` through.
    const secrets = defineCapability({
      name: "secrets",
      requiredBindings: [],
      databases: {
        secrets: {
          binding: "SECRETS_DB",
          tables: { vault: Vault },
          migrations: { "0001_init": noop },
          migrationOrder: 400,
          retained: ["valt"],
        },
      },
    });
    expect(() => collectMigrationSets([secrets])).toThrow(/"valt"/);
  });

  test("refuses retention on a database it ships no migrations for", () => {
    // Retention is recorded on a `down`, so a slice with none has nothing to record it on.
    const secrets = defineCapability({
      name: "secrets",
      requiredBindings: [],
      databases: { secrets: { binding: "SECRETS_DB", tables: { vault: Vault }, retained: ["vault"] } },
    });
    expect(() => collectMigrationSets([secrets])).toThrow(/ships no migrations/);
  });
});

describe("buildRegistryFromCapabilities", () => {
  test("no capabilities, no providers", () => {
    expect(buildRegistryFromCapabilities([])).toEqual({});
  });

  test("a database without migrations contributes no provider", () => {
    const cap = defineCapability({
      name: "app",
      requiredBindings: [],
      databases: { app: { binding: "DB", tables: {} } },
    });
    expect(buildRegistryFromCapabilities([cap])).toEqual({});
  });

  test("composes each capability's sets per database, namespaced by capability name", async () => {
    const auth = defineCapability({
      name: "auth",
      requiredBindings: [],
      databases: { app: { binding: "DB", tables: {}, migrations: { "0001_init": noop }, migrationOrder: 100 } },
    });
    const app = defineCapability({
      name: "app",
      requiredBindings: [],
      databases: {
        app: { binding: "DB", tables: {}, migrations: { "0001_init": noop }, migrationOrder: 1000 },
        analytics: { binding: "ANALYTICS", tables: {}, migrations: { "0001_events": noop }, migrationOrder: 0 },
      },
    });

    const registry = buildRegistryFromCapabilities([auth, app]);
    expect(Object.keys(registry).sort()).toEqual(["analytics", "app"]);
    expect(Object.keys(await providerFor(registry, "app").getMigrations())).toEqual([
      "0100_auth_0001_init",
      "1000_app_0001_init",
    ]);
    expect(Object.keys(await providerFor(registry, "analytics").getMigrations())).toEqual(["0000_app_0001_events"]);
  });

  test("migrations without a migrationOrder fail at assembly, naming the capability", () => {
    const cap = defineCapability({
      name: "auth",
      requiredBindings: [],
      databases: { app: { binding: "DB", tables: {}, migrations: { "0001_init": noop } } },
    });
    expect(() => buildRegistryFromCapabilities([cap])).toThrow(PithyError);
    expect(() => buildRegistryFromCapabilities([cap])).toThrow(/auth/);
  });
});
