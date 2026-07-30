// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { Migration, MigrationProvider } from "kysely/migration";
import { describe, expect, test } from "vitest";
import { buildRegistryFromCapabilities } from "./registry";

const noop: Migration = { up: async () => {}, down: async () => {} };

/** The provider for a database name, asserting it was registered. */
function providerFor(registry: Record<string, MigrationProvider>, database: string): MigrationProvider {
  const provider = registry[database];
  if (!provider) throw new Error(`expected a provider for database "${database}"`);
  return provider;
}

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
