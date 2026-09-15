// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import {
  countRetainedRows,
  type RetainedBudget,
  type RetainedRows,
  retainedRefusal,
  retainedTableNames,
} from "@pithy-sh/core/src/migrations/retained";
import type { MigrationProvider } from "kysely/migration";

/**
 * **A database holding retained rows is not deleted unless the operator counted them (#591).**
 *
 * #588 made a table's rows-exist-nowhere-else a declaration (`DatabaseSpec.retained`) and refused every
 * `down` over them. A teardown does not run a `down`. It deletes the database whole, over the control plane,
 * and `pithy secrets deprovision` did exactly that to every declared environment's vault — production's
 * included — with nothing counted and nothing asked. This module is where that deletion meets the same guard:
 * the same count, the same refusal, the same budget. It restates none of them.
 *
 * ## What is TRUE
 *
 * **No database whose migrations declare retained tables is deleted through {@link deleteRetainedDatabase}
 * while those tables hold more rows than the run's {@link RetainedBudget} agreed to destroy.** Counted over
 * REST immediately before the delete, so a row written after an earlier count is a row this refuses.
 *
 * And the declaration cannot be silently absent: a provider that declares **no** retained table is refused
 * as an internal fault rather than counted. That is the failure this would otherwise have — a provisioner's
 * migration set built without the capability's `retained`, counting nothing, deleting a vault.
 *
 * ## Its reach, stated so it can be checked
 *
 * - **Seen:** every D1 deletion in the CLI's own sources outside `provision/resources.ts`. The gate in
 *   `retainedDatabase.test.ts` reads every non-test `.ts` under `packages/cli/src`, skipping comment lines,
 *   for the member name `deleteDatabase` — which a call, a destructured or aliased member, or a string key
 *   still has to spell once — and permits it only in this file, in `provision/resources.ts`, and as a line
 *   that *declares* a seam method of that name (`async deleteDatabase(`), which deletes nothing itself.
 * - **Deliberately not routed:** `provision/resources.ts`, a feature environment's `DB`/KV/R2 teardown. A
 *   feature binds no secrets or suppression database of its own — those are declared-environment, durable,
 *   and outlive every branch — so nothing retained lives in what it deletes.
 * - **Not seen:** a member name built at runtime (`d1["delete" + "Database"]`), a raw `DELETE` against
 *   `/d1/database/<id>` through `cloudflareRequest` or `fetch`, `wrangler d1 delete` spawned as a subprocess,
 *   and any package other than the CLI.
 */

/** One database to count or delete: the account's clients, its id, and the migrations that declare its tables. */
export interface RetainedDatabase {
  /** The account's control-plane clients. */
  cf: CloudflareClients;
  /** The D1 database's uuid. */
  databaseId: string;
  /** The database's name — `<project>-<env>-secrets` — the label a refusal names it by. */
  name: string;
  /** The capability's migration set for this database, carrying its retained declaration. */
  provider: MigrationProvider;
}

/** Refuse a provider that declares nothing retained: counting it would find nothing and let the delete through. */
async function requireDeclared(database: RetainedDatabase): Promise<void> {
  if ((await retainedTableNames(database.provider)).length > 0) return;
  throw new InternalError({
    message: `The migrations for ${database.name} declare no retained table, so its rows cannot be counted.`,
    action: "Build the provider with the capability's retained tables. Nothing was deleted.",
  });
}

/** The retained rows `database` holds, named by its database name. Read-only. */
export async function countDatabaseRetained(database: RetainedDatabase): Promise<RetainedRows[]> {
  await requireDeclared(database);
  return countRetainedRows(database.cf.d1(database.databaseId), await database.provider.getMigrations(), database.name);
}

/**
 * Delete `database`, spending its retained rows from `budget` first — refused whole, with nothing spent and
 * nothing deleted, when the budget does not cover them. The floor under a command's exact-count preflight
 * (`assertRetainedAgreed`), fed the operator's number and never that preflight's count.
 */
export async function deleteRetainedDatabase(database: RetainedDatabase, budget: RetainedBudget): Promise<void> {
  const atRisk = await countDatabaseRetained(database);
  const total = atRisk.reduce((sum, entry) => sum + entry.rows, 0);
  if (!budget.spend(total)) throw retainedRefusal(atRisk, budget.agreed, "anything was deleted");
  await database.cf.d1Provisioner().deleteDatabase(database.databaseId);
}
