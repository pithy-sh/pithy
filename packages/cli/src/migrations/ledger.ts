// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import { MIGRATION_TABLE } from "@pithy-sh/core/src/migrations/bookkeeping";
import { readMigrationLedger } from "@pithy-sh/core/src/migrations/runner";
import { z } from "zod";
import type { DatabaseGroup, MigrationDriver } from "./run";

/**
 * **What the project declares is what the ledger records.**
 *
 * Two halves of one fact, in two places — the migrations a Worker's capabilities compose, and the rows
 * `pithy_migrations` carries — and until #282 nothing compared them in the direction that matters.
 * `pithy doctor` subtracted applied from declared and called the remainder "pending", which sees a
 * migration that has not run and is structurally blind to one that ran and is no longer declared.
 * Nothing is missing, so nothing is pending, so the check passes. Meanwhile Kysely reads an applied
 * migration its provider does not carry as a corrupted chain and refuses to run *anything* — so the
 * command that says whether a project is healthy said yes about a database that could not be migrated.
 *
 * The same shape as #264 and #267: a declaration, a state, and no reader holding them together.
 *
 * ## One comparison, both directions, one sentence
 *
 * {@link readMigrationLedger} asks the whole question of one database — what is declared and unapplied,
 * and what is applied and undeclared — so no caller can ask half of it. `pithy doctor` renders both
 * halves and fails its exit on either; `pithy migrate` refuses on the second before it writes anything,
 * with the same sentence doctor prints, from {@link describeUndeclared} and {@link undeclaredRemedy}.
 * Two commands reporting the same state in two wordings is how the two disagreed in the first place.
 *
 * ## The remedy is not "fix the migration"
 *
 * Nothing is broken about any migration here — the files are fine, the state moved. And what to do about
 * it depends on something the tool already knows: for `dev` this is the Miniflare store under
 * `.wrangler/state`, which is recreated in seconds, so deleting it is correct and cheap. For a deployed
 * environment it is a database with real rows in it, where the same advice would be a data loss the
 * adopter was told to cause. So the remedy names which of the two applies rather than leaving it to be
 * guessed.
 */

/** One applied migration this project no longer declares. */
export const UndeclaredMigration = z
  .object({
    database: z.string().describe("The database name — a capability's `databases` key."),
    binding: z
      .string()
      .describe("The D1 binding it resolves to, as wrangler.jsonc declares it — the name an adopter recognises."),
    name: z.string().describe("The composed migration name, exactly as the ledger records it."),
  })
  .describe("One migration a database has applied that this project no longer declares.");
export type UndeclaredMigration = z.infer<typeof UndeclaredMigration>;

/**
 * The problem line: which binding records what, and that nothing declares it any more.
 *
 * Grouped by binding, because a project migrates several databases and "records" is a claim about one of
 * them. The names are the ledger's own, unabridged — a truncated migration name is not something anyone
 * can grep a repository for.
 */
export function describeUndeclared(entries: readonly UndeclaredMigration[]): string {
  const byBinding = new Map<string, string[]>();
  for (const entry of entries) {
    const names = byBinding.get(entry.binding) ?? [];
    names.push(entry.name);
    byBinding.set(entry.binding, names);
  }
  const sentences = [...byBinding].map(([binding, names]) => `${binding} records ${names.join(", ")}.`);
  return `${sentences.join(" ")} This project no longer declares ${entries.length === 1 ? "it" : "them"}.`;
}

/**
 * The action line, and it depends on which database this is.
 *
 * `dev` is the local Miniflare store: throwing it away costs a re-migrate and nothing else, so that is
 * the advice, and it is the one an adopter who just deleted a migration wants. Every other environment
 * is a real database whose tables hold real rows — there the ledger row is the thing to reconcile, and a
 * reset would be the tool telling someone to destroy production to fix a bookkeeping mismatch.
 */
export function undeclaredRemedy(env: string): string {
  const opening = "Nothing migrates until the ledger and the declaration agree.";
  return env === "dev"
    ? `${opening} This is the local dev store, so wiping it is cheap: delete .wrangler/state, then run pithy migrate --env dev again.`
    : `${opening} ${env} holds real rows, so don't reset it: restore the migration to this project, or delete its row from ${MIGRATION_TABLE} if the schema it created is meant to stay.`;
}

/**
 * Refuse a run against a database whose ledger records something this project no longer declares.
 *
 * Placed at {@link runGroups}, beside `claimGroups` and for the same reason: it is the one line every
 * path that writes to a database goes through, so the refusal cannot be honoured by two commands and
 * skipped by six. It runs after the ownership claim — whose database this is comes before what is in it.
 *
 * **Only for a pass whose provider spans the whole ledger.** `pithy remove --drop` runs a deliberately
 * partial provider, one capability's migrations against a database full of other capabilities' rows, so
 * every one of those rows is "undeclared" to it and refusing there would break the command outright.
 *
 * Kysely would refuse anyway, one layer down and with `corrupted migrations: previously executed
 * migration X is missing` — which is a real sentence, and one nobody ever saw, because the runner
 * flattened it into `Migration run failed.` on the way out (#282). This refuses first so the sentence is
 * ours: it names the binding, the migration, and a remedy that fits the database it is talking about.
 */
export async function assertLedgerDeclared(options: {
  /** The environment being migrated — what decides which remedy is true. */
  env: string;
  /** The open driver, already holding a D1 per group. */
  driver: MigrationDriver;
  /** The groups this run will execute, in run order. */
  groups: DatabaseGroup[];
}): Promise<void> {
  const undeclared: UndeclaredMigration[] = [];
  const workers = new Set<string>();
  for (const group of options.groups) {
    const ledger = await readMigrationLedger(options.driver.database(group), group.provider);
    for (const name of ledger.undeclared) {
      undeclared.push({ database: group.database, binding: group.binding, name });
    }
    for (const entry of group.entries) workers.add(entry.worker);
  }
  if (undeclared.length === 0) return;

  throw new ConflictError({
    message: describeUndeclared(undeclared),
    action: undeclaredRemedy(options.env),
    // The registries that were compared against, because the comparison is only as complete as they are:
    // a Worker whose config could not be loaded contributes nothing, and its applied migrations would
    // look exactly like a deleted one from here. Naming them makes that diagnosable instead of baffling.
    detail: `Compared against the migrations composed by ${[...workers].join(", ") || "no workers"} for ${options.env}.`,
  });
}
