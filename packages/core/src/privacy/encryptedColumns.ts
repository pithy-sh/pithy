// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { Capability } from "../capability/capability";
import { ValidationError } from "../error/pithyError";
import {
  BlindIndexNormalizerName,
  encryptedLayout,
  encryptedSpecOf,
  hasEncryptedFields,
  sqlIdentifier,
} from "./encrypted";

/**
 * **Every encrypted column a project holds, derived from its schemas** (#390).
 *
 * The rotator runs in the secrets manager, which never reads `pithy.config.ts`. So it learns the encrypted columns
 * the way it learns `rotateEveryDays`: `pithy secrets provision` and `pithy deploy` stamp it with them, and this is
 * the derivation they stamp. It reads the same markers #132's inventory walks, so a field marked `encrypted()`
 * tomorrow joins rotation on the next deploy, with no registration step.
 *
 * It is also how an app Worker reports its own retirement verdict: the same walk over its own capabilities, so what
 * the dashboard reads and what the rotator acts on are one derivation.
 *
 * ## D1 only, and what that excludes
 *
 * A KV `list()` returns keys, never values, so a KV envelope cannot be found by key version: no stale query, no
 * compare-and-swap and no count. An encrypted field in a KV store is refused at boot (`refuseEncryptedKvStores`), and
 * any this derivation still meets is reported as **unrotatable** rather than stamped, because nothing can ever prove
 * those values re-sealed. An unrotatable field blocks retirement.
 */

/** A SQL identifier as `CamelCasePlugin` writes one: what a stamp may name, so nothing else reaches the rotator's SQL. */
const SqlName = z.string().regex(/^[a-z_][a-z0-9_]*$/, "A SQL identifier: lowercase letters, digits and underscores.");

/** A JSON path of object keys, the only kind an encrypted field is reached by. */
const JsonPath = z
  .string()
  .regex(/^\$(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/, "A JSON path of object keys, such as `$.phone`.");

/** One encrypted column, as the rotator is stamped with it. */
export const EncryptedColumn = z
  .object({
    name: z.string().describe("The table's declared name: what the AAD binds, never the SQL table name."),
    path: z.string().describe("The field path the AAD binds: `diagnosis`, or `profile.phone` inside a JSON column."),
    table: SqlName.describe("The SQL table, as `CamelCasePlugin` writes it."),
    column: SqlName.describe("The SQL column holding the envelope, or the JSON column the field sits inside."),
    jsonPath: JsonPath.nullable().describe(
      "The JSON path of a field inside a JSON column, such as `$.phone`. Null for a field in its own column.",
    ),
    primaryKey: SqlName.describe("The SQL column of the table's app-assigned primary key."),
    binding: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "A binding name.")
      .describe("The D1 binding the table lives in. Workers that share a binding share the database."),
    index: z
      .object({
        column: SqlName.describe("The SQL column of the field's blind index."),
        normalizer: BlindIndexNormalizerName.describe("The normalizer the index hashes with."),
      })
      .nullable()
      .describe("The field's blind index, or null for a field with none."),
  })
  .describe("One encrypted column the rotator re-seals: where it is, and what its ciphertexts bind.");
export type EncryptedColumn = z.output<typeof EncryptedColumn>;

/** What the rotator is stamped with: the columns, and what the derivation could not cover. */
export const EncryptedColumnStamp = z
  .object({
    columns: z.array(EncryptedColumn).describe("Every encrypted D1 column the project's schemas declare."),
    unread: z
      .array(z.string())
      .describe(
        "Every schema source the derivation could not read, such as a Worker whose `pithy.config.ts` would not load. Non-empty means coverage is incomplete, and no version is retired.",
      ),
    unrotatable: z
      .array(z.string())
      .describe(
        "Every encrypted field whose storage is not D1, as `<capability>:<container>.<schema>:<path>`. Each blocks retirement.",
      ),
  })
  .describe("The encrypted columns a project holds, derived from its schemas, as the rotator is stamped with them.");
export type EncryptedColumnStamp = z.output<typeof EncryptedColumnStamp>;

/** A SQL JSON path from object keys. Each key is an identifier, which `encryptedLayout` has already required. */
function jsonPathOf(segments: readonly string[]): string {
  return `$.${segments.join(".")}`;
}

/** Where an encrypted field sits in one KV store's parts, for the unrotatable list. */
export function kvEncryptedPaths(store: { key: z.ZodType; value: z.ZodType; metadata?: z.ZodType }): string[] {
  const paths: string[] = [];
  for (const [part, schema] of [
    ["key", store.key],
    ["value", store.value],
    ["metadata", store.metadata],
  ] as const) {
    if (!schema || !hasEncryptedFields(schema)) continue;
    if (encryptedSpecOf(schema)) {
      paths.push(part);
      continue;
    }
    const located = encryptedLayout(schema).fields.map((field) => `${part}.${field.path}`);
    paths.push(...(located.length > 0 ? located : [part]));
  }
  return paths;
}

/**
 * Derive the encrypted columns of a set of composed capabilities. **Refuses** a D1 table with an encrypted field and
 * no `encryptedTable()` declaration, and a table whose layout cannot be sealed or rotated, naming the capability and
 * the table: a column the rotator cannot re-seal is a version that can never be retired.
 */
export function deriveEncryptedColumns(capabilities: readonly Capability[]): EncryptedColumnStamp {
  const columns: EncryptedColumn[] = [];
  const unrotatable: string[] = [];
  for (const capability of capabilities) {
    for (const [container, database] of Object.entries(capability.databases ?? {})) {
      for (const [table, schema] of Object.entries(database.tables)) {
        const layout = encryptedLayout(schema as z.ZodType);
        if (layout.fields.length === 0 && layout.problems.length === 0 && !hasEncryptedFields(schema as z.ZodType))
          continue;
        const where = `${capability.name}'s ${container}.${table} table`;
        if (layout.declaration === null) {
          throw new ValidationError({
            message: `${where} holds an encrypted field and declares no table.`,
            action:
              "Wrap its schema in encryptedTable(schema, { name, key }): the rotator re-seals by that name and key.",
          });
        }
        if (layout.problems.length > 0) {
          throw new ValidationError({
            message: `${where} cannot be rotated as declared. ${layout.problems.join(" ")}`,
            action: "Fix the schema's encrypted fields and their blindIndex columns.",
          });
        }
        for (const field of layout.fields) {
          const [head, ...rest] = field.segments as [string, ...string[]];
          columns.push({
            name: layout.declaration.name,
            path: field.path,
            table: sqlIdentifier(table),
            column: sqlIdentifier(head),
            jsonPath: rest.length > 0 ? jsonPathOf(rest) : null,
            primaryKey: sqlIdentifier(layout.declaration.key),
            binding: database.binding,
            index:
              field.indexField && field.spec.index
                ? { column: sqlIdentifier(field.indexField), normalizer: field.spec.index }
                : null,
          });
        }
      }
    }
    for (const [container, namespace] of Object.entries(capability.kvNamespaces ?? {})) {
      for (const [name, store] of Object.entries(namespace.stores)) {
        for (const path of kvEncryptedPaths(store)) unrotatable.push(`${capability.name}:${container}.${name}:${path}`);
      }
    }
  }
  return { columns, unread: [], unrotatable };
}

/**
 * **Refuse a KV store that holds an encrypted field, at boot** (#390). A KV envelope can never be found by key
 * version, so it could never be rotated, and encryption that cannot rotate reads as the feature and is not. The
 * refusal names the schema, the field and D1, and it reads through `.optional()`, `.nullable()`, `.default()` and
 * nesting, by the wrapper walk the markers use. `@pithy-sh/vector`'s filterable check is the precedent.
 */
export function refuseEncryptedKvStores(capabilities: readonly Capability[]): void {
  for (const capability of capabilities) {
    for (const [container, namespace] of Object.entries(capability.kvNamespaces ?? {})) {
      for (const [name, store] of Object.entries(namespace.stores)) {
        const [path] = kvEncryptedPaths(store);
        if (path === undefined) continue;
        throw new ValidationError({
          message: `${capability.name}'s KV store ${container}.${name} holds an encrypted field at "${path}". Encrypted fields rest in D1.`,
          action:
            "Move the field to a D1 table declared with encryptedTable(). A KV entry cannot be found by key version, so it could never be rotated.",
        });
      }
    }
  }
}
