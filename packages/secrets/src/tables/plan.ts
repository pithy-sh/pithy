// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName } from "@pithy-sh/core/src/cli/command";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Migration } from "kysely/migration";
import { type AnySecretTable, snakeCase } from "./defineSecretTable";
import { isSecretTableMigration, type SecretTablePlan, type SecretTableStep } from "./migration";

/**
 * The diff between a declared table and its applied migration chain, and the file that closes it.
 *
 * `pithy migrate` folds the steps the composed migrations carry into the shape the chain already says
 * ({@link appliedSecretTables}), compares each declaration against it ({@link diffSecretTable}), and writes
 * one migration per divergence ({@link renderSecretTableMigration}) — then stops. It writes and never
 * applies: the file is the adopter's to read before it runs, and the chain stays append-only.
 *
 * Everything here is pure. The CLI owns the directory and the run; this owns what a change *is*.
 */

/** The fold of a chain: each declared table's name → the shape its newest step leaves. */
export function appliedSecretTables(migrations: Readonly<Record<string, Migration>>): Map<string, SecretTablePlan> {
  const applied = new Map<string, SecretTablePlan>();
  // Key order is migration order — the runner sorts composed keys the same way.
  for (const key of Object.keys(migrations).sort()) {
    const migration = migrations[key];
    if (!migration || !isSecretTableMigration(migration)) continue;
    applied.set(migration.secretTable.to.table, migration.secretTable.to);
  }
  return applied;
}

/** What one declaration needs, against what its chain already says. */
export type SecretTableDiff =
  | {
      /** The chain already says exactly this. Nothing to write. */
      kind: "unchanged";
      /** The declared table's name. */
      table: string;
    }
  | {
      /** The chain has never seen this table, or it gained a key or a secret name since. */
      kind: "create" | "alter";
      /** The declared table's name. */
      table: string;
      /** The step the migration would apply. */
      step: SecretTableStep;
      /** Key columns this step adds — every key, for a create. */
      addedKeys: string[];
      /** Secret names this step adds to the registration. */
      addedSecrets: string[];
      /** Secret names this step drops from the registration. Rows holding them are left as they are. */
      removedSecrets: string[];
    }
  | {
      /**
       * A key column the chain created is gone from the declaration — removed, or renamed, which reads as a
       * removal and an addition. Never generated: a migration that drops a column holding somebody's key is
       * a loss the adopter authors deliberately.
       */
      kind: "refused";
      /** The declared table's name. */
      table: string;
      /** Each key the chain has and the declaration does not. */
      removedKeys: string[];
    };

/**
 * Compare one declaration with what its chain already says.
 *
 * Order is not a change. The applied key order is kept and new keys append to it, because the owner index is
 * built in that order and a row's bound context sorts its keys anyway; listing the same keys in a different
 * order in `pithy.config.ts` writes nothing.
 */
export function diffSecretTable(table: AnySecretTable, applied: SecretTablePlan | undefined): SecretTableDiff {
  const declaredKeys = [...table.keyNames];
  const declaredSecrets = [...table.secretNames];
  if (applied === undefined) {
    const to = { table: table.name, keys: declaredKeys, secrets: declaredSecrets };
    return {
      kind: "create",
      table: table.name,
      step: { from: null, to },
      addedKeys: declaredKeys,
      addedSecrets: declaredSecrets,
      removedSecrets: [],
    };
  }

  const removedKeys = applied.keys.filter((key) => !declaredKeys.includes(key));
  if (removedKeys.length > 0) return { kind: "refused", table: table.name, removedKeys };

  const addedKeys = declaredKeys.filter((key) => !applied.keys.includes(key));
  const addedSecrets = declaredSecrets.filter((secret) => !applied.secrets.includes(secret));
  const removedSecrets = applied.secrets.filter((secret) => !declaredSecrets.includes(secret));
  if (addedKeys.length === 0 && addedSecrets.length === 0 && removedSecrets.length === 0) {
    return { kind: "unchanged", table: table.name };
  }
  const to = {
    table: table.name,
    keys: [...applied.keys, ...addedKeys],
    secrets: [...applied.secrets.filter((secret) => !removedSecrets.includes(secret)), ...addedSecrets],
  };
  return { kind: "alter", table: table.name, step: { from: applied, to }, addedKeys, addedSecrets, removedSecrets };
}

/** A migration file this directory holds: four digits, an underscore, a lower-case slug. */
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.ts$/;

/** The diff kinds that write a file. */
type Writing = Extract<SecretTableDiff, { kind: "create" | "alter" }>;

/** Refuse a diff that writes nothing — a caller asking to name one is a caller with a bug. */
function writing(diff: SecretTableDiff): Writing {
  if (diff.kind === "create" || diff.kind === "alter") return diff;
  throw new InternalError({ detail: `secret table '${diff.table}': a ${diff.kind} diff writes no migration` });
}

/**
 * The next migration's key: one past the highest-numbered file in the directory, named for what it does —
 * `0001_customer_init`, `0007_customer_team_id`, `0008_customer_secrets`. A hand-written file counts toward
 * the number like a generated one, so the two never collide.
 */
export function nextMigrationName(files: readonly string[], diff: SecretTableDiff): string {
  const change = writing(diff);
  const highest = Math.max(
    0,
    ...files.map((file) => MIGRATION_FILE.exec(file)?.[1]).flatMap((digits) => (digits ? [Number(digits)] : [])),
  );
  const slug =
    change.kind === "create"
      ? "init"
      : change.addedKeys.length > 0
        ? change.addedKeys.map(snakeCase).join("_")
        : "secrets";
  return `${String(highest + 1).padStart(4, "0")}_${snakeCase(change.table)}_${slug}`;
}

/** The formatter's line width, so a generated file passes `biome check` as written. */
const LINE_WIDTH = 120;

/** One string array at `indent`, inline when it fits the line and one element per line when it does not. */
function renderArray(label: string, values: readonly string[], indent: string): string[] {
  const inline = `${indent}${label}: [${values.map((value) => JSON.stringify(value)).join(", ")}],`;
  if (inline.length <= LINE_WIDTH) return [inline];
  return [`${indent}${label}: [`, ...values.map((value) => `${indent}  ${JSON.stringify(value)},`), `${indent}],`];
}

/** One plan as an expanded object literal — expanded always, which the formatter keeps as written. */
function renderPlan(label: string, plan: SecretTablePlan | null): string[] {
  if (plan === null) return [`  ${label}: null,`];
  return [
    `  ${label}: {`,
    `    table: ${JSON.stringify(plan.table)},`,
    ...renderArray("keys", plan.keys, "    "),
    ...renderArray("secrets", plan.secrets, "    "),
    "  },",
  ];
}

/**
 * The file one diff writes: an ordinary migration, built by `secretTableMigration` from the step the diff
 * computed. The header says where it came from and what to do with it, in the brand's voice.
 */
export function renderSecretTableMigration(diff: SecretTableDiff): string {
  const change = writing(diff);
  return [
    `// Generated by \`${commandName("migrate")}\` from the \`${change.table}\` secret table declaration.`,
    "// Review it, then commit it. Once it has run anywhere it is history: change the declaration and",
    `// let \`${commandName("migrate")}\` write the next one, never edit this one.`,
    'import { secretTableMigration } from "@pithy-sh/secrets/src/tables/migration";',
    "",
    "export default secretTableMigration({",
    ...renderPlan("from", change.step.from),
    ...renderPlan("to", change.step.to),
    "});",
    "",
  ].join("\n");
}

/** `0001_customer_init` → `m0001CustomerInit`, an identifier an import can bind. */
function importName(key: string): string {
  return `m${key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())}`;
}

/**
 * The index that composes the directory: every migration file beside it, imported and keyed by its name.
 *
 * Rewritten from the listing every time `pithy migrate` writes a file, so a migration in the directory is a
 * migration the `secrets` database spec composes — a hand-written one included, as long as it default-exports
 * its `Migration` under the same `NNNN_slug.ts` naming.
 */
export function renderMigrationIndex(files: readonly string[]): string {
  const keys = files
    .filter((file) => MIGRATION_FILE.test(file))
    .map((file) => file.slice(0, -".ts".length))
    .sort();
  const header = [
    `// Rewritten by \`${commandName("migrate")}\` from the migration files beside it, every time it writes one.`,
    "// Each file default-exports one migration of the secrets database. Pass this set to",
    "// `secretTablesDatabase` in pithy.config.ts.",
  ];
  if (keys.length === 0) return [...header, "export const secretTableMigrations = {};", ""].join("\n");
  return [
    ...header,
    ...keys.map((key) => `import ${importName(key)} from "./${key}";`),
    "",
    "export const secretTableMigrations = {",
    ...keys.map((key) => `  ${JSON.stringify(key)}: ${importName(key)},`),
    "};",
    "",
  ].join("\n");
}
