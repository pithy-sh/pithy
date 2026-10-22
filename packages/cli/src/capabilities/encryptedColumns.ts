// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { deriveEncryptedColumns, type EncryptedColumn } from "@pithy-sh/core/src/privacy/encryptedColumns";
import type { StampedEncryptedColumns } from "@pithy-sh/secrets/src/provision/resolveManagerConfig";
import { resolveWorkerSetFor } from "../project/composeFor";
import { isUnknown, type WorkerSet } from "../project/workerScope";
import { readOptionalWranglerConfig } from "../project/wrangler";
import { provisionRemedy } from "../provision/provisionFix";

/**
 * **What the secrets manager is stamped with: every encrypted column in the project, and the D1 each lives in** (#390).
 *
 * The manager never reads `pithy.config.ts`, so `pithy secrets provision` and `pithy deploy` derive the columns from
 * every Worker's composed schemas — the same `deriveEncryptedColumns` an app Worker's own retirement report walks —
 * and stamp them, with each database's id from that environment's `wrangler.jsonc` stanza. A field marked
 * `encrypted()` joins rotation on the next deploy, with no registration step.
 *
 * **It refuses rather than stamps a partial set it could have known.** An encrypted table with no `encryptedTable()`
 * declaration is refused by the derivation, naming it, and a stamped binding with no database id for the
 * environment is refused here, naming the provision that creates it. A Worker whose `pithy.config.ts` will not load
 * is different: nobody can say what it holds, so it is recorded as an unread source, which keeps every retirement
 * from going ahead until it loads.
 */

/** One Worker's stanza for an environment, as far as its D1 bindings go. */
interface D1Stanza {
  d1_databases?: { binding?: string; database_name?: string; database_id?: string }[];
}

/** Whether a `database_id` is one wrangler would deploy against, by the rule every readiness check uses. */
function isId(value: string | undefined): value is string {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed !== "" && !/^<.+>$/.test(trimmed) && !/placeholder/i.test(trimmed);
}

/** A column's identity: one per binding, table, column and field path, however many Workers compose it. */
function columnKey(column: EncryptedColumn): string {
  return `${column.binding}\u0000${column.table}\u0000${column.column}\u0000${column.path}`;
}

/** Derive the stamp for one environment. See the module note for what it refuses. */
export async function projectEncryptedColumns(options: {
  projectDir: string;
  env: string;
  /** The Workers, composed for `env`, when the caller already holds them. */
  workers?: WorkerSet;
}): Promise<StampedEncryptedColumns> {
  const set = options.workers ?? (await resolveWorkerSetFor(options.env, { projectDir: options.projectDir }));
  if (isUnknown(set)) {
    return { stamp: { columns: [], unread: [set.unknown], unrotatable: [] }, databases: [] };
  }
  const columns = new Map<string, EncryptedColumn>();
  const unrotatable = new Set<string>();
  const homes = new Map<string, string>();
  for (const worker of set) {
    const derived = deriveEncryptedColumns(worker.capabilities);
    for (const column of derived.columns) {
      columns.set(columnKey(column), column);
      if (!homes.has(column.binding)) homes.set(column.binding, worker.dir);
    }
    for (const field of derived.unrotatable) unrotatable.add(field);
  }
  const databases: { binding: string; databaseName: string; databaseId: string }[] = [];
  for (const [binding, dir] of [...homes].sort(([left], [right]) => left.localeCompare(right))) {
    const config = (await readOptionalWranglerConfig(dir).catch(() => null)) as {
      env?: Record<string, D1Stanza | undefined>;
    } | null;
    const entry = (config?.env?.[options.env]?.d1_databases ?? []).find((one) => one.binding === binding);
    if (!entry || !isId(entry.database_id)) {
      throw new ValidationError({
        message: `${options.env} has no ${binding} database yet, and an encrypted table lives in it.`,
        action: provisionRemedy(options.env).say(
          (command) => `Run ${command}, then provision the secrets manager again so it can re-seal that table.`,
        ),
      });
    }
    databases.push({ binding, databaseName: entry.database_name ?? binding, databaseId: entry.database_id });
  }
  return {
    stamp: { columns: [...columns.values()], unread: [], unrotatable: [...unrotatable].sort() },
    databases,
  };
}
