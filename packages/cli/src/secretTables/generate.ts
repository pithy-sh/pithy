// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pithyCommand } from "@pithy-sh/core/src/cli/command";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { declaredSecretTables } from "@pithy-sh/secrets/src/tables/database";
import {
  appliedSecretTables,
  diffSecretTable,
  nextMigrationName,
  renderMigrationIndex,
  renderSecretTableMigration,
  type SecretTableDiff,
} from "@pithy-sh/secrets/src/tables/plan";
import { z } from "zod";
import type { WorkerScope } from "../migrations/run";

/**
 * `pithy migrate`'s first step for declared secret tables (`@pithy-sh/secrets/src/tables`): **diff, write,
 * stop.**
 *
 * Each Worker that composes `secretTablesDatabase` is diffed against the chain it composes — the steps its
 * generated migrations carry, folded. A table the chain has never seen, or one that gained a key or a secret
 * name, gets the next migration written into `apps/<worker>/migrations/secrets/`, and the directory's
 * `index.ts` is rewritten from the listing. Then the run stops, before anything is applied: the file is the
 * adopter's to read, and running `pithy migrate` again applies it. A declaration matching its chain writes
 * nothing, so running twice writes one file, not two.
 *
 * Three refusals, each before anything is written:
 *
 * - **A key the chain created is gone from the declaration** — removed or renamed. A migration that drops a
 *   column holding somebody's key is a loss the adopter authors deliberately, so the diff names it and stops.
 * - **A migration file on disk the spec does not compose.** It was written and never wired, or the index was
 *   lost; diffing against a chain missing it would write it again.
 * - **One table declared by two Workers.** Two Workers sharing `SECRETS` would each migrate it under one
 *   namespace with different files. One Worker owns a table; the others read it with `.table(T)`, which needs
 *   the declaration and nothing else.
 */

/** Where a Worker's declared-table migrations live, relative to its directory. */
export const SECRET_TABLE_MIGRATIONS_DIR = join("migrations", "secrets");

/** One migration this run wrote — or, under `--dry-run`, would write. */
export const GeneratedMigration = z
  .object({
    worker: z.string().describe("The Worker whose declaration changed."),
    table: z.string().describe("The declared table's name."),
    change: z.enum(["create", "alter"]).describe("`create` for a table the chain has never seen, else `alter`."),
    file: z.string().describe("The file written, relative to the project root."),
    addedKeys: z.array(z.string().describe("A key column.")).describe("Key columns the migration adds."),
    addedSecrets: z.array(z.string().describe("A secret name.")).describe("Secret names the migration registers."),
    removedSecrets: z
      .array(z.string().describe("A secret name."))
      .describe("Secret names the migration drops from the registration. Their rows are left as they are."),
  })
  .describe("One declared-table migration `pithy migrate` wrote, or would write.");
export type GeneratedMigration = z.infer<typeof GeneratedMigration>;

/** What {@link generateSecretTableMigrations} takes. */
export interface GenerateOptions {
  /** The project root, which every reported path is relative to. */
  projectDir: string;
  /** The environment the run migrates — what a refusal's next command names. */
  env: string;
  /** The Workers in the run's scope, as composed for its environment. */
  workers: readonly WorkerScope[];
  /** Write the files. `false` is `--dry-run`: the same answer, nothing on disk. */
  write: boolean;
}

/** A migration file the directory holds: `NNNN_slug.ts`. */
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.ts$/;

/** The directory's listing, empty when it does not exist yet. */
async function listing(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** A path as a report shows it: relative to the project root, with forward slashes on every platform. */
function shown(projectDir: string, path: string): string {
  return relative(projectDir, path).split(sep).join("/");
}

/** One Worker's declarations, ready to diff: where its files go, what is there, and what it composes. */
interface WorkerTables {
  worker: WorkerScope;
  dir: string;
  files: string[];
  diffs: SecretTableDiff[];
}

/** Refuse a table two Workers declare, naming both. */
function refuseShared(owners: Map<string, string>, table: string, worker: string): void {
  const first = owners.get(table);
  if (first !== undefined && first !== worker) {
    throw new ValidationError({
      message: `Secret table ${table} is declared by ${first} and ${worker}.`,
      action: `Declare it in one Worker's secretTablesDatabase. The other reads it with .table(T), which needs the declaration alone.`,
    });
  }
  owners.set(table, worker);
}

/**
 * Diff every Worker's declared tables against its composed chain, and write what closes each divergence.
 * Throws a refusal — see the module docblock — before writing anything.
 */
export async function generateSecretTableMigrations(options: GenerateOptions): Promise<{
  generated: GeneratedMigration[];
}> {
  const owners = new Map<string, string>();
  const planned: WorkerTables[] = [];

  for (const worker of options.workers) {
    const declared = declaredSecretTables(worker.capabilities);
    if (declared.length === 0) continue;
    const dir = join(worker.dir, SECRET_TABLE_MIGRATIONS_DIR);
    const files = await listing(dir);
    const composed = new Set(declared.flatMap((spec) => Object.keys(spec.migrations)));
    const unwired = files
      .filter((file) => MIGRATION_FILE.test(file))
      .map((file) => file.slice(0, -".ts".length))
      .filter((key) => !composed.has(key));
    if (unwired.length > 0) {
      throw new ValidationError({
        message: `${shown(options.projectDir, dir)} holds ${unwired.join(", ")}, which ${worker.name} does not compose.`,
        action: `Pass secretTableMigrations from ${shown(options.projectDir, join(dir, "index.ts"))} to secretTablesDatabase in ${worker.name}'s pithy.config.ts, then run ${pithyCommand("migrate", { flags: { "--env": options.env } })} again.`,
      });
    }

    const diffs: SecretTableDiff[] = [];
    for (const spec of declared) {
      const applied = appliedSecretTables(spec.migrations);
      for (const table of spec.tables) {
        refuseShared(owners, table.name, worker.name);
        const diff = diffSecretTable(table, applied.get(table.name));
        if (diff.kind === "refused") {
          const keys = diff.removedKeys.join(", ");
          throw new ValidationError({
            message: `Secret table ${diff.table} no longer declares ${diff.removedKeys.length === 1 ? "key" : "keys"} ${keys}. A generated migration never drops a key column.`,
            action: `Put ${keys} back in the declaration. A rename is a new key beside the old one. To drop a column that holds owners' keys, write that migration by hand.`,
          });
        }
        if (diff.kind !== "unchanged") diffs.push(diff);
      }
    }
    if (diffs.length > 0) planned.push({ worker, dir, files, diffs });
  }

  const generated: GeneratedMigration[] = [];
  for (const { worker, dir, files, diffs } of planned) {
    const written = [...files];
    for (const diff of diffs) {
      if (diff.kind !== "create" && diff.kind !== "alter") continue;
      const name = nextMigrationName(written, diff);
      const path = join(dir, `${name}.ts`);
      if (options.write) {
        await mkdir(dir, { recursive: true });
        await writeFile(path, renderSecretTableMigration(diff), { flag: "wx" });
      }
      written.push(`${name}.ts`);
      generated.push({
        worker: worker.name,
        table: diff.table,
        change: diff.kind,
        file: shown(options.projectDir, path),
        addedKeys: diff.addedKeys,
        addedSecrets: diff.addedSecrets,
        removedSecrets: diff.removedSecrets,
      });
    }
    if (options.write) await writeFile(join(dir, "index.ts"), renderMigrationIndex(written));
  }
  return { generated };
}

/**
 * The lines a run that wrote migrations prints, before `Done.` — what changed per table, every file written,
 * and the instruction. Nothing was applied, so nothing else is said. Under `--dry-run` it names what it
 * would write and says nothing was.
 */
export function formatGeneratedReport(generated: readonly GeneratedMigration[], dryRun = false): string {
  const lines: string[] = [];
  for (const one of generated) {
    lines.push(one.change === "create" ? `New secret table: ${one.table}` : `Declaration changed: ${one.table}`);
    for (const key of one.addedKeys) lines.push(`  + key     ${key}`);
    for (const secret of one.addedSecrets) lines.push(`  + secret  ${secret}`);
    for (const secret of one.removedSecrets) lines.push(`  - secret  ${secret}`);
  }
  lines.push("");
  for (const one of generated) lines.push(`${dryRun ? "Would write" : "Wrote"} ${one.file}`);
  lines.push(
    dryRun ? "Dry run. Nothing written." : `Review ${generated.length === 1 ? "it" : "them"}, then run migrate again.`,
  );
  lines.push("");
  return lines.join("\n");
}
