import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { composeDatabases } from "@pithy-sh/core/src/data/databases";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import {
  dropMigrations,
  pendingMigrations,
  rollbackMigration,
  runMigrations,
} from "@pithy-sh/core/src/migrations/runner";
import { parse } from "comment-json";
import type { MigrationProvider, MigrationResult } from "kysely/migration";
import { Miniflare } from "miniflare";
import { buildRegistryFromCapabilities } from "./registry";

/**
 * Build the remote D1 for a binding — the REST-backed `D1Database` `pithy migrate --env staging`
 * runs against. Injectable so tests substitute an in-memory D1 for the network client (issue #24's
 * `CloudflareD1Manager` is tested separately).
 */
export type RemoteD1Factory = (args: { binding: string; databaseId: string }) => D1Database;

export interface MigrateProjectOptions {
  /** The project's composed capabilities (libraries plus the app). */
  capabilities: Capability[];
  /** The project root — where wrangler.jsonc and .wrangler/ state live. */
  projectDir: string;
  /** Target environment. `dev` runs locally via Miniflare; staging/production run over the D1 REST API. */
  env: string;
  /** Step the latest applied migration back instead of running forward. */
  rollback?: boolean;
  /** Test seam: build the remote D1 for a binding instead of the default REST-backed client. */
  remoteD1?: RemoteD1Factory;
}

/** One database's migration run: which database, its binding, and what Kysely did. */
export interface DatabaseRun {
  database: string;
  binding: string;
  results: MigrationResult[];
}

/** One database's place in the run: its provider and the binding whose D1 it migrates. */
interface PlanEntry {
  database: string;
  provider: MigrationProvider;
  binding: string;
}

/** A resolved set of D1s to migrate — the only thing that differs between local and remote — plus teardown. */
interface MigrationDriver {
  /** The D1 for a binding; every binding in the plan is resolved before the run loop reads it. */
  database(binding: string): D1Database;
  /** Release the driver's resources (Miniflare instance locally; a no-op remotely). */
  dispose(): Promise<void>;
}

/** One D1 binding entry in wrangler.jsonc — the fields migrate reads to resolve a database's id. */
interface D1Binding {
  binding: string;
  database_name?: string;
  database_id?: string;
}

/** The wrangler.jsonc slice migrate reads: the local (top-level) bindings and each env's bindings. */
interface WranglerD1Config {
  d1_databases?: D1Binding[];
  env?: Record<string, { d1_databases?: D1Binding[] } | undefined>;
}

/** Read and parse wrangler.jsonc (comments allowed). A missing file yields an empty config. */
async function readWranglerConfig(projectDir: string): Promise<WranglerD1Config> {
  try {
    const raw = await readFile(join(projectDir, "wrangler.jsonc"), "utf8");
    return parse(raw) as unknown as WranglerD1Config;
  } catch {
    return {};
  }
}

/**
 * Map binding → id from a set of D1 entries. Locally an id can fall back to the database name or the
 * binding (Miniflare only needs a stable persistence key); remotely (`idOnly`) only a real
 * `database_id` counts, so a binding with none is caught as an actionable error, not run against the
 * wrong database.
 */
function idsFor(entries: D1Binding[] | undefined, idOnly = false): Map<string, string> {
  const ids = new Map<string, string>();
  for (const entry of entries ?? []) {
    const value = idOnly ? entry.database_id : (entry.database_id ?? entry.database_name ?? entry.binding);
    if (value) ids.set(entry.binding, value);
  }
  return ids;
}

/**
 * Resolve every database to its binding once: confirm a capability declares it, and reject two
 * databases sharing one binding (they would migrate against a single physical D1 store, colliding on
 * data and migration bookkeeping). Env-independent — local and remote share this plan.
 */
function buildPlan(capabilities: Capability[]): PlanEntry[] {
  const registry = buildRegistryFromCapabilities(capabilities);
  const databases = composeDatabases(capabilities);
  const plan: PlanEntry[] = [];
  const bindingOwner = new Map<string, string>();
  for (const [database, provider] of Object.entries(registry)) {
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
    plan.push({ database, provider, binding: group.binding });
  }
  return plan;
}

/** The D1 for a binding, or an internal error — the driver populates every plan binding up front. */
function databaseOf(cache: Map<string, D1Database>, binding: string): D1Database {
  const database = cache.get(binding);
  if (!database) throw new InternalError({ detail: `No D1 resolved for binding "${binding}".` });
  return database;
}

/**
 * The local driver: the same D1 store `wrangler dev` uses, under `.wrangler/state`, via Miniflare.
 * Miniflare needs a script even though no request runs — migrations go through the D1 bindings alone.
 */
async function localDriver(projectDir: string, plan: PlanEntry[]): Promise<MigrationDriver> {
  const config = await readWranglerConfig(projectDir);
  const ids = idsFor(config.d1_databases);
  const bindings: Record<string, string> = {};
  for (const { binding } of plan) bindings[binding] = ids.get(binding) ?? binding;

  const miniflare = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: bindings,
    d1Persist: join(projectDir, ".wrangler", "state", "v3", "d1"),
  });

  const cache = new Map<string, D1Database>();
  for (const { binding } of plan) {
    cache.set(binding, (await miniflare.getD1Database(binding)) as unknown as D1Database);
  }
  return { database: (binding) => databaseOf(cache, binding), dispose: () => miniflare.dispose() };
}

/**
 * The remote driver: the same migration registry, executed over the D1 REST API through
 * `@pithy-sh/cloudflare`. Each database's remote id comes from the target env's `wrangler.jsonc`
 * block; CF creds come from the environment (`.dev.vars` then `process.env`) — the bootstrap token
 * now, a scoped minted token once #32 lands. The REST-backed D1 is the *only* thing that differs
 * from local; the registry, ordering, and per-database runs are shared.
 */
async function remoteDriver(
  projectDir: string,
  env: string,
  plan: PlanEntry[],
  override?: RemoteD1Factory,
): Promise<MigrationDriver> {
  const vars = loadCloudflareEnv(projectDir);
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  // The active CF token: the bootstrap token locally, or the least-privilege `ci-system` token in CI
  // (an operator mints it with `pithy token mint ci-system` and sets it as CI's CLOUDFLARE_API_TOKEN).
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) {
    throw new ValidationError({
      message: "Cloudflare credentials are missing.",
      action: `Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to migrate --env ${env}.`,
    });
  }

  const config = await readWranglerConfig(projectDir);
  const stanza = config.env?.[env];
  if (!stanza) {
    throw new ValidationError({
      message: `wrangler.jsonc has no env.${env} stanza.`,
      action: `Add the ${env} environment to wrangler.jsonc with its D1 bindings. Run pithy migrate --env ${env} again.`,
    });
  }

  // Build the REST-backed D1 lazily per binding; a shared client memoizes managers by database id.
  const clients = new CloudflareClients({ accountId, apiToken });
  const resolveD1: RemoteD1Factory = override ?? (({ databaseId }) => clients.d1(databaseId) as unknown as D1Database);

  const ids = idsFor(stanza.d1_databases, true);
  const cache = new Map<string, D1Database>();
  for (const { binding } of plan) {
    const databaseId = ids.get(binding);
    if (!databaseId) {
      throw new ValidationError({
        message: `wrangler.jsonc env.${env} has no database_id for the "${binding}" binding.`,
        action: `Provision the ${env} D1 and set its id on ${binding}. Run pithy migrate --env ${env} again.`,
      });
    }
    cache.set(binding, resolveD1({ binding, databaseId }));
  }
  return { database: (binding) => databaseOf(cache, binding), dispose: async () => {} };
}

/** Pick the driver for the target environment: Miniflare for `dev`, the D1 REST API otherwise. */
function driverFor(options: MigrateProjectOptions, plan: PlanEntry[]): Promise<MigrationDriver> {
  return options.env === "dev"
    ? localDriver(options.projectDir, plan)
    : remoteDriver(options.projectDir, options.env, plan, options.remoteD1);
}

/**
 * Run (or roll back) the project's migration registry — the logic behind `pithy migrate`. Each
 * database's provider runs independently against its binding's D1. Locally that D1 is a Miniflare
 * store under `.wrangler/state` (shared with `wrangler dev`); for staging/production it is the remote
 * database over the D1 REST API. The registry, ordering, and per-database runs are identical — only
 * the driver differs.
 */
export async function migrateProject(options: MigrateProjectOptions): Promise<DatabaseRun[]> {
  const plan = buildPlan(options.capabilities);
  if (plan.length === 0) return [];

  const driver = await driverFor(options, plan);
  try {
    const runs: DatabaseRun[] = [];
    for (const { database, provider, binding } of plan) {
      const d1 = driver.database(binding);
      const results = options.rollback ? await rollbackMigration(d1, provider) : await runMigrations(d1, provider);
      runs.push({ database, binding, results });
    }
    return runs;
  } finally {
    await driver.dispose();
  }
}

/** Options for {@link dropCapabilityTables}: the capability to drop, the project, and the target env. */
export interface DropCapabilityOptions {
  /** The capability being removed, whose migrations to reverse. */
  capability: Capability;
  /** The project root — where wrangler.jsonc and .wrangler/ state live. */
  projectDir: string;
  /** Target environment. `dev` runs locally via Miniflare; staging/production over the D1 REST API. */
  env: string;
  /** Test seam: build the remote D1 for a binding instead of the default REST-backed client. */
  remoteD1?: RemoteD1Factory;
}

/**
 * Drop a single capability's tables for an environment — the seam behind `pithy remove --drop`. It
 * runs the **same plan and driver** as {@link migrateProject} but over just the removed capability, so
 * only that capability's migrations are reversed (via {@link dropMigrations}); every other capability's
 * tables and ledger rows are untouched. Runs before the capability is unwired/uninstalled, while its
 * `down` code is still present.
 */
export async function dropCapabilityTables(options: DropCapabilityOptions): Promise<DatabaseRun[]> {
  const plan = buildPlan([options.capability]);
  if (plan.length === 0) return [];

  const driver = await driverFor(
    {
      capabilities: [options.capability],
      projectDir: options.projectDir,
      env: options.env,
      remoteD1: options.remoteD1,
    },
    plan,
  );
  try {
    const runs: DatabaseRun[] = [];
    for (const { database, provider, binding } of plan) {
      runs.push({ database, binding, results: await dropMigrations(driver.database(binding), provider) });
    }
    return runs;
  } finally {
    await driver.dispose();
  }
}

/**
 * Count the project's unapplied migrations for an environment — read-only, applying nothing. It runs
 * the same plan and driver as {@link migrateProject}, so it reports against the same D1 (local under
 * `.wrangler/state`, or the remote database over REST) migrate would touch. The seam behind
 * `pithy deploy`'s warn-only "schema is behind" check.
 */
export async function countPendingMigrations(options: MigrateProjectOptions): Promise<number> {
  const plan = buildPlan(options.capabilities);
  if (plan.length === 0) return 0;

  const driver = await driverFor(options, plan);
  try {
    let total = 0;
    for (const { provider, binding } of plan) {
      total += await pendingMigrations(driver.database(binding), provider);
    }
    return total;
  } finally {
    await driver.dispose();
  }
}
