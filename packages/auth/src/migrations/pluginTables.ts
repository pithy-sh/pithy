// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { getSchema } from "better-auth/db";
import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { KIT_SESSION_FIELDS, KIT_USER_FIELDS } from "../data/kitFields";
import { authTables } from "../data/tables";
import { kitPlugins } from "../instance/plugins";

/**
 * Deriving an adopter's Better Auth plugin tables, and creating them through `pithy migrate`.
 *
 * The kit's migration model is per-capability sets composed by `pithy migrate`, and until now there was
 * no path for tables an **adopter** introduced through a capability's plugin. This is that path, and it
 * works because the plugin list is in `pithy.config.ts` — the same file the CLI already imports to
 * collect capabilities. The auth capability reads its own config, asks Better Auth what schema those
 * plugins imply, and contributes one ordinary Kysely migration per plugin. Nothing new was added to the
 * migration model; the capability simply declares more of it.
 *
 * **The diff is against a baseline, not against nothing.** `getSchema` answers with the *whole* schema
 * for a set of options, so the same call is made twice — once with only the kit's own plugins, once
 * with the kit's own plus one adopter plugin — and the difference is what that plugin brought. That is
 * what keeps the derived migration from re-creating `pithy_auth_users` on every project.
 *
 * **A plugin brings two kinds of change and both matter.** `organization` adds three tables *and* an
 * `activeOrganizationId` column to the session table the kit already owns; a create-table-only reading
 * ships a schema where `setActive` fails on the first call. Both halves are derived here.
 */

/**
 * The Better Auth options that shape the schema, and only those. Model names, the session's extra
 * fields, and the rate-limit table are all read by `getSchema`, so the baseline it computes has to
 * carry the same ones `makeAuth` passes or the diff would report the kit's own tables as new.
 *
 * Kept beside `makeAuth` rather than inside it because the migration is built at `auth(config)` time,
 * where the request-scoped deps (database, secret, base URL) do not exist yet — and none of them
 * changes a column.
 */
export function authSchemaOptions(plugins: readonly BetterAuthPlugin[]): BetterAuthOptions {
  return {
    // The kit's own extra columns, from the one module that declares them. The baseline is what each
    // plugin's schema is *subtracted from*, so a kit column missing here is reported as something the
    // plugin brought — see `../data/kitFields.ts` for what that costs on a database with no
    // transactional DDL.
    user: { modelName: "pithyAuthUsers", additionalFields: KIT_USER_FIELDS },
    session: { modelName: "pithyAuthSessions", additionalFields: KIT_SESSION_FIELDS },
    account: { modelName: "pithyAuthAccounts" },
    verification: { modelName: "pithyAuthVerifications" },
    rateLimit: { enabled: true, storage: "database", modelName: "pithyAuthRateLimit" },
    plugins: [
      // The kit's own four, from the one definition the live instance also composes. The callbacks are
      // never invoked here — a schema is a shape, and `getSchema` reads `plugin.schema`, not behavior.
      ...kitPlugins({
        verificationExpiresIn: 300,
        otpLength: 6,
        disableSignUp: false,
        sendEmail: async () => undefined,
      }),
      ...plugins,
    ],
  };
}

/** SQLite storage for one Better Auth field type — the same two the kit's own tables use. */
export type PluginColumnType = "text" | "integer";

/** One column of a table a plugin introduced. */
export interface PluginTableColumn {
  /** The camelCase column name; `CamelCasePlugin` snake-cases it in the emitted DDL. */
  name: string;
  /** Its SQLite storage. */
  type: PluginColumnType;
  /** Whether the column is `NOT NULL`. */
  notNull: boolean;
  /** Whether this is the table's `id` primary key. */
  primaryKey: boolean;
  /** Whether the column carries a `UNIQUE` constraint. */
  unique: boolean;
  /** Whether the plugin asked for an index on it. */
  index: boolean;
}

/** A whole table a plugin introduced. */
export interface PluginTable {
  /** The camelCase model name; `CamelCasePlugin` snake-cases it. */
  name: string;
  /** Its columns, `id` first. */
  columns: PluginTableColumn[];
}

/** A column a plugin added to a table that already existed — the kit's own, or an earlier plugin's. */
export interface PluginColumn {
  /** The table the column is added to. */
  table: string;
  /** The camelCase column name. */
  name: string;
  /** Its SQLite storage. */
  type: PluginColumnType;
  /** Always `false` — see {@link pluginSchemaDelta}. */
  notNull: boolean;
  /** Whether the plugin asked for an index on it. */
  index: boolean;
}

/** Everything one plugin adds to the schema: whole tables, and columns on tables that already exist. */
export interface PluginSchemaDelta {
  tables: PluginTable[];
  columns: PluginColumn[];
}

/** The field-attribute subset `getSchema` reports that a column plan is built from. */
interface SchemaField {
  type: unknown;
  required?: boolean;
  unique?: boolean;
  index?: boolean;
}

/**
 * Map a Better Auth field type to SQLite storage.
 *
 * `date` is **text**, not SQLite's `date` affinity: Better Auth stores ISO-8601 strings on SQLite, ISO
 * sorts chronologically, and `0001_init` already declares every Better-Auth date column that way. A
 * list type (`string[]`, `number[]`) and a literal-union type are both JSON/text on SQLite, which is
 * what Better Auth's own generator does. Anything else is a `boolean`/`number`/`string` — the two
 * numeric-ish ones are `integer`, everything else `text`.
 */
function columnType(type: unknown): PluginColumnType {
  return type === "boolean" || type === "number" ? "integer" : "text";
}

/** The kit's own tables — the six Better Auth manages plus `devices` and `rotated_tokens`. */
const KIT_TABLE_NAMES: readonly string[] = Object.keys(authTables);

/**
 * What one plugin adds to the auth schema, as a plan a migration can be built from.
 *
 * **Every added column is nullable, deliberately.** SQLite refuses `ALTER TABLE … ADD COLUMN … NOT NULL`
 * without a constant default, and the table it is being added to is a live one that already has rows —
 * so a plugin's `required` on a *new* column of an *existing* table cannot be honored by any migration,
 * whatever it claims. Better Auth writes the value on every insert it makes, so the constraint is
 * enforced where the plugin enforces it; the column simply does not also declare it. A column of a table
 * the plugin creates itself is `NOT NULL` normally — there are no rows to contradict it.
 */
export function pluginSchemaDelta(plugin: BetterAuthPlugin): PluginSchemaDelta {
  const baseline = getSchema(authSchemaOptions([]));
  const extended = getSchema(authSchemaOptions([plugin]));

  const tables: PluginTable[] = [];
  const columns: PluginColumn[] = [];

  for (const [model, spec] of Object.entries(extended)) {
    const before = baseline[model];
    const fields = Object.entries(spec.fields as Record<string, SchemaField>);

    if (!before) {
      tables.push({
        name: model,
        columns: [
          { name: "id", type: "text", notNull: true, primaryKey: true, unique: false, index: false },
          ...fields.map(([name, field]) => ({
            name,
            type: columnType(field.type),
            notNull: field.required !== false,
            primaryKey: false,
            unique: field.unique === true,
            index: field.index === true,
          })),
        ],
      });
      continue;
    }

    for (const [name, field] of fields) {
      if (before.fields[name]) continue;
      columns.push({
        table: model,
        name,
        type: columnType(field.type),
        notNull: false,
        index: field.index === true || field.unique === true,
      });
    }
  }

  return { tables, columns };
}

/** The index name for a column, in the camelCase the `0001_init` indexes are declared in. */
function indexName(table: string, column: string): string {
  return `${table}${column.charAt(0).toUpperCase()}${column.slice(1)}Idx`;
}

/**
 * Build the Kysely migration for one plugin's delta. `down` is the exact inverse, and it runs the
 * indexes off first: SQLite refuses to drop an indexed column.
 */
export function pluginMigration(delta: PluginSchemaDelta): Migration {
  return {
    up: async (db: Kysely<unknown>): Promise<void> => {
      for (const table of delta.tables) {
        let builder = db.schema.createTable(table.name);
        for (const column of table.columns) {
          builder = builder.addColumn(column.name, column.type, (c) => {
            let built = column.primaryKey ? c.primaryKey() : c;
            if (column.notNull && !column.primaryKey) built = built.notNull();
            if (column.unique) built = built.unique();
            return built;
          });
        }
        await builder.execute();
      }
      for (const column of delta.columns) {
        await db.schema
          .alterTable(column.table)
          .addColumn(column.name, column.type, (c) => c)
          .execute();
      }
      // Indexes last, in one pass over both halves — an index is only ever an addition, so nothing
      // reads it before the DDL that created its column has run.
      for (const table of delta.tables) {
        for (const column of table.columns) {
          if (!column.index) continue;
          await db.schema.createIndex(indexName(table.name, column.name)).on(table.name).column(column.name).execute();
        }
      }
      for (const column of delta.columns) {
        if (!column.index) continue;
        await db.schema
          .createIndex(indexName(column.table, column.name))
          .on(column.table)
          .column(column.name)
          .execute();
      }
    },

    down: async (db: Kysely<unknown>): Promise<void> => {
      for (const column of delta.columns) {
        if (column.index) await db.schema.dropIndex(indexName(column.table, column.name)).execute();
      }
      for (const column of delta.columns) {
        await db.schema.alterTable(column.table).dropColumn(column.name).execute();
      }
      // The tables go last and in reverse, so a plugin that created several drops them newest first.
      for (const table of [...delta.tables].reverse()) {
        await db.schema.dropTable(table.name).execute();
      }
    },
  };
}

/**
 * The migration key for a plugin, e.g. `two-factor` → `0002_plugin_two_factor`.
 *
 * `0002` for every plugin, and that is not laziness. The four-digit lead is what
 * `createMigrationRegistry` demands of a local key; within the auth namespace these all sort after
 * `0001_init` and among themselves by plugin id, and **the order between two plugins is arbitrary by
 * construction** — no plugin's tables reference another's, since each is derived against the same
 * baseline. Numbering them `0002`, `0003`, … in config order would make the key of an already-applied
 * migration change the moment a plugin was inserted before it, which is the one thing a ledger cannot
 * survive.
 */
export function pluginMigrationKey(id: string): string {
  return `0002_plugin_${id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

/** What an adopter's plugin list contributes to the auth capability, derived once. */
export interface AuthPluginPlan {
  /** One migration per plugin that declares a schema, keyed by {@link pluginMigrationKey}. */
  migrations: Record<string, Migration>;
  /** One entry per plugin, whatever it declared — what `pithy doctor` reports. */
  extensions: { id: string; tables: string[] }[];
}

/**
 * Derive everything the auth capability needs from an adopter's plugin list, in one pass.
 *
 * Migrations: one per plugin that has a schema, keyed by {@link pluginMigrationKey}. A plugin that adds
 * no tables and no columns gets no migration and no ledger row — a plugin that is only endpoints has
 * nothing to create. Extensions: one per plugin regardless, because a plugin with no tables still adds
 * routes and still must not be invisible.
 *
 * Two plugins that claim the same table, or a plugin that claims one of the kit's own, are refused
 * here rather than at `pithy migrate`: the second `createTable` would fail mid-run against a database
 * that has no transactional DDL, leaving the first plugin's tables half-created. Naming both plugins
 * and the table is the whole remedy — one of them takes a `schema: { … modelName }` override.
 */
export function authPluginPlan(plugins: readonly BetterAuthPlugin[]): AuthPluginPlan {
  const migrations: Record<string, Migration> = {};
  const extensions: { id: string; tables: string[] }[] = [];
  const claimed = new Map<string, string>();

  for (const plugin of plugins) {
    const delta = pluginSchemaDelta(plugin);
    extensions.push({ id: plugin.id, tables: delta.tables.map((table) => table.name) });
    for (const table of delta.tables) {
      if (KIT_TABLE_NAMES.includes(table.name)) {
        throw new ValidationError({
          message: `The Better Auth "${plugin.id}" plugin declares a table the auth capability already owns: ${table.name}.`,
          action: `Give it another name through the plugin's own \`schema: { … modelName }\` option — ${table.name} is created by the auth capability's 0001_init.`,
          detail: `plugin "${plugin.id}" collides with kit table "${table.name}"`,
        });
      }
      const owner = claimed.get(table.name);
      if (owner) {
        throw new ValidationError({
          message: `The Better Auth "${plugin.id}" and "${owner}" plugins both declare a ${table.name} table.`,
          action: `Give one of them another name through its \`schema: { ${table.name}: { modelName: "…" } }\` option.`,
          detail: `plugins "${owner}" and "${plugin.id}" both claim table "${table.name}"`,
        });
      }
      claimed.set(table.name, plugin.id);
    }

    if (delta.tables.length === 0 && delta.columns.length === 0) continue;
    const key = pluginMigrationKey(plugin.id);
    if (migrations[key]) {
      throw new ValidationError({
        message: `Two Better Auth plugins reduce to the same migration key: ${key}.`,
        action: `Two plugin ids that differ only in punctuation cannot both be composed — rename one, or compose only one of them.`,
        detail: `plugin "${plugin.id}" collides on migration key "${key}"`,
      });
    }
    migrations[key] = pluginMigration(delta);
  }

  return { migrations, extensions };
}
