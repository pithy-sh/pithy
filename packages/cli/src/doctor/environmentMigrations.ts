// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { MigrationTarget } from "@pithy-sh/core/src/migrations/runner";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { ReadLedger } from "../capabilities/reconcile";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { localDevStorePath } from "../devSecrets/store";
import { NeighborsNotComposed, type ProjectLedger, readProjectLedger, unprovisionedDatabases } from "../migrations/run";
import { composeFor } from "../project/composeFor";
import { allCapabilities, type WorkerConfig } from "../project/config";

/**
 * **One environment's migration state, answered for that environment and no other.**
 *
 * Doctor sweeps every environment rather than taking a flag, as its secret checks do: `dev`, and every one
 * the root `pithy.config.ts` declares. Each is answered here, and each answer is one of five things that are
 * true of that environment:
 *
 * 1. **`checked`** — composed for it, its databases resolved, and its ledger read. The ledger carries its
 *    own `read`, `partial` and `unavailable`, because a read can come up short.
 * 2. **`not-composed`** — its `pithy.config.ts` threw when evaluated for it, or another Worker's did, whose
 *    databases this one's may share. There is no migration set to compare, so nothing is read, and never
 *    the set of the Workers that did compose: a shared database's ledger holds the missing Worker's rows,
 *    which would read as undeclared. What it threw is `Environment configs:`'s line, not this one's.
 * 3. **`not-provisioned`** — the databases it migrates have no `database_id` in its stanza. Read from files,
 *    so it is true offline too. Never a count: there is nothing there to count against.
 * 4. **`not-set-up`** — `dev` only: the Worker migrates a database and the checkout holds no local store at
 *    all, as a fresh clone and a CI runner do. Nothing is read, because opening Miniflare would create the
 *    store and the next run would count every migration as pending. It reports, and `pithy setup` is its fix.
 * 5. **`skipped`** — a deployed read that was not attempted, because the run is offline or holds no
 *    Cloudflare credentials. Said, so a missing line is never mistaken for a clean one.
 *
 * **Composed for the environment, and read for it, by one function.** {@link environmentMigrations} is
 * where every {@link EnvironmentMigrations} is made. It composes through `composeFor`, so the config
 * is evaluated under that environment's `ENVIRONMENT`, and the ledger seam it calls is handed that
 * same environment and that same composition. Nothing falls back: an environment that cannot be answered
 * says which state it is in, and never borrows a neighbor's number.
 */

/** Why a deployed environment's ledger was not read. */
export type RemoteSkip = "offline" | "no-credentials";

/** One environment's migration state for one Worker — see the module docblock for the five states. */
export type EnvironmentMigrations =
  | {
      /** The environment this answer is about, and the only one it was taken from. */
      env: string;
      /** Composed for `env` and its ledger read. */
      state: "checked";
      /** What `env`'s databases hold against what `env`'s composition declares. */
      ledger: ProjectLedger;
    }
  | {
      /** The environment this answer is about. */
      env: string;
      /** This Worker's `pithy.config.ts` threw when evaluated for `env`, so nothing was read. */
      state: "not-composed";
    }
  | {
      /** The environment this answer is about. */
      env: string;
      /** The databases `env` migrates have no database to migrate. */
      state: "not-provisioned";
      /** Each database with no `database_id` in `env`'s stanza. Non-empty. */
      unprovisioned: MigrationTarget[];
    }
  | {
      /** The environment this answer is about: always `dev`. */
      env: string;
      /** The Worker migrates a database and the checkout holds no local store, so nothing was read. */
      state: "not-set-up";
    }
  | {
      /** The environment this answer is about. */
      env: string;
      /** A deployed read that was not attempted. */
      state: "skipped";
      /** Why it was not. */
      reason: RemoteSkip;
    };

/** The Worker an environment's migrations are answered for. */
export interface MigrationWorker {
  /** The Worker's name, as the migration ledger identifies it. */
  name: string;
  /** The Worker's directory — its `pithy.config.ts` and `wrangler.jsonc`. */
  dir: string;
}

/** One Worker as composed for one environment: its capabilities, and the config object they came from. */
export interface WorkerComposition {
  /** Every capability the config composes for the environment. */
  capabilities: Capability[];
  /**
   * The config itself, as evaluated for the environment. A plan reads `declinedBindings` and
   * `pinnedBindings` off it. Optional because the seam is a test's: a double with no config is a Worker
   * that declines nothing.
   */
  config?: WorkerConfig;
}

/**
 * Compose one Worker for one environment: its capabilities and config, as its `pithy.config.ts` evaluates
 * under that environment's `ENVIRONMENT`. Throws when the config does.
 */
export type ComposeWorker = (worker: MigrationWorker, env: string) => Promise<WorkerComposition>;

/** The default composition: the Worker's own config, loaded through `composeFor` for `env`. */
export const composeWorkerFor: ComposeWorker = (worker, env) =>
  composeFor(env, async (load) => {
    const config = await load(worker.dir);
    return { capabilities: allCapabilities(config), config };
  });

/** Options for {@link environmentMigrations}. */
export interface EnvironmentMigrationsOptions {
  /** The project root — where the local D1 store lives. */
  projectDir: string;
  /** The Worker whose migrations are answered. */
  worker: MigrationWorker;
  /** The environment to answer for. */
  env: string;
  /** The Cloudflare account this project belongs to, or `null` when it names none. */
  account: CloudflareAccountSelection | null;
  /**
   * Why a deployed read will not be attempted this run, or `null` when it will. Never consulted for `dev`,
   * whose store is local and needs neither a network nor an account.
   */
  remoteSkip: RemoteSkip | null;
  /**
   * Whether the checkout holds a local D1 store at all. Only consulted for `dev`. Defaults to whether
   * {@link localDevStorePath} exists; `pithy doctor` decides it once, before any of its reads can create it.
   */
  localStore?: boolean;
  /** Composition seam. Defaults to {@link composeWorkerFor}. */
  compose?: ComposeWorker;
  /** Ledger seam. Defaults to {@link readProjectLedger} over this one Worker. */
  readLedger?: ReadLedger;
}

/** Whether any capability declares migrations for a database: what a local store would have to hold. */
function migratesADatabase(capabilities: readonly Capability[]): boolean {
  return capabilities.some((capability) =>
    Object.values(capability.databases ?? {}).some((spec) => spec.migrations !== undefined),
  );
}

/** The default ledger read: the migration fan-out over this one Worker. */
const defaultReadLedger: ReadLedger = (scope) =>
  readProjectLedger({
    projectDir: scope.projectDir,
    env: scope.env,
    account: scope.account,
    workers: [{ name: scope.worker, dir: scope.workerDir, capabilities: scope.capabilities }],
  });

/**
 * Answer one environment's migration state for one Worker. **Never throws**: it is a report's contributor,
 * and every way it can fail is one of the states above.
 *
 * The order is the cheapest honest one. Composition first, because every later step needs to know which
 * databases this environment migrates. Provisioning second, from files, so an unprovisioned environment
 * reads as such offline too. A local store that does not exist third, and the skip fourth, before anything
 * reaches for a database. The read last.
 */
export async function environmentMigrations(options: EnvironmentMigrationsOptions): Promise<EnvironmentMigrations> {
  const { env, worker } = options;
  let capabilities: Capability[];
  try {
    ({ capabilities } = await (options.compose ?? composeWorkerFor)(worker, env));
  } catch {
    // What the config threw is the adopter's code talking, and `Environment configs:` prints it. This line's
    // job is only to not print a count.
    return { env, state: "not-composed" };
  }

  const scope = { name: worker.name, dir: worker.dir, capabilities };
  let unprovisioned: MigrationTarget[];
  try {
    unprovisioned = await unprovisionedDatabases(env, [scope]);
  } catch {
    // A migration set that will not group — two databases on one binding — is not a provisioning answer.
    // The read below meets the same refusal and reports it as a ledger nobody could read.
    unprovisioned = [];
  }
  if (unprovisioned.length > 0) return { env, state: "not-provisioned", unprovisioned };

  if (
    env === LOCAL_ENVIRONMENT &&
    migratesADatabase(capabilities) &&
    !(options.localStore ?? existsSync(localDevStorePath(options.projectDir)))
  )
    return { env, state: "not-set-up" };

  if (env !== LOCAL_ENVIRONMENT && options.remoteSkip !== null)
    return { env, state: "skipped", reason: options.remoteSkip };

  let ledger: ProjectLedger;
  try {
    ledger = await (options.readLedger ?? defaultReadLedger)({
      projectDir: options.projectDir,
      workerDir: worker.dir,
      worker: worker.name,
      env,
      account: options.account,
      capabilities,
    });
  } catch (error) {
    // A Worker beside this one did not compose for `env`, so nothing was read: the same answer as this
    // Worker's own config throwing, and not "no database answered".
    if (error instanceof NeighborsNotComposed) return { env, state: "not-composed" };
    // The guard keeps nothing else of what it caught: a D1 read throws with ids and queries in it.
    ledger = { state: "unavailable" };
  }
  return { env, state: "checked", ledger };
}
