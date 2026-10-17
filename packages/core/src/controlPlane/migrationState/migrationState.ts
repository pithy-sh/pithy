// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { MigrationProvider } from "kysely/migration";
import type { Capability } from "../../capability/capability";
import { composeDatabases } from "../../data/databases";
import { InternalError } from "../../error/pithyError";
import { collectMigrationSets } from "../../migrations/capabilitySets";
import { composedMigrationKey, createMigrationRegistry, decomposeMigrationKey } from "../../migrations/registry";
import { readMigrationLedger } from "../../migrations/runner";
import { type MigrationLastGroup, readMigrationState } from "../../migrations/state";
import type { CapabilityHealthInput } from "../discovery/health";
import type { HealthSummary } from "../discovery/healthSummary";
import type { MigrationDatabaseView, MigrationGroupView, MigrationView } from "../http/responses";
import { MIGRATIONS_READ_SCOPE } from "../scope/scope";

/**
 * **Migration state over the control plane (#729).**
 *
 * A management client could not answer what is applied where, or whether a deploy left something behind:
 * the seam registered a ping, the manifest and key rotation, and not one field of it was about a database.
 * The read already existed — {@link readMigrationLedger} answers both directions — and it needs a D1
 * binding and the composed provider in one process. **The Worker is the only thing holding both**, and it
 * is the deployed build, so asked from its side the answer cannot be stale the way the project on disk is.
 *
 * Two halves. At assembly, {@link composeMigrationDatabases} builds what this Worker declares per bound
 * database, through `collectMigrationSets` — the function `pithy migrate` composes with, so the route and
 * `pithy doctor` cannot disagree about one environment. Per request, {@link readDatabaseMigrations} reads
 * one database for the route and {@link readMigrationHealth} totals all of them for the manifest.
 *
 * **Read-only.** Nothing here runs, reverses or resets a migration. A screen somebody opened to ask must
 * not hand them the thing that changes the schema.
 *
 * **`undeclared` is relative to this Worker.** Two Workers can be bound to one physical D1, and the CLI
 * composes across all of them. A Worker composes only its own capabilities and cannot learn a co-bound
 * Worker's, so from inside one, every migration the other shipped to the shared database reads as
 * undeclared. That is why `undeclaredMigrations` grades nothing.
 */

/** One database this Worker binds, with what this build declares for it. Built once, at assembly. */
export interface ComposedMigrationDatabase {
  /** The database name, as capabilities declare it in `databases`. */
  database: string;
  /** The D1 binding it is read through. */
  binding: string;
  /** Every migration this build declares for it — empty for a database bound with none. */
  provider: MigrationProvider;
  /** Each declared migration's namespace, known from the set it came from. */
  namespaces: ReadonlyMap<string, string>;
}

/** A provider declaring nothing, for a database bound with no migrations: everything applied is undeclared. */
const NOTHING_DECLARED: MigrationProvider = { getMigrations: async () => ({}) };

/**
 * Every database this Worker binds, with the provider this build composes for it, sorted by name.
 *
 * One entry per database `composeDatabases` maps to a binding — the same map the request registry is built
 * from — so a database bound with no migrations is still reported. Leaving it out would read as not bound.
 */
export function composeMigrationDatabases(capabilities: readonly Capability[]): ComposedMigrationDatabase[] {
  const sets = collectMigrationSets([...capabilities]);
  const registry = createMigrationRegistry(sets);
  const bound = composeDatabases([...capabilities]);
  return Object.entries(bound)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([database, group]) => {
      const namespaces = new Map<string, string>();
      for (const set of sets) {
        if (set.database !== database) continue;
        for (const localKey of Object.keys(set.migrations))
          namespaces.set(composedMigrationKey(set, localKey), set.namespace);
      }
      return { database, binding: group.binding, provider: registry[database] ?? NOTHING_DECLARED, namespaces };
    });
}

/**
 * One migration as the route reports it.
 *
 * A declared migration's namespace comes from the set it was declared in. An undeclared one has only its
 * key, so it is decomposed — and a key no registry composed answers null rather than a guess.
 */
export function migrationView(name: string, namespaces: ReadonlyMap<string, string>): MigrationView {
  return { name, namespace: namespaces.get(name) ?? decomposeMigrationKey(name)?.namespace ?? null };
}

/** The D1 binding for `entry`, or a refusal naming it — a Worker missing the binding cannot read it. */
function bindingOf(env: Record<string, unknown>, entry: ComposedMigrationDatabase): D1Database {
  const database = env[entry.binding];
  if (database == null) {
    throw new InternalError({
      message: `The ${entry.binding} binding is missing, so database "${entry.database}" cannot be read.`,
      action: `Declare ${entry.binding} in this Worker's wrangler.jsonc, then deploy again.`,
    });
  }
  return database as D1Database;
}

function groupView(group: MigrationLastGroup, namespaces: ReadonlyMap<string, string>): MigrationGroupView {
  return {
    group: group.group,
    appliedAt: group.appliedAt.toISOString(),
    migrations: group.migrations.map((name) => migrationView(name, namespaces)),
    position:
      group.position.state === "top"
        ? { state: "top" }
        : {
            state: "buried",
            above: group.position.above,
            ungrouped: group.position.ungrouped.map((name) => migrationView(name, namespaces)),
          },
  };
}

/**
 * Read one database's migration state for the route.
 *
 * **A database that cannot be read is `unreadable`, and costs only itself.** The cause goes to
 * `onUnreadable` — the route logs it, where the operator's context stays the operator's — and never into
 * the view: a D1 error can name a table or a query, and the view crosses to a management client.
 */
export async function readDatabaseMigrations(
  env: Record<string, unknown>,
  entry: ComposedMigrationDatabase,
  onUnreadable?: (entry: ComposedMigrationDatabase, cause: unknown) => void,
): Promise<MigrationDatabaseView> {
  try {
    const state = await readMigrationState(bindingOf(env, entry), entry.provider);
    const view = (name: string) => migrationView(name, entry.namespaces);
    return {
      state: "readable",
      database: entry.database,
      binding: entry.binding,
      applied: state.applied.map(view),
      pending: state.pending.map(view),
      undeclared: state.undeclared.map(view),
      lastGroup: state.lastGroup ? groupView(state.lastGroup, entry.namespaces) : null,
    };
  } catch (cause) {
    onUnreadable?.(entry, cause);
    return { state: "unreadable", database: entry.database, binding: entry.binding };
  }
}

/**
 * The two health keys the seam contributes to its own manifest entry.
 *
 * Both `indexed`: one small select per bound database, bounded by the declared migration count rather
 * than by the adopter's data. Both behind {@link MIGRATIONS_READ_SCOPE}, which the seam's own route
 * requires, so a connection without it gets no value rather than a zero.
 *
 * **`undeclaredMigrations` declares no nominal, on purpose.** From inside one Worker, a database shared
 * with another lists the other's migrations as undeclared, so `atMost: 0` would report a corrupted chain
 * on a database that is entirely fine. Null is what a client reads as unknowable, never as healthy (#471).
 */
export const MIGRATION_HEALTH_KEYS = [
  {
    key: "pendingMigrations",
    kind: "count",
    states: null,
    scope: MIGRATIONS_READ_SCOPE,
    cost: "indexed",
    summary: "Migrations this build declares that a bound database has not applied.",
    nominal: { atMost: 0 },
  },
  {
    key: "undeclaredMigrations",
    kind: "count",
    states: null,
    scope: MIGRATIONS_READ_SCOPE,
    cost: "indexed",
    summary:
      "Migrations a bound database holds that this Worker does not declare. Relative to this Worker: a database shared with another lists that Worker's migrations here.",
    nominal: null,
  },
] as const satisfies CapabilityHealthInput["keys"];

/**
 * Total pending and undeclared across every bound database, for the manifest.
 *
 * **Throws rather than total a database it could not read.** A partial total is a zero for the database
 * nobody read. The seam catches the throw and reports the summary `unavailable`, which a client reads as
 * unknown — null is never zero.
 */
export async function readMigrationHealth(
  env: Record<string, unknown>,
  databases: readonly ComposedMigrationDatabase[],
): Promise<HealthSummary> {
  const ledgers = await Promise.all(
    databases.map((entry) => readMigrationLedger(bindingOf(env, entry), entry.provider)),
  );
  return {
    pendingMigrations: ledgers.reduce((total, ledger) => total + ledger.pending.length, 0),
    undeclaredMigrations: ledgers.reduce((total, ledger) => total + ledger.undeclared.length, 0),
  };
}
