// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyCommand } from "@pithy-sh/core/src/cli/command";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { secretsTables } from "@pithy-sh/secrets/src/data/tables";
import { declaredSecretTables } from "@pithy-sh/secrets/src/tables/database";
import {
  rowsBehind,
  SecretTableSecretStats,
  secretTableStats,
  type VaultTableStats,
} from "@pithy-sh/secrets/src/tables/stats";
import { z } from "zod";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { readProjectDatabases, type WorkerScope } from "../migrations/run";

/**
 * What an operator sees of a project's declared secret tables, in one environment (#524): each table, its
 * keys, its secret names, how many rows hold each, and which master-key version sealed them.
 *
 * **Never a value, and never an owner.** These tables are runtime data an application writes — per-customer
 * credentials — so nothing here reads or writes a row, and no command does. Visibility exists for one reason:
 * a rotation that half-finished across a customer table should be visible to the operator who triggered it,
 * and the key-version spread is what shows it. `pithy secrets tables` prints this; `pithy doctor` reports the
 * same read as a line.
 */

/** One declared table as this environment holds it. */
export const SecretTableReport = z
  .object({
    table: z.string().describe("The declared table's name — `customer` for `pithy_secrets_customer_secrets`."),
    worker: z.string().nullable().describe("The Worker that declares it, or `null` for one only the vault knows."),
    keys: z.array(z.string().describe("An owner key column.")).describe("Its owner key columns."),
    state: z
      .enum(["migrated", "not-migrated", "undeclared"])
      .describe(
        "`migrated` when the vault holds it; `not-migrated` when it is declared and its migration has not run here; `undeclared` when the vault holds it and no Worker declares it any more.",
      ),
    secrets: z.array(SecretTableSecretStats).describe("Each secret name, its row count and its key versions."),
  })
  .describe("One declared secret table in one environment.");
export type SecretTableReport = z.infer<typeof SecretTableReport>;

/** One environment's declared tables. */
export const SecretTablesReport = z
  .object({
    newestKeyVersion: z
      .number()
      .int()
      .nullable()
      .describe(
        "The newest master-key version any row in the vault is sealed under — the CLI cannot read the key set, so this is what the rows say. `null` for an empty vault.",
      ),
    behind: z
      .number()
      .int()
      .describe("Rows in declared tables sealed below that version: rows a rotation did not reach."),
    tables: z.array(SecretTableReport).describe("Every declared table, then any the vault holds that none declares."),
  })
  .describe("A project's declared secret tables in one environment.");
export type SecretTablesReport = z.infer<typeof SecretTablesReport>;

/** One declaration, and the Worker it came from. */
export interface DeclaredTable {
  worker: string;
  table: string;
  keys: readonly string[];
  secrets: readonly string[];
}

/** Every table the Workers declare, in Worker order. */
export function declaredTablesOf(workers: readonly WorkerScope[]): DeclaredTable[] {
  return workers.flatMap((worker) =>
    declaredSecretTables(worker.capabilities).flatMap((spec) =>
      spec.tables.map((table) => ({
        worker: worker.name,
        table: table.name,
        keys: table.keyNames,
        secrets: table.secretNames,
      })),
    ),
  );
}

/** Merge what the project declares with what the vault holds. Pure, so the output contract is testable. */
export function secretTablesReport(declared: readonly DeclaredTable[], vault: VaultTableStats): SecretTablesReport {
  const held = new Map(vault.tables.map((table) => [table.table, table]));
  const tables: SecretTableReport[] = declared.map((one) => {
    const stats = held.get(one.table);
    held.delete(one.table);
    if (!stats) {
      return {
        table: one.table,
        worker: one.worker,
        keys: [...one.keys],
        state: "not-migrated",
        secrets: one.secrets.map((name) => ({ name, rows: 0, keyVersions: {} })),
      };
    }
    return { table: one.table, worker: one.worker, keys: stats.keys, state: "migrated", secrets: stats.secrets };
  });
  for (const stats of held.values()) {
    tables.push({ table: stats.table, worker: null, keys: stats.keys, state: "undeclared", secrets: stats.secrets });
  }
  return { newestKeyVersion: vault.newestKeyVersion, behind: rowsBehind(vault), tables };
}

/** The vault stats of every `secrets` database in scope, folded into one — a project has one vault per env. */
export async function readVaultTables(options: {
  projectDir: string;
  env: string;
  account: CloudflareAccountSelection | null;
  workers?: WorkerScope[];
}): Promise<VaultTableStats> {
  const reads = await readProjectDatabases(
    {
      projectDir: options.projectDir,
      env: options.env,
      account: options.account,
      ...(options.workers ? { workers: options.workers } : {}),
    },
    "secrets",
    (d1) => secretTableStats(createDatabase(d1, secretsTables)),
  );
  const tables = reads.flatMap((read) => read.value.tables);
  const versions = reads.map((read) => read.value.newestKeyVersion).filter((version) => version !== null);
  return { newestKeyVersion: versions.length === 0 ? null : Math.max(...versions), tables };
}

/** `key v4`, or every version a secret's rows span, oldest first. */
function keyLabel(versions: Record<string, number>): string {
  const entries = Object.entries(versions).sort(([left], [right]) => Number(left) - Number(right));
  if (entries.length === 0) return "";
  if (entries.length === 1) return `key v${entries[0]?.[0]}`;
  return `keys ${entries.map(([version, rows]) => `v${version} ${rows}`).join(", ")}`;
}

/** `1 row`, `1204 rows`. */
function rowsLabel(rows: number): string {
  return `${rows} ${rows === 1 ? "row" : "rows"}`;
}

/**
 * The terminal lines: one block per table — its name and keys, then a line per secret name with its rows and
 * key versions — and a closing sentence when rows are behind. Whitespace-aligned within each block.
 */
export function secretTablesLines(report: SecretTablesReport, env: string): string[] {
  if (report.tables.length === 0) return ["No secret tables declared."];
  const width = Math.max(...report.tables.map((table) => table.table.length));
  const lines: string[] = [];
  for (const table of report.tables) {
    if (lines.length > 0) lines.push("");
    const keys = table.keys.join(", ");
    if (table.state === "not-migrated") {
      lines.push(
        `${table.table.padEnd(width)}  ${keys} — not migrated in ${env}. Run ${pithyCommand("migrate", { flags: { "--env": env } })}.`,
      );
      continue;
    }
    lines.push(
      `${table.table.padEnd(width)}  ${keys}${table.state === "undeclared" ? " — no Worker declares it" : ""}`,
    );
    const nameWidth = Math.max(0, ...table.secrets.map((secret) => secret.name.length));
    const rowWidth = Math.max(0, ...table.secrets.map((secret) => rowsLabel(secret.rows).length));
    for (const secret of table.secrets) {
      const label = keyLabel(secret.keyVersions);
      const line = `  ${secret.name.padEnd(nameWidth)}  ${rowsLabel(secret.rows).padEnd(rowWidth)}`;
      lines.push(label === "" ? line.trimEnd() : `${line}  ${label}`);
    }
  }
  if (report.behind > 0 && report.newestKeyVersion !== null) {
    lines.push("");
    lines.push(
      `${rowsLabel(report.behind)} ${report.behind === 1 ? "is" : "are"} not on key v${report.newestKeyVersion}. The last at-rest rotation did not reach ${report.behind === 1 ? "it" : "them"}.`,
    );
  }
  return lines;
}
