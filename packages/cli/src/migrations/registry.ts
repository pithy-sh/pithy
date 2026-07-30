// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry, type NamespacedMigrations } from "@pithy-sh/core/src/migrations/registry";
import type { MigrationProvider } from "kysely/migration";

/**
 * Every capability's per-database migration set (`DatabaseSpec.migrations`, namespaced by capability
 * name), in composition order — the raw material both {@link buildRegistryFromCapabilities} and the
 * fan-out runner build on. The runner needs the sets rather than a finished provider because two
 * Workers can be bound to one physical D1: their sets merge into a single ordered provider so that
 * database migrates once, with every Worker's capabilities in it. Migrations without a
 * `migrationOrder` fail here, attributed to their capability.
 */
export function collectMigrationSets(capabilities: Capability[]): NamespacedMigrations[] {
  const sets: NamespacedMigrations[] = [];
  for (const capability of capabilities) {
    for (const [database, spec] of Object.entries(capability.databases ?? {})) {
      if (!spec.migrations) continue;
      if (spec.migrationOrder === undefined) {
        throw new InternalError({
          message: `Capability "${capability.name}" has migrations for database "${database}" but no migrationOrder.`,
          action: "Set migrationOrder on that database spec (core low, app high).",
        });
      }
      sets.push({
        database,
        namespace: capability.name,
        order: spec.migrationOrder,
        migrations: spec.migrations,
      });
    }
  }
  return sets;
}

/**
 * Compose every capability's per-database migration sets (`DatabaseSpec.migrations`,
 * namespaced by capability name) into one ordered provider per database. A database
 * nobody migrates gets no provider; migrations without a `migrationOrder` fail here,
 * attributed to their capability.
 */
export function buildRegistryFromCapabilities(capabilities: Capability[]): Record<string, MigrationProvider> {
  return createMigrationRegistry(collectMigrationSets(capabilities));
}
