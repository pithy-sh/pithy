import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { composeDatabases } from "@pithy-sh/core/src/data/databases";
import { InternalError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry, type NamespacedMigrations } from "@pithy-sh/core/src/migrations/registry";
import {
  dropMigrations,
  pendingMigrations,
  resetMigrations,
  rollbackMigration,
  runMigrations,
} from "@pithy-sh/core/src/migrations/runner";
import { parse } from "comment-json";
import type { Migration, MigrationProvider, MigrationResult } from "kysely/migration";
import { Miniflare } from "miniflare";
import { resolveWorkers } from "../project/workerScope";
import { collectMigrationSets } from "./registry";

/**
 * `pithy migrate` fans out over Workers. There is no root Worker: every Worker lives in `apps/<name>/`
 * with its own `pithy.config.ts` (its capabilities) and its own `wrangler.jsonc` (its bindings), so a
 * migration run is one pass per Worker over that Worker's own registry.
 *
 * Two things follow from Workers sharing resources **by binding name**:
 *
 *  - **Bindings are per-Worker, local state is per-project.** Each Worker's D1 bindings come from its own
 *    `wrangler.jsonc`, but the local Miniflare store stays at `<projectRoot>/.wrangler/state` — the one
 *    `wrangler dev` uses. Giving each Worker its own persistence directory would silently hand two Workers
 *    that both declare `DB` two different local databases.
 *  - **A shared database migrates once.** Workers whose entries resolve to the same D1 are grouped, their
 *    migration sets merged into one ordered provider, and that provider runs a single time. Each result is
 *    then credited back to the Worker whose capability declared it, so the report and `--json` stay truthful.
 */

/**
 * Build the remote D1 for a binding — the REST-backed `D1Database` `pithy migrate --env staging`
 * runs against. Injectable so tests substitute an in-memory D1 for the network client (issue #24's
 * `CloudflareD1Manager` is tested separately).
 */
export type RemoteD1Factory = (args: { binding: string; databaseId: string }) => D1Database;

/**
 * One Worker in a fan-out: its name, its directory (where its `wrangler.jsonc` lives), and the
 * capabilities its own `pithy.config.ts` composes. `ResolvedWorker` satisfies this structurally, so a
 * caller that already resolved the set passes it straight through.
 */
export interface WorkerScope {
  /** The Worker's name — its `wrangler.jsonc` name, else its `apps/<dir>` basename. */
  name: string;
  /** The Worker's directory: its `wrangler.jsonc` supplies the D1 bindings and their ids. */
  dir: string;
  /** The capabilities that Worker composes, libraries first and its app last. */
  capabilities: Capability[];
}

/** The fan-out options every project-scoped migration entry point shares. */
export interface MigrateProjectOptions {
  /**
   * The project root — the parent of `apps/`, and the owner of the `.wrangler/state` store every
   * Worker's local D1 lives in.
   */
  projectDir: string;
  /** Target environment. `dev` runs locally via Miniflare; staging/production run over the D1 REST API. */
  env: string;
  /** Narrow the fan-out to one Worker, by its name or its `apps/<dir>` basename. */
  worker?: string;
  /** Step the latest applied migration back instead of running forward. */
  rollback?: boolean;
  /** Test seam: build the remote D1 for a binding instead of the default REST-backed client. */
  remoteD1?: RemoteD1Factory;
  /**
   * The Workers to run against, already resolved. Skips `apps/` discovery for the run's **scope** — for a
   * caller that resolved the set itself (`pithy add` hands over the one Worker it just wired), and for
   * tests, whose fixture Workers carry no importable `pithy.config.ts`. The project is still discovered
   * behind it, best effort, so a database one of these Workers shares with another migrates as a whole;
   * what is reported and applied stays exactly this set.
   */
  workers?: WorkerScope[];
}

/** A reset never rolls back — it rolls *everything* back, then reapplies everything. */
export type ResetProjectOptions = Omit<MigrateProjectOptions, "rollback">;

/** One database's migration run: which database, its binding, and what Kysely did. */
export interface DatabaseRun {
  /** The database name (a capability's `databases` key). */
  database: string;
  /** The D1 binding it resolves to in this Worker's `wrangler.jsonc`. */
  binding: string;
  /**
   * The migrations this Worker's capabilities contributed, and how each fared. A shared database always
   * migrates as a whole — a run narrowed to one Worker still applies what the Workers it shares with
   * contributed — but every result is credited to the Worker that declared it, so a row never claims a
   * migration its own capabilities do not own.
   */
  results: MigrationResult[];
  /**
   * The other Workers bound to this same physical D1. Present only when a database is shared: the
   * merged registry ran once for all of them, and each Worker is credited with its own migrations.
   */
  sharedWith?: string[];
}

/** One Worker's slice of a fan-out run: the Worker, and each database its registry touched. */
export interface WorkerMigrationRun {
  /** The Worker's name. */
  worker: string;
  /** Its databases, in registry order. Empty when the Worker composes no migrations. */
  databases: DatabaseRun[];
}

/** One Worker's claim on one database: the sets it contributes, and the binding it declares. */
interface WorkerPlanEntry {
  /** The Worker's name. */
  worker: string;
  /** The database name this Worker knows it by. */
  database: string;
  /** The D1 binding in this Worker's `wrangler.jsonc`. */
  binding: string;
  /** This Worker's migration sets for that database. */
  sets: NamespacedMigrations[];
}

/** One physical D1 and everything that migrates into it — the unit a run actually executes. */
interface DatabaseGroup {
  /** The resolved D1 identity every entry shares: locally the binding/name fallback, remotely the `database_id`. */
  id: string;
  /** The first entry's database name — the group's label in the report. */
  database: string;
  /** The first entry's binding — the group's label, and what the remote factory is told. */
  binding: string;
  /** The remote `database_id`, when the target env's stanza declares one. */
  databaseId?: string;
  /** Every Worker claim on this database, in Worker order. */
  entries: WorkerPlanEntry[];
  /** The merged, ordered provider — every contributing Worker's sets in one registry. */
  provider: MigrationProvider;
  /** Composed migration name → the Worker credited with it. */
  owners: Map<string, string>;
}

/** A resolved set of D1s to migrate — the only thing that differs between local and remote — plus teardown. */
interface MigrationDriver {
  /** The D1 for a group; every group is resolved before the run loop reads it. */
  database(group: DatabaseGroup): D1Database;
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

/** Read and parse a Worker's wrangler.jsonc (comments allowed). A missing file yields an empty config. */
async function readWranglerConfig(workerDir: string): Promise<WranglerD1Config> {
  try {
    const raw = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");
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
 * One Worker's claims: every database it has migrations for, resolved to the binding its own
 * capabilities declare. Rejects two databases sharing one binding within a Worker (they would migrate
 * against a single physical D1 store, colliding on data and migration bookkeeping) — that is a wiring
 * mistake, unlike two *Workers* sharing a binding, which is how they share a resource.
 */
function buildPlan(worker: WorkerScope): WorkerPlanEntry[] {
  const databases = composeDatabases(worker.capabilities);
  const byDatabase = new Map<string, NamespacedMigrations[]>();
  for (const set of collectMigrationSets(worker.capabilities)) {
    const existing = byDatabase.get(set.database);
    if (existing) existing.push(set);
    else byDatabase.set(set.database, [set]);
  }

  const plan: WorkerPlanEntry[] = [];
  const bindingOwner = new Map<string, string>();
  for (const [database, sets] of byDatabase) {
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
    plan.push({ worker: worker.name, database, binding: group.binding, sets });
  }
  return plan;
}

/**
 * Whether two entries under one key are the same migration — identity, not resemblance. A capability
 * ships its migrations as module-level objects (`multiplayer_0001_results`), so composing one capability
 * into two Workers hands both the *same* object even when the capability itself is built per Worker by a
 * factory; a spread that rebuilds the record still carries the same `up`/`down`. Two capabilities that
 * merely agree on a key name do not, which is the whole point: `0001_init` is the canonical first key, so
 * a name-only test calls two unrelated migrations identical and silently drops one.
 */
function sameMigration(a: Migration, b: Migration): boolean {
  return a === b || (a.up === b.up && a.down === b.down);
}

/**
 * Whether two sets carry the same migrations — the test for "the same capability, composed twice".
 * Same order, same keys, and the same migration behind every key: anything else is two different sets
 * wearing one namespace, which the caller rejects rather than silently dropping one.
 */
function sameMigrations(a: NamespacedMigrations, b: NamespacedMigrations): boolean {
  if (a.order !== b.order) return false;
  const left = Object.keys(a.migrations).sort();
  const right = Object.keys(b.migrations).sort();
  if (left.length !== right.length) return false;
  return left.every((key, index) => {
    if (key !== right[index]) return false;
    const one = a.migrations[key];
    const two = b.migrations[key];
    return one !== undefined && two !== undefined && sameMigration(one, two);
  });
}

/**
 * Merge every contributing Worker's sets for one physical D1 into a single ordered provider, and record
 * which Worker each composed migration name belongs to.
 *
 * A namespace claimed by two Workers is the *same capability* composed into both — dedupe it, so a
 * shared database migrates once. A namespace claimed twice with **different** migrations is two
 * different capabilities wearing one name: their composed keys would collide in the ledger, so that
 * fails loudly rather than letting one silently shadow the other.
 */
async function mergeGroup(
  database: string,
  binding: string,
  entries: WorkerPlanEntry[],
): Promise<{ provider: MigrationProvider; owners: Map<string, string> }> {
  const kept = new Map<string, { set: NamespacedMigrations; worker: string }>();
  for (const entry of entries) {
    for (const set of entry.sets) {
      const prior = kept.get(set.namespace);
      if (!prior) {
        kept.set(set.namespace, { set, worker: entry.worker });
        continue;
      }
      if (sameMigrations(prior.set, set)) continue;
      throw new InternalError({
        message: `Workers "${prior.worker}" and "${entry.worker}" both migrate "${binding}" under the "${set.namespace}" namespace, with different migrations.`,
        action: "Rename one capability, or bind the workers to different databases. Run pithy migrate again.",
      });
    }
  }

  const sets = [...kept.values()].map(({ set }) => ({ ...set, database }));
  const provider = createMigrationRegistry(sets)[database] ?? { getMigrations: async () => ({}) };

  // Credit each composed name to its Worker by composing that one set through the same registry, so the
  // key format stays core's single definition rather than a copy that can drift.
  const owners = new Map<string, string>();
  for (const { set, worker } of kept.values()) {
    const single = createMigrationRegistry([{ ...set, database }])[database];
    for (const name of Object.keys((await single?.getMigrations()) ?? {})) owners.set(name, worker);
  }
  return { provider, owners };
}

/**
 * Group every Worker's claims by the physical D1 they resolve to, and merge each group's registries.
 * Grouping is by resolved id — locally the `database_id`/`database_name`/binding fallback, remotely the
 * env stanza's `database_id` — falling back to the binding name when no id is declared, since Workers
 * share a resource precisely by declaring the same binding.
 *
 * `workers` is always the **complete** set, never the run's narrowed scope: a database is migrated as a
 * whole, so every Worker bound to it must be in its group even when only one of them is being reported
 * (see {@link scopedGroups}). `scope` names the Workers the run actually targets — a Worker outside it
 * that has no stanza for a non-`dev` env has never migrated there, so it is skipped rather than failing
 * a run that never asked about it.
 */
async function buildGroups(workers: WorkerScope[], env: string, scope: Set<string>): Promise<DatabaseGroup[]> {
  const ordered: { id: string; database: string; binding: string; databaseId?: string; entries: WorkerPlanEntry[] }[] =
    [];
  const byId = new Map<string, (typeof ordered)[number]>();

  for (const worker of workers) {
    const plan = buildPlan(worker);
    if (plan.length === 0) continue;
    const config = await readWranglerConfig(worker.dir);
    if (env !== "dev" && !config.env?.[env]) {
      if (!scope.has(worker.name)) continue;
      throw new ValidationError({
        message: `${worker.name}: wrangler.jsonc has no env.${env} stanza.`,
        action: `Add the ${env} environment to ${worker.name}'s wrangler.jsonc with its D1 bindings. Run pithy migrate --env ${env} again.`,
      });
    }
    const local = idsFor(config.d1_databases);
    const remote = idsFor(config.env?.[env]?.d1_databases, true);

    for (const entry of plan) {
      const databaseId = remote.get(entry.binding);
      const id = env === "dev" ? (local.get(entry.binding) ?? entry.binding) : (databaseId ?? entry.binding);
      const existing = byId.get(id);
      if (existing) {
        existing.entries.push(entry);
        continue;
      }
      const group = {
        id,
        database: entry.database,
        binding: entry.binding,
        ...(databaseId !== undefined ? { databaseId } : {}),
        entries: [entry],
      };
      byId.set(id, group);
      ordered.push(group);
    }
  }

  const groups: DatabaseGroup[] = [];
  for (const group of ordered) {
    const { provider, owners } = await mergeGroup(group.database, group.binding, group.entries);
    groups.push({ ...group, provider, owners });
  }
  return groups;
}

/**
 * The local driver: the same D1 store `wrangler dev` uses, under `<projectRoot>/.wrangler/state`, via
 * Miniflare. Persistence is deliberately project-scoped, not Worker-scoped — two Workers that declare
 * the same binding are meant to share one local database. Each group gets a synthetic Miniflare binding
 * (groups are keyed by id, and two Workers can name one id under one binding), so the persistence key
 * is the resolved id and nothing else. Miniflare needs a script even though no request runs — migrations
 * go through the D1 bindings alone.
 */
async function localDriver(persistRoot: string, groups: DatabaseGroup[]): Promise<MigrationDriver> {
  const bindings: Record<string, string> = {};
  groups.forEach((group, index) => {
    bindings[`d1_${index}`] = group.id;
  });

  const miniflare = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: bindings,
    d1Persist: join(persistRoot, ".wrangler", "state", "v3", "d1"),
  });

  const cache = new Map<string, D1Database>();
  for (const [index, group] of groups.entries()) {
    cache.set(group.id, (await miniflare.getD1Database(`d1_${index}`)) as unknown as D1Database);
  }
  return { database: (group) => databaseOf(cache, group), dispose: () => miniflare.dispose() };
}

/** The D1 for a group, or an internal error — the driver populates every group up front. */
function databaseOf(cache: Map<string, D1Database>, group: DatabaseGroup): D1Database {
  const database = cache.get(group.id);
  if (!database) throw new InternalError({ detail: `No D1 resolved for binding "${group.binding}".` });
  return database;
}

/**
 * Build the default REST-backed D1 factory: read CF creds from the environment (the project root's
 * `.dev.vars` — one shared file for the whole repo — then `process.env`) and back each binding with a
 * `@pithy-sh/cloudflare` D1 client (a shared client memoizes managers by database id). Only ever called
 * for the real REST path; an injected `override` replaces it wholesale.
 */
function defaultRemoteD1(persistRoot: string, env: string): RemoteD1Factory {
  const vars = loadCloudflareEnv(persistRoot);
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
  const clients = new CloudflareClients({ accountId, apiToken });
  return ({ databaseId }) => clients.d1(databaseId) as unknown as D1Database;
}

/**
 * The remote driver: the same migration registries, executed over the D1 REST API through
 * `@pithy-sh/cloudflare`. Each group's remote id comes from the owning Worker's `wrangler.jsonc` env
 * block. The REST-backed D1 is the *only* thing that differs from local; the registries, ordering, and
 * per-database runs are shared. An injected `override` — a test's in-memory D1 — replaces the REST
 * client wholesale, so credentials are demanded only for the real path (mirrors the seed driver, which
 * is likewise credential-lazy): substituting the network client must never require ambient CF creds.
 */
function remoteDriver(
  persistRoot: string,
  env: string,
  groups: DatabaseGroup[],
  override?: RemoteD1Factory,
): MigrationDriver {
  // Build the REST-backed D1 per binding; the default reaches for creds, an override bypasses them.
  const resolveD1: RemoteD1Factory = override ?? defaultRemoteD1(persistRoot, env);

  const cache = new Map<string, D1Database>();
  for (const group of groups) {
    if (!group.databaseId) {
      throw new ValidationError({
        message: `wrangler.jsonc env.${env} has no database_id for the "${group.binding}" binding.`,
        action: `Provision the ${env} D1 and set its id on ${group.binding}. Run pithy migrate --env ${env} again.`,
      });
    }
    cache.set(group.id, resolveD1({ binding: group.binding, databaseId: group.databaseId }));
  }
  return { database: (group) => databaseOf(cache, group), dispose: async () => {} };
}

/** Everything a run needs once the Workers are resolved: where state lives, and how D1 is reached. */
interface RunContext {
  /** The Workers in the fan-out, in report order — the run's scope, already narrowed by `--worker`. */
  workers: WorkerScope[];
  /**
   * Every Worker a database in scope may be shared with — the set each group's merged provider is built
   * from. It is the whole project, not the narrowed scope: the ledger of a shared D1 records both
   * Workers' migrations, so a provider covering only one of them reads as corrupted state to Kysely.
   */
  groupWorkers: WorkerScope[];
  /** The project root whose `.wrangler/state` holds the local D1 every Worker shares. */
  persistRoot: string;
  /** Target environment. */
  env: string;
  /** Test seam for the remote D1 client. */
  remoteD1?: RemoteD1Factory;
}

/** Pick the driver for the target environment: Miniflare for `dev`, the D1 REST API otherwise. */
function driverFor(context: RunContext, groups: DatabaseGroup[]): Promise<MigrationDriver> {
  return context.env === "dev"
    ? localDriver(context.persistRoot, groups)
    : Promise.resolve(remoteDriver(context.persistRoot, context.env, groups, context.remoteD1));
}

/**
 * The fan-out set: the caller's pre-resolved Workers, else discovery over `apps/`, narrowed by `worker`.
 * Exported because `pithy seed` fans out over exactly the same set, under exactly the same rules — one
 * definition of "which Workers does this command act on" for both data-plane commands.
 */
export async function resolveWorkerScopes(options: {
  /** The project root — the parent of `apps/`. */
  projectDir: string;
  /** Narrow to one Worker, by its name or its `apps/<dir>` basename. */
  worker?: string;
  /** Pre-resolved Workers, skipping `apps/` discovery. */
  workers?: WorkerScope[];
}): Promise<WorkerScope[]> {
  if (!options.workers) {
    return resolveWorkers({
      projectDir: options.projectDir,
      ...(options.worker !== undefined ? { worker: options.worker } : {}),
    });
  }
  if (options.worker === undefined) return options.workers;
  const found = options.workers.filter(
    (candidate) => candidate.name === options.worker || candidate.dir.endsWith(`/${options.worker}`),
  );
  if (found.length === 0) {
    throw new NotFoundError({
      message: `No worker named "${options.worker}".`,
      action: `Run pithy worker list to see this project's workers. Known: ${options.workers.map((w) => w.name).join(", ")}.`,
    });
  }
  return found;
}

/** An empty report row per Worker, in fan-out order — a Worker with no migrations still appears. */
function emptyReport(workers: WorkerScope[]): WorkerMigrationRun[] {
  return workers.map((worker) => ({ worker: worker.name, databases: [] }));
}

/**
 * Fold one group's run into the per-Worker report: each result goes to the Worker whose capability
 * declared it, and a database shared by several Workers names the others on every row.
 */
function record(report: WorkerMigrationRun[], group: DatabaseGroup, results: MigrationResult[]): void {
  for (const entry of group.entries) {
    const row = report.find((candidate) => candidate.worker === entry.worker);
    if (!row) continue;
    const others = group.entries.filter((other) => other.worker !== entry.worker).map((other) => other.worker);
    row.databases.push({
      database: entry.database,
      binding: entry.binding,
      results: results.filter((result) => group.owners.get(result.migrationName) === entry.worker),
      ...(others.length > 0 ? { sharedWith: others } : {}),
    });
  }
}

/**
 * The groups a run touches: every database at least one in-scope Worker claims, each carrying **every**
 * Worker bound to it. Narrowing (`--worker`, and every `pithy add`/`remove`/`upgrade --migrate`, which
 * always scope to one Worker) narrows what is reported and which databases are visited — never the
 * registry a visited database runs. A shared D1's ledger holds both Workers' migrations, so a provider
 * missing one of them is corrupted state to Kysely and the run aborts.
 */
async function scopedGroups(context: RunContext): Promise<DatabaseGroup[]> {
  const scope = new Set(context.workers.map((worker) => worker.name));
  const groups = await buildGroups(context.groupWorkers, context.env, scope);
  return groups.filter((group) => group.entries.some((entry) => scope.has(entry.worker)));
}

/** Open the driver, run `execute` per group, fold the results into a per-Worker report, and tear down. */
async function runGroups(
  context: RunContext,
  execute: (database: D1Database, provider: MigrationProvider) => Promise<MigrationResult[]>,
): Promise<WorkerMigrationRun[]> {
  const report = emptyReport(context.workers);
  const groups = await scopedGroups(context);
  if (groups.length === 0) return report;

  const driver = await driverFor(context, groups);
  try {
    for (const group of groups) {
      record(report, group, await execute(driver.database(group), group.provider));
    }
    return report;
  } finally {
    await driver.dispose();
  }
}

/**
 * Every Worker a database in scope could be shared with — the set each group's provider is merged from.
 *
 * With nothing pre-resolved that is plain `apps/` discovery, narrowed later, never here. A caller can
 * also hand over an **already narrowed** set: `pithy add`/`remove`/`upgrade --migrate` pass the single
 * Worker they just wired. A database that Worker shares still migrates as a whole, so the rest of the
 * project is discovered alongside it. Best effort by design — a project with nothing importable (a test
 * fixture, an uninstalled checkout) contributes no neighbours and the caller's set stands alone, exactly
 * as it did before.
 */
async function projectWorkers(options: MigrateProjectOptions): Promise<WorkerScope[]> {
  if (!options.workers) return resolveWorkerScopes({ projectDir: options.projectDir });

  const discovered = await resolveWorkerScopes({ projectDir: options.projectDir }).catch(() => []);
  const workers = [...options.workers];
  for (const found of discovered) {
    const known = workers.some((candidate) => resolve(candidate.dir) === resolve(found.dir));
    if (!known) workers.push(found);
  }
  return workers;
}

/**
 * Turn the public fan-out options into a run context: the whole project (what each database's registry is
 * built from) and the run's own scope (what is reported, and which databases are visited). The scope is
 * always the caller's set narrowed by `--worker`, so an unknown name still fails naming the same Workers.
 */
async function contextFor(options: MigrateProjectOptions): Promise<RunContext> {
  const groupWorkers = await projectWorkers(options);
  return {
    workers: await resolveWorkerScopes({
      projectDir: options.projectDir,
      workers: options.workers ?? groupWorkers,
      ...(options.worker !== undefined ? { worker: options.worker } : {}),
    }),
    groupWorkers,
    persistRoot: options.projectDir,
    env: options.env,
    ...(options.remoteD1 ? { remoteD1: options.remoteD1 } : {}),
  };
}

/**
 * Run (or roll back) every Worker's migration registry — the logic behind `pithy migrate`. Each Worker
 * contributes its own capabilities; Workers bound to the same physical D1 merge into one run so a shared
 * database migrates once. Locally that D1 is a Miniflare store under the project root's `.wrangler/state`
 * (shared with `wrangler dev`); for staging/production it is the remote database over the D1 REST API.
 * The registries, ordering, and per-database runs are identical — only the driver differs.
 */
export function migrateProject(options: MigrateProjectOptions): Promise<WorkerMigrationRun[]> {
  return contextFor(options).then((context) =>
    runGroups(context, (database, provider) =>
      options.rollback ? rollbackMigration(database, provider) : runMigrations(database, provider),
    ),
  );
}

/**
 * Fully reset every migrated database's schema — the seam behind `pithy seed --redo`'s destructive
 * rebuild. Runs the **same fan-out, grouping, and driver** as {@link migrateProject} but calls
 * `resetMigrations` per database instead of running or rolling back: every applied migration's `down`
 * runs (all of them, not just the latest), then every migration's `up` reapplies from empty. **This
 * destroys every row in every table the registry owns — hand-inserted data included — by design**, not
 * just the rows a seed fixture wrote. Callers gate this behind the same escalating confirmation a
 * destructive seed needs before calling it.
 */
export function resetProject(options: ResetProjectOptions): Promise<WorkerMigrationRun[]> {
  return contextFor(options).then((context) => runGroups(context, resetMigrations));
}

/** One database's place in a {@link resetProject} run: which database, its binding, and how many migrations it carries. */
export interface ResetPreviewEntry {
  /** The database being reset (matches a capability's `databases` key). */
  database: string;
  /** The D1 binding the database resolves to. */
  binding: string;
  /** The number of migrations the merged registry carries for this database — how many roll back, then reapply. */
  migrations: number;
}

/**
 * Preview a {@link resetProject}: which databases are in scope and how many migrations each carries.
 * Computed from the composed registries and each Worker's `wrangler.jsonc` alone — no backend access, no
 * credentials, nothing read or written — so it is safe to call for `pithy seed --redo --dry-run` (and to
 * compute the same numbers a real reset will produce, for the run report). One entry per physical
 * database, so a database two Workers share is previewed once, with their merged migration count.
 */
export async function previewReset(options: ResetProjectOptions): Promise<ResetPreviewEntry[]> {
  const groups = await scopedGroups(await contextFor(options));
  const preview: ResetPreviewEntry[] = [];
  for (const group of groups) {
    const migrations = await group.provider.getMigrations();
    preview.push({ database: group.database, binding: group.binding, migrations: Object.keys(migrations).length });
  }
  return preview;
}

/**
 * Count the unapplied migrations across every Worker for an environment — read-only, applying nothing.
 * It runs the same fan-out, grouping, and driver as {@link migrateProject}, so it reports against the
 * same D1s (local under the project root's `.wrangler/state`, or the remote databases over REST) migrate
 * would touch, and counts a database two Workers share once. The seam behind `pithy deploy`'s warn-only
 * "schema is behind" check.
 */
export async function countPendingMigrations(options: MigrateProjectOptions): Promise<number> {
  const context = await contextFor(options);
  const groups = await scopedGroups(context);
  if (groups.length === 0) return 0;

  const driver = await driverFor(context, groups);
  try {
    let total = 0;
    for (const group of groups) {
      total += await pendingMigrations(driver.database(group), group.provider);
    }
    return total;
  } finally {
    await driver.dispose();
  }
}

/** Options for {@link dropCapabilityTables}: the capability, the Worker it is wired into, and the env. */
export interface DropCapabilityOptions {
  /** The capability being removed, whose migrations to reverse. */
  capability: Capability;
  /** The Worker's directory — its `wrangler.jsonc` supplies the D1 bindings and their ids. */
  workerDir: string;
  /** The project root whose `.wrangler/state` holds the local D1 every Worker shares. */
  persistRoot: string;
  /** Target environment. `dev` runs locally via Miniflare; staging/production over the D1 REST API. */
  env: string;
  /** Test seam: build the remote D1 for a binding instead of the default REST-backed client. */
  remoteD1?: RemoteD1Factory;
}

/**
 * Drop a single capability's tables for an environment — the seam behind `pithy remove --drop`. It runs
 * the **same grouping and driver** as {@link migrateProject} but over just the removed capability, in
 * just the Worker it is wired into, so only that capability's migrations are reversed (via
 * {@link dropMigrations}); every other capability's tables and ledger rows are untouched — including
 * those of another Worker sharing the same physical D1. Runs before the capability is
 * unwired/uninstalled, while its `down` code is still present.
 */
export async function dropCapabilityTables(options: DropCapabilityOptions): Promise<DatabaseRun[]> {
  const worker: WorkerScope = {
    name: options.capability.name,
    dir: options.workerDir,
    capabilities: [options.capability],
  };
  const context: RunContext = {
    workers: [worker],
    // Deliberately just this capability: `dropMigrations` reverses the provider's own migrations
    // directly, never through Kysely's stepwise `Migrator`, so a partial registry is the point — every
    // other capability's tables and ledger rows, on this D1 or a Worker sharing it, stay untouched.
    groupWorkers: [worker],
    persistRoot: options.persistRoot,
    env: options.env,
    ...(options.remoteD1 ? { remoteD1: options.remoteD1 } : {}),
  };
  const [run] = await runGroups(context, dropMigrations);
  return run?.databases ?? [];
}
