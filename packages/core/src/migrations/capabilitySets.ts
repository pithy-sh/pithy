// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MigrationProvider } from "kysely/migration";
import type { Capability } from "../capability/capability";
import type { DatabaseSpec } from "../data/databases";
import { InternalError } from "../error/pithyError";
import { createMigrationRegistry, type NamespacedMigrations } from "./registry";

/**
 * **Where a capability's migrations become a registry's sets — one function, composed twice (#729).**
 *
 * `pithy migrate` and `pithy doctor` compose these sets from the project on disk; the Worker composes them
 * from the capabilities it was built with, to answer `GET {basePath}/migrations`. It lived in the CLI until
 * the Worker needed it too. It reads nothing but `Capability.databases`, so it belongs in core — and if
 * the two sides composed with two functions, `pithy doctor` and the route could disagree about one
 * environment with nothing to say which was wrong.
 */

/**
 * A retained declaration must name a table this slice declares, beside the migrations that create it.
 *
 * A misspelled key would count a table that does not exist, find no rows, and let the `down` through —
 * the refusal quietly off for the one table it was written for. And retention on a slice with no
 * migrations has no `down` to be recorded on, so nothing would ever enforce it. Both are an author's mistake,
 * caught where the declaration is read rather than discovered when a vault is empty (#588).
 */
function assertRetainedDeclared(capability: string, database: string, spec: DatabaseSpec): void {
  const retained = spec.retained ?? [];
  if (retained.length === 0) return;
  const unknown = retained.filter((table) => !(table in spec.tables));
  if (unknown.length > 0) {
    throw new InternalError({
      message: `Capability "${capability}" retains ${unknown.map((table) => `"${table}"`).join(", ")} in database "${database}", which its tables do not declare.`,
      action: "Name tables from that database spec's tables in retained.",
    });
  }
  if (!spec.migrations || Object.keys(spec.migrations).length === 0) {
    throw new InternalError({
      message: `Capability "${capability}" retains tables in database "${database}" but ships no migrations for it.`,
      action: "Declare retained beside the migrations that create those tables.",
    });
  }
}

/**
 * Every capability's per-database migration set (`DatabaseSpec.migrations`, namespaced by capability
 * name), in composition order — the raw material {@link buildRegistryFromCapabilities}, the CLI's
 * fan-out runner and the control-plane seam all build on. The runner needs the sets rather than a
 * finished provider because two Workers can be bound to one physical D1: their sets merge into a single
 * ordered provider so that database migrates once, with every Worker's capabilities in it. A Worker
 * composes only its own, which is why the seam's `undeclared` is relative to that Worker. Migrations
 * without a `migrationOrder` fail here, attributed to their capability.
 */
export function collectMigrationSets(capabilities: Capability[]): NamespacedMigrations[] {
  const sets: NamespacedMigrations[] = [];
  for (const capability of capabilities) {
    for (const [database, spec] of Object.entries(capability.databases ?? {})) {
      assertRetainedDeclared(capability.name, database, spec);
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
        ...(spec.retained && spec.retained.length > 0 ? { retained: spec.retained } : {}),
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
