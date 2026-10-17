// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import type { D1Database } from "@cloudflare/workers-types";
import { retainedTableName } from "@pithy-sh/core/src/migrations/retained";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { localDevStorePath, localResourceRoot } from "../devSecrets/store";
import type { WorkerScope } from "../migrations/run";
import { resolveStoreIds } from "../seed/drivers";

/**
 * **Does `dev` already hold data? The question `pithy setup` asks before it seeds (#764).**
 *
 * Setup seeds a database only when it is empty, and leaves one holding rows alone — `pithy seed --redo` is
 * the way to reset, and it asks first. "Holds rows" is judged over every table a Worker's capabilities
 * declare, **less the retained ones**: a retained table's rows exist nowhere else (a vault's sealed
 * credentials, a suppression list), so they are never what a fixture writes, and the secrets vault holds
 * the dev secrets setup itself seeds a step earlier. Counting it would make every first run look seeded.
 *
 * Read-only, and local: the stores are the Miniflare ones every `dev` command persists under the project
 * root, opened the way the seed driver opens them, and closed before this returns.
 */

/** One table that holds at least one row, through the binding a Worker reaches it by. */
export interface HeldTable {
  /** The first Worker that declares it. */
  worker: string;
  /** The D1 binding. */
  binding: string;
  /** The SQL table name. */
  table: string;
}

/** What {@link devDataHeld} needs. */
export interface DevDataHeldOptions {
  /** The project root — owner of the local stores. */
  projectDir: string;
  /** Every Worker, with what it composes. */
  workers: readonly WorkerScope[];
}

/** One physical database and the tables in it a seed would judge. */
interface Probe {
  worker: string;
  binding: string;
  tables: Set<string>;
}

/** Every declared, non-retained table that holds a row, at most one per database. Empty when none does. */
export async function devDataHeld(options: DevDataHeldOptions): Promise<HeldTable[]> {
  // Keyed on the database's local identity rather than its binding, so two Workers sharing one D1 are one
  // question — and two Workers pointing one binding at two databases are two.
  const probes = new Map<string, Probe>();
  for (const worker of options.workers) {
    const ids = await resolveStoreIds({ workerDir: worker.dir, env: LOCAL_ENVIRONMENT });
    for (const capability of worker.capabilities) {
      for (const spec of Object.values(capability.databases ?? {})) {
        const id = ids.d1.get(spec.binding);
        if (id === undefined) continue;
        const retained = new Set(spec.retained ?? []);
        const probe = probes.get(id) ?? { worker: worker.name, binding: spec.binding, tables: new Set<string>() };
        for (const key of Object.keys(spec.tables)) {
          if (!retained.has(key)) probe.tables.add(retainedTableName(key));
        }
        probes.set(id, probe);
      }
    }
  }
  // No local store at all is a checkout nothing has migrated or seeded yet. Opening one would create it,
  // which a dry run must not do, and there is nothing in it to find.
  if (probes.size === 0 || !existsSync(localDevStorePath(options.projectDir))) return [];

  // Loaded here rather than at module scope, as every opener of a local store is: `miniflare` costs
  // ~290 ms to import, and `ci/lazyHeavyImports.test.ts` holds the property.
  const { convertV4MiniflareOptions, Miniflare } = await import("miniflare");
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      d1Databases: Object.fromEntries([...probes.keys()].map((id) => [id, id])),
      resourcePersistencePath: localResourceRoot(options.projectDir),
    }),
  );
  try {
    const held: HeldTable[] = [];
    for (const [id, probe] of probes) {
      const database = (await miniflare.getD1Database(id)) as unknown as D1Database;
      const table = await firstHeld(database, [...probe.tables].sort());
      if (table !== null) held.push({ worker: probe.worker, binding: probe.binding, table });
    }
    return held;
  } finally {
    await miniflare.dispose();
  }
}

/** The first of `tables` present in the database with a row in it, or `null`. */
async function firstHeld(database: D1Database, tables: readonly string[]): Promise<string | null> {
  for (const table of tables) {
    const present = await database
      .prepare("select name from sqlite_master where type = 'table' and name = ?")
      .bind(table)
      .first<{ name: string }>();
    if (!present) continue;
    // The name is a capability's declaration through the plugin's own snake-casing, never input, and it has
    // just been matched against `sqlite_master`.
    const row = await database.prepare(`select 1 as held from "${table}" limit 1`).first<{ held: number }>();
    if (row) return table;
  }
  return null;
}
