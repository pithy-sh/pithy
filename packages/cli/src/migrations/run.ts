import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { composeDatabases } from "@pithy-sh/core/src/data/databases";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { parse } from "comment-json";
import type { MigrationProvider, MigrationResult } from "kysely/migration";
import { Miniflare } from "miniflare";
import { buildRegistryFromCapabilities } from "./registry";

export interface MigrateProjectOptions {
  /** The project's composed capabilities (libraries plus the app). */
  capabilities: Capability[];
  /** The project root — where wrangler.jsonc and .wrangler/ state live. */
  projectDir: string;
  /** Target environment. `dev` runs locally; staging/production land in Phase 1. */
  env: string;
  /** Step the latest applied migration back instead of running forward. */
  rollback?: boolean;
}

/** One database's migration run: which database, its binding, and what Kysely did. */
export interface DatabaseRun {
  database: string;
  binding: string;
  results: MigrationResult[];
}

/** The wrangler.jsonc slice migrate reads: local D1 ids, so state lines up with `wrangler dev`. */
interface WranglerD1Config {
  d1_databases?: { binding: string; database_name?: string; database_id?: string }[];
}

/** Map binding → persistence id from wrangler.jsonc, falling back to the binding name. */
async function persistenceIds(projectDir: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  let raw: string;
  try {
    raw = await readFile(join(projectDir, "wrangler.jsonc"), "utf8");
  } catch {
    return ids;
  }
  const config = parse(raw) as unknown as WranglerD1Config;
  for (const entry of config.d1_databases ?? []) {
    ids.set(entry.binding, entry.database_id ?? entry.database_name ?? entry.binding);
  }
  return ids;
}

/**
 * Run (or roll back) the project's migration registry — the logic behind
 * `pithy migrate`. Each database's provider runs independently against its
 * binding's D1, via Miniflare, persisted under the project's `.wrangler/state`
 * so repeated runs and `wrangler dev` share local data. Remote environments
 * execute over the D1 REST API through `@pithy-sh/cloudflare` — Phase 1.
 */
export async function migrateProject(options: MigrateProjectOptions): Promise<DatabaseRun[]> {
  if (options.env !== "dev") {
    throw new InternalError({
      message: `Can't migrate "${options.env}" yet. Remote migrate lands in Phase 1.`,
      action: "Run pithy migrate --env dev.",
    });
  }

  const registry = buildRegistryFromCapabilities(options.capabilities);
  const databases = composeDatabases(options.capabilities);
  const entries = Object.entries(registry);
  if (entries.length === 0) return [];

  // Resolve each database to its binding once: confirm a capability declares it,
  // and reject two databases sharing one binding (they would migrate against a
  // single physical D1 store, colliding on data and Kysely bookkeeping).
  const ids = await persistenceIds(options.projectDir);
  const plan: { database: string; provider: MigrationProvider; binding: string }[] = [];
  const bindings: Record<string, string> = {};
  const bindingOwner = new Map<string, string>();
  for (const [database, provider] of entries) {
    const group = databases[database];
    if (!group) {
      throw new InternalError({
        message: `Database "${database}" has migrations but no capability declares it.`,
        action: "Declare the database (binding and tables) in a capability. Run pithy migrate again.",
      });
    }
    const owner = bindingOwner.get(group.binding);
    if (owner) {
      throw new InternalError({
        message: `Databases "${owner}" and "${database}" are both bound to "${group.binding}".`,
        action: "Give each database its own binding. Run pithy migrate again.",
      });
    }
    bindingOwner.set(group.binding, database);
    bindings[group.binding] = ids.get(group.binding) ?? group.binding;
    plan.push({ database, provider, binding: group.binding });
  }

  // The same local D1 store `wrangler dev` uses. Miniflare needs a script even
  // though no request ever runs — migrations go through the D1 bindings alone.
  const miniflare = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: bindings,
    d1Persist: join(options.projectDir, ".wrangler", "state", "v3", "d1"),
  });

  try {
    const runs: DatabaseRun[] = [];
    for (const { database, provider, binding } of plan) {
      const d1 = (await miniflare.getD1Database(binding)) as unknown as D1Database;
      const results = options.rollback ? await rollbackMigration(d1, provider) : await runMigrations(d1, provider);
      runs.push({ database, binding, results });
    }
    return runs;
  } finally {
    await miniflare.dispose();
  }
}
