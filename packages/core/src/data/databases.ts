// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import type { z } from "zod";
import type { Capability } from "../capability/capability";
import { type BindingGroup, bindingGroupsFrom, composeBindingGroups } from "../capability/compose";
import { createDatabase, type DatabaseSchema, type SchemaMap } from "./db";

/**
 * One named D1 database a capability contributes tables to: the `binding` it lives in plus this
 * capability's slice of its schema. A production Worker commonly binds several D1 databases (app
 * data, analytics, …); each is a named database here, and `createBackend` serves one typed `Kysely`
 * per name on `c.var.db.<name>`. Capabilities targeting the same database name merge their slices.
 */
export interface DatabaseSpec<Tables extends SchemaMap = SchemaMap> {
  /** The D1 binding name in the Worker env this database lives in. */
  binding: string;
  /** This capability's slice of the database's schema (table name → Zod table schema). */
  tables: Tables;
  /**
   * This capability's migrations for this database, by stable local key (e.g. "0001_init") —
   * co-located with the tables they create, so the database association is declared once. The
   * migration namespace is the capability's name; `pithy migrate` composes every capability's
   * sets through `createMigrationRegistry` and runs them per database.
   */
  migrations?: Record<string, Migration>;
  /** Sort order within this database relative to other capabilities (core low, app high). Required with `migrations`. */
  migrationOrder?: number;
}

/** A capability's databases: database name → {@link DatabaseSpec}. */
export type DatabaseSpecMap = Record<string, DatabaseSpec>;

/**
 * The typed database registry exposed on `c.var.db`: each named database becomes its live `Kysely`
 * over that database's merged schema — so `c.var.db.app.selectFrom("…")` and
 * `c.var.db.analytics.selectFrom("…")` are each typed to their own tables.
 */
export type DbRegistry<Dbs extends DatabaseSpecMap> = {
  [Name in keyof Dbs]: Dbs[Name] extends DatabaseSpec<infer Tables> ? Kysely<DatabaseSchema<Tables>> : never;
};

/** The merged databases: each database name → its binding and the union of every capability's tables. */
export type MergedDatabases = Record<string, BindingGroup<z.ZodType>>;

/**
 * Merge every capability's `databases` into one map keyed by database name. Capabilities targeting
 * the same name union their table slices (the project-wide schema, per database); a table claimed
 * twice in one database, or a database name bound to two bindings, throws at assembly.
 */
export function composeDatabases(capabilities: Capability[]): MergedDatabases {
  return composeBindingGroups<z.ZodType>(
    capabilities,
    (cap) => bindingGroupsFrom(cap.databases, (db) => db.tables),
    "database",
    "table",
  );
}

/** A registry of live Kysely instances keyed by database name; the per-request value of `c.var.db`. */
type LiveDbRegistry = Record<string, Kysely<DatabaseSchema<SchemaMap>>>;

/**
 * Build the per-request database registry from the merged databases and the request's env. Each
 * `Kysely` is constructed lazily on first access from its D1 binding — a request that never touches
 * `c.var.db.analytics` never builds it.
 */
export function buildDbRegistry(env: Record<string, unknown>, databases: MergedDatabases): LiveDbRegistry {
  const registry: LiveDbRegistry = {};
  for (const [name, group] of Object.entries(databases)) {
    let instance: Kysely<DatabaseSchema<SchemaMap>> | undefined;
    Object.defineProperty(registry, name, {
      enumerable: true,
      get(): Kysely<DatabaseSchema<SchemaMap>> {
        if (!instance) instance = createDatabase(env[group.binding] as D1Database, group.items);
        return instance;
      },
    });
  }
  return registry;
}
