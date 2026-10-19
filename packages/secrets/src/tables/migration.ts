// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName } from "@pithy-sh/core/src/cli/command";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";
import { z } from "zod";
import { SecretTableRegistration } from "../data/secretTables";
import { isSecretTableKeyName, isSecretTableName, secretTableIdentifier } from "./defineSecretTable";

/**
 * The migration `pithy migrate` writes for a declared secret table — the initial table, and every alter
 * after it — as one ordinary Kysely `Migration` built from two plans: the shape before, and the shape after.
 *
 * **The declaration is the shape, so the migration is derived from it rather than transcribed.** The at-rest
 * rotation depends on `encryptedValue`, `iv` and `keyVersion`, and a hand-written table that omits or renames
 * one is a table that silently never rotates; generating it makes the column set correct by construction.
 *
 * **The plan rides on the migration.** `secretTable` is plain data beside `up` and `down`, which Kysely
 * ignores and the next `pithy migrate` reads: folding the chain's plans is how it knows what the applied
 * chain already says, without parsing a file or asking a database. A file is still an ordinary migration —
 * nothing about it is special once written, and it is reviewed and committed like any other.
 *
 * **Additive only.** A key column is added and never dropped by a generated migration, because a column
 * holding somebody's key is data, and a migration that drops one is a loss the adopter authors on purpose.
 * {@link secretTableMigration} refuses a plan that would, naming the key.
 */

/** One declared table's shape at one point in its migration chain. */
export const SecretTablePlan = z
  .object({
    table: z.string().describe("The declared table's name — `customer` for `pithy_secrets_customer_secrets`."),
    keys: z
      .array(z.string().describe("One owner key column, camelCase."))
      .describe("The owner key columns, in the order they were added."),
    secrets: z.array(z.string().describe("One declared secret name.")).describe("The declared secret names."),
  })
  .describe("A declared secret table's shape at one point in its migration chain.");
export type SecretTablePlan = z.output<typeof SecretTablePlan>;

/** One step of a declared table's chain: the shape it starts from (`null` for the first) and the one it leaves. */
export const SecretTableStep = z
  .object({
    from: SecretTablePlan.nullable().describe("The shape before this migration, or `null` when it creates the table."),
    to: SecretTablePlan.describe("The shape after it."),
  })
  .describe("One generated migration's plan: the shape it starts from and the shape it leaves.");
export type SecretTableStep = z.output<typeof SecretTableStep>;

/** A generated migration: an ordinary Kysely `Migration`, with the step it applies beside `up` and `down`. */
export interface SecretTableMigration extends Migration {
  /** The step this migration applies — what the next `pithy migrate` folds into the applied shape. */
  readonly secretTable: SecretTableStep;
}

/** Whether a migration carries a declared table's step. */
export function isSecretTableMigration(migration: Migration): migration is SecretTableMigration {
  return SecretTableStep.safeParse((migration as { secretTable?: unknown }).secretTable).success;
}

/** The camelCase index identifiers, which `CamelCasePlugin` snake-cases beside the table's own name. */
function ownerIndex(identifier: string): string {
  return `${identifier}OwnerIdx`;
}
function keyIndex(identifier: string, key: string): string {
  return `${identifier}${key.charAt(0).toUpperCase()}${key.slice(1)}Idx`;
}

/** The author error a plan that cannot be migrated raises. Generated plans never do; a hand edit might. */
function refuse(reason: string): InternalError {
  return new InternalError({
    message: `secret table migration: ${reason}`,
    action: `Change the declaration and let ${commandName("migrate")} write the next migration, or write this change by hand.`,
  });
}

/** Hold a plan to the rules its declaration was held to, so a hand-edited file is refused at load. */
function checked(plan: SecretTablePlan): SecretTablePlan {
  const parsed = SecretTablePlan.parse(plan);
  if (!isSecretTableName(parsed.table)) throw refuse(`"${parsed.table}" is not a legal table name.`);
  if (parsed.keys.length === 0) throw refuse(`table "${parsed.table}" has no keys.`);
  for (const key of parsed.keys) {
    if (!isSecretTableKeyName(key)) throw refuse(`table "${parsed.table}": "${key}" is not a legal key column.`);
  }
  if (new Set(parsed.keys).size !== parsed.keys.length) throw refuse(`table "${parsed.table}" repeats a key.`);
  return parsed;
}

/** The registry row this plan writes, encoded through the table's own codec. */
function registrationRow(plan: SecretTablePlan, now: Date) {
  return SecretTableRegistration.encode({
    name: plan.table,
    keys: plan.keys,
    secrets: plan.secrets,
    createdAt: now,
    updatedAt: now,
  });
}

/** The registry table, as this migration writes it. */
type RegistryDb = { pithySecretsTables: z.input<typeof SecretTableRegistration> };

/** Create the table, its owner index and an index per key — the whole of a first migration's DDL. */
async function createTable(db: Kysely<unknown>, plan: SecretTablePlan): Promise<void> {
  const identifier = secretTableIdentifier(plan.table);
  let create = db.schema
    .createTable(identifier)
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("encryptedValue", "text", (c) => c.notNull())
    .addColumn("iv", "text", (c) => c.notNull())
    .addColumn("keyVersion", "integer", (c) => c.notNull())
    .addColumn("valueType", "text", (c) => c.notNull().defaultTo("text"))
    .addColumn("createdAt", "integer", (c) => c.notNull())
    .addColumn("updatedAt", "integer", (c) => c.notNull());
  for (const key of plan.keys) create = create.addColumn(key, "text", (c) => c.notNull());
  await create.execute();
  await createOwnerIndex(db, identifier, plan.keys);
  for (const key of plan.keys) {
    await db.schema.createIndex(keyIndex(identifier, key)).on(identifier).column(key).execute();
  }
}

/** The unique owner index: every key, then the name — one row per secret per owner. */
async function createOwnerIndex(db: Kysely<unknown>, identifier: string, keys: readonly string[]): Promise<void> {
  await db.schema
    .createIndex(ownerIndex(identifier))
    .on(identifier)
    .columns([...keys, "name"])
    .unique()
    .execute();
}

/**
 * Build the migration for one step of a declared table's chain.
 *
 * A first step creates the table and registers it; `down` unregisters it and drops it. A later step adds each
 * new key column as `text not null default ''` — the empty string is what every existing row holds there, and
 * an empty key is left out of a row's bound context, so no stored ciphertext changes — rebuilds the owner
 * index over every key, indexes the new key, and rewrites the registration. Its `down` is the inverse, index
 * for index, and it refuses while any row holds a value in a key it would drop.
 */
export function secretTableMigration(step: SecretTableStep): SecretTableMigration {
  const to = checked(step.to);
  const from = step.from === null ? null : checked(step.from);
  if (from !== null) {
    if (from.table !== to.table) throw refuse("a step migrates one table, and this one names two.");
    for (const [index, key] of from.keys.entries()) {
      if (to.keys[index] !== key) {
        throw refuse(
          `table "${to.table}": key "${key}" is removed or moved, and a generated migration never drops a key column.`,
        );
      }
    }
  }
  const identifier = secretTableIdentifier(to.table);
  const added = from === null ? [] : to.keys.slice(from.keys.length);

  return {
    secretTable: { from, to },
    up: async (db: Kysely<unknown>): Promise<void> => {
      const registry = db.withTables<RegistryDb>();
      if (from === null) {
        await createTable(db, to);
        await registry.insertInto("pithySecretsTables").values(registrationRow(to, new Date())).execute();
        return;
      }
      for (const key of added) {
        await db.schema
          .alterTable(identifier)
          .addColumn(key, "text", (c) => c.notNull().defaultTo(""))
          .execute();
      }
      if (added.length > 0) {
        await db.schema.dropIndex(ownerIndex(identifier)).execute();
        await createOwnerIndex(db, identifier, to.keys);
        for (const key of added) {
          await db.schema.createIndex(keyIndex(identifier, key)).on(identifier).column(key).execute();
        }
      }
      const { keys, secrets, updatedAt } = registrationRow(to, new Date());
      await registry
        .updateTable("pithySecretsTables")
        .set({ keys, secrets, updatedAt })
        .where("name", "=", to.table)
        .execute();
    },
    down: async (db: Kysely<unknown>): Promise<void> => {
      const registry = db.withTables<RegistryDb>();
      if (from === null) {
        await registry.deleteFrom("pithySecretsTables").where("name", "=", to.table).execute();
        // The inverse of the `up`, index for index — SQLite takes them with the table, and a `down` that
        // reads as the reverse of its `up` is one a reader can check against it.
        for (const key of [...to.keys].reverse()) {
          await db.schema.dropIndex(keyIndex(identifier, key)).ifExists().execute();
        }
        await db.schema.dropIndex(ownerIndex(identifier)).ifExists().execute();
        await db.schema.dropTable(identifier).execute();
        return;
      }
      // Refused before anything changes, while any row holds a value in a key this would drop. That row's
      // ciphertext is bound to the value (`secretTableContext`), so the narrower table could never open it;
      // and beside a legacy row for the same owner and name it would break the rebuilt unique owner index
      // halfway through. Emptying those rows first is the adopter's call, made on purpose.
      for (const key of added) {
        const held = await db
          .withTables<Record<string, Record<string, string>>>()
          .selectFrom(identifier)
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where(key, "!=", "")
          .executeTakeFirstOrThrow();
        const count = Number(held.count);
        if (count > 0) {
          throw new InternalError({
            message: `secret table migration: rolling back table "${to.table}" would drop key "${key}", and ${count} row${count === 1 ? " holds" : "s hold"} a value in it.`,
            action: `Delete or move those rows before rolling back, or keep the key and write a forward migration instead.`,
          });
        }
      }
      const { keys, secrets, updatedAt } = registrationRow(from, new Date());
      await registry
        .updateTable("pithySecretsTables")
        .set({ keys, secrets, updatedAt })
        .where("name", "=", to.table)
        .execute();
      if (added.length === 0) return;
      for (const key of [...added].reverse()) await db.schema.dropIndex(keyIndex(identifier, key)).execute();
      await db.schema.dropIndex(ownerIndex(identifier)).execute();
      await createOwnerIndex(db, identifier, from.keys);
      for (const key of [...added].reverse()) await db.schema.alterTable(identifier).dropColumn(key).execute();
    },
  };
}
