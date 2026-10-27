// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { Migration, MigrationProvider } from "kysely/migration";
import { readObjects } from "./inspect";

/**
 * **Every name the migrations make, found by running them (#848).**
 *
 * A backup's `schema.sql` carries only what no migration owns — a table an adopter made by hand, an index
 * they added to a kit table — because a restore runs `pithy migrate` first and the migrations make the
 * rest. Which names those are is a question only the migrations can answer, so they are run: the same
 * keys the database applied, into an empty in-memory D1, and whatever `sqlite_master` then holds is
 * owned. Nothing is persisted and no network is reached.
 */
export async function ownedNames(provider: MigrationProvider, applied: readonly string[]): Promise<Set<string>> {
  const all = await provider.getMigrations();
  const subset: Record<string, Migration> = {};
  for (const key of applied) {
    const migration = all[key];
    if (migration !== undefined) subset[key] = migration;
  }
  // Loaded here rather than at module scope: `miniflare` costs ~290 ms to import (#482).
  const { convertV4MiniflareOptions, Miniflare } = await import("miniflare");
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({ modules: true, script: "export default {};", d1Databases: { SCRATCH: "scratch" } }),
  );
  try {
    const scratch = (await miniflare.getD1Database("SCRATCH")) as unknown as D1Database;
    await runMigrations(scratch, { getMigrations: async () => subset });
    return new Set((await readObjects(scratch)).map((row) => row.name));
  } finally {
    await miniflare.dispose();
  }
}
