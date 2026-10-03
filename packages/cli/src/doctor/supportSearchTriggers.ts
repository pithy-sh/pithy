// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareCredentials } from "../cloudflare/config";
import { kitImport } from "../project/kitResolve";
import { readWranglerConfig } from "../project/wrangler";
import type { RemoteSkip } from "./environmentMigrations";

/**
 * **Where is `pithy_support_search` provisioned with nothing maintaining it?**
 *
 * `@pithy-sh/support` used to write its FTS5 index from application code — three hand-written
 * `indexMessage` calls, one per message write path, each best-effort. The index is maintained by
 * triggers now, created beside the virtual table by `pithy support provision` (they cannot be a
 * migration: composing one conditionally on `search.fts` is what Kysely reads as ledger corruption).
 *
 * That leaves exactly one gap, and it is an upgrade gap. An adopter who takes the release and deploys
 * **without** re-running `pithy support provision` has a deployed Worker whose write paths no longer
 * index anything and a database whose triggers were never created. Nothing fails. Messages are stored,
 * readable, and quietly absent from the search box — the same silent shape as a declared-but-never-synced
 * Workflow stanza (`project/workflows.ts`) and a blank Turnstile sitekey (`doctor/turnstileSitekeys.ts`).
 * So it gets the same answer those got: a line, per environment, naming the command that fixes it.
 *
 * ## What it asks, and of what
 *
 * One `sqlite_master` read per deployed environment whose composition says `search.fts` is on, over the
 * D1 REST API, against that environment's own app `DB`. The names it asks about are
 * {@link import("@pithy-sh/support/src/store/searchIndex").SEARCH_OBJECTS} — the capability's own list,
 * loaded from the adopter's install, because a doctor that looked for a name the provisioner does not
 * create would report drift nothing could clear.
 *
 * **Per environment, answered for that environment.** Each is composed under its own `ENVIRONMENT`
 * (#595) and read against its own `database_id`, so a project whose staging was re-provisioned and whose
 * production was not says exactly that rather than borrowing either answer for the other.
 *
 * ## Six states, and no silent pass among them
 *
 * - **`ok`** — the table and all three triggers are there.
 * - **`drift`** — the table is there and the triggers are not, in whole or in part. The finding.
 * - **`not-provisioned`** — that environment's stanza has no app `DB` `database_id`, so there is no
 *   database to ask. Read from files, so it is true offline too.
 * - **`skipped`** — the read was not attempted, because the run is offline or holds no Cloudflare
 *   credentials. **Said out loud**, because a skip that printed nothing would be indistinguishable from
 *   a healthy project, which is the one thing this check exists to prevent.
 * - **`unreadable`** — the read threw. The guard keeps the fact and none of what it caught: a D1 read
 *   throws with ids and queries in it (#350).
 * - **`not-composed`** — that Worker's `pithy.config.ts` threw when evaluated for the environment.
 *   `Environment configs:` prints what it threw; this line's job is only to not claim a clean index.
 *
 * A project composing no support, or composing it with `search.fts` off, is **`not-applicable`** and
 * reaches no database at all — so the check is free and silent on every project that never turned
 * search on, which is most of them.
 *
 * ## It reports and never fails the exit on a skip
 *
 * Only `findings` is a fault. A `could-not-check` prints its lines and leaves the exit alone, the same
 * verdict `environmentMigrations` takes for the same reason: an offline run has learned nothing, and a
 * green `pithy doctor` turned red by being on a train is a surprise rather than a diagnosis.
 */

/** What this check established, listed positively so an inconclusive read never reads as a pass. */
export type SupportSearchTriggersState = "ok" | "not-applicable" | "could-not-check" | "findings";

/** One deployed environment's answer — see the module docblock for the six states. */
export type EnvironmentSearchIndex =
  | {
      /** The environment this answer is about, and the only one it was taken from. */
      env: string;
      /** The Worker whose support capability was read. */
      worker: string;
      /** The table and all three triggers are there. */
      state: "ok";
    }
  | {
      env: string;
      worker: string;
      /** The table is provisioned and its triggers are not. Nothing is maintaining the index. */
      state: "drift";
      /** How much of the trigger set is there — `"some"` leaves one statement kind unindexed. */
      triggers: "none" | "some";
    }
  | {
      env: string;
      worker: string;
      /** That environment's stanza names no app database, so there is nothing to ask. */
      state: "not-provisioned";
    }
  | {
      env: string;
      worker: string;
      /** A deployed read that was not attempted. */
      state: "skipped";
      /** Why it was not. */
      reason: RemoteSkip;
    }
  | {
      env: string;
      worker: string;
      /** The read threw. Nothing of what it threw is kept. */
      state: "unreadable";
    }
  | {
      env: string;
      worker: string;
      /** The Worker's `pithy.config.ts` threw when evaluated for this environment. */
      state: "not-composed";
    };

/** What `doctor` learned about this project's support search index. */
export interface SupportSearchTriggersCheck {
  state: SupportSearchTriggersState;
  /** One answer per deployed environment per Worker that composes support with `search.fts` on. */
  environments: EnvironmentSearchIndex[];
}

/** One Worker, as this check addresses it: a name for the line and a directory for its `wrangler.jsonc`. */
export interface SearchWorker {
  name: string;
  dir: string;
}

/** One Worker composed for one environment — the capabilities a build for it composes. */
export type ComposeSearchWorker = (
  worker: SearchWorker,
  env: string,
) => Promise<{ capabilities: readonly Capability[] }>;

/** The slice of `@pithy-sh/support` this check loads out of the adopter's own install. */
export interface SearchIndexNames {
  /** Every name the provisioner creates — the table and its triggers. */
  SEARCH_OBJECTS: readonly string[];
  /** Read a `sqlite_master` listing into the table and trigger facts. */
  searchIndexState: (names: readonly string[]) => { table: boolean; triggers: "all" | "some" | "none" };
}

/** Options for {@link checkSupportSearchTriggers}. */
export interface SupportSearchTriggersOptions {
  /** The project root — what `@pithy-sh/support` is resolved against. */
  projectDir: string;
  /** The deployed environments to answer for. `dev` is never one: the index is provisioned remotely. */
  environments: readonly string[];
  /** The Workers to look at, in report order. */
  workers: readonly SearchWorker[];
  /** The Cloudflare account this project belongs to, or `null` when it names none (#234). */
  account: CloudflareAccountSelection | null;
  /** Why a deployed read will not be attempted this run, or `null` when it will. */
  remoteSkip: RemoteSkip | null;
  /** Composition seam — `pithy doctor` hands in the compositions its report already took (#595). */
  composeWorker: ComposeSearchWorker;
  /** The app `DB` id for one Worker in one environment, or `null` when its stanza declares none. */
  appDatabaseId?: (workerDir: string, env: string) => Promise<string | null>;
  /** The subset of `names` present in that database's `sqlite_master`. */
  readSearchObjects?: (args: { databaseId: string; names: readonly string[] }) => Promise<string[]>;
  /** The capability's own index names, loaded from the adopter's install. */
  loadSearchIndex?: () => Promise<SearchIndexNames>;
}

/** The app database id in one Worker's stanza for one environment, read from files. */
async function appDatabaseIdFromWrangler(workerDir: string, env: string): Promise<string | null> {
  const config = (await readWranglerConfig(workerDir)) as {
    env?: Record<string, { d1_databases?: { binding: string; database_id?: string }[] } | undefined>;
  };
  const id = config.env?.[env]?.d1_databases?.find((database) => database.binding === "DB")?.database_id;
  // **The empty string is `null`.** `"database_id": ""` is what a half-finished provision and a
  // hand-edited `wrangler.jsonc` both leave behind, and `environmentReadiness` already treats it as
  // unprovisioned. Reading it as an id would send a REST call at nothing and report it as unreadable.
  return id === undefined || id === "" ? null : id;
}

/** The default remote read: one `sqlite_master` sweep over the D1 REST API. */
function readThroughRest(
  account: CloudflareAccountSelection | null,
): (args: { databaseId: string; names: readonly string[] }) => Promise<string[]> {
  return async ({ databaseId, names }) => {
    const clients = await cloudflareClients(cloudflareCredentials({ account }));
    const listed = await clients
      .d1(databaseId)
      .prepare(`SELECT name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(", ")})`)
      .bind(...names)
      .all<{ name: string }>();
    return (listed.results ?? []).map((row) => row.name);
  };
}

/** The default module load: the adopter's own `@pithy-sh/support`, never the CLI's copy. */
function loadThroughKit(projectDir: string): () => Promise<SearchIndexNames> {
  return () => kitImport<SearchIndexNames>(projectDir, "@pithy-sh/support/src/store/searchIndex");
}

/**
 * Whether a composed capability is support with its full-text index switched on.
 *
 * The name check is this module's, deliberately, and it is a **pre-filter** rather than a second copy of
 * the predicate: `@pithy-sh/support` is an optional dependency, so the CLI must not import its
 * `isSupportCapability` statically, and a project that composes no support must not pay for a dynamic
 * import to learn that. The narrowing that follows is the capability's own shape — `supportConfig`,
 * exactly what `isSupportCapability` tests for — and the config it reads is the one the build inlines.
 */
function searchEnabled(capabilities: readonly Capability[]): boolean {
  return capabilities.some((capability) => {
    if (capability.name !== "support") return false;
    const config = (capability as { supportConfig?: { search?: { fts?: boolean } } }).supportConfig;
    return config?.search?.fts === true;
  });
}

/**
 * Walk every deployed environment of every Worker that composes support with `search.fts` on.
 *
 * **Never throws**: it is a report's contributor, and every way it can fail is one of the states above.
 * The order is the cheapest honest one — composition first, because it decides whether this environment
 * has a question at all; the id from files second, so an unprovisioned environment answers offline; the
 * skip third, before anything reaches for the network; the read last.
 */
export async function checkSupportSearchTriggers(
  options: SupportSearchTriggersOptions,
): Promise<SupportSearchTriggersCheck> {
  const appDatabaseId = options.appDatabaseId ?? appDatabaseIdFromWrangler;
  const readSearchObjects = options.readSearchObjects ?? readThroughRest(options.account);
  const loadSearchIndex = options.loadSearchIndex ?? loadThroughKit(options.projectDir);

  const answers: EnvironmentSearchIndex[] = [];
  /** Loaded at most once, and only for a project that actually has an index to ask about. */
  let names: SearchIndexNames | null = null;
  let loadFailed = false;

  for (const env of options.environments) {
    for (const worker of options.workers) {
      const here = { env, worker: worker.name };
      let capabilities: readonly Capability[];
      try {
        ({ capabilities } = await options.composeWorker(worker, env));
      } catch {
        // What the config threw is the adopter's code talking, and `Environment configs:` prints it.
        answers.push({ ...here, state: "not-composed" });
        continue;
      }
      if (!searchEnabled(capabilities)) continue;

      if (names === null && !loadFailed) {
        names = await loadSearchIndex().catch(() => {
          loadFailed = true;
          return null;
        });
      }
      if (names === null) {
        // The package the composition says is there would not import. Nothing was read, and claiming a
        // clean index on the strength of a failed import is the one answer that is certainly wrong.
        answers.push({ ...here, state: "unreadable" });
        continue;
      }

      const databaseId = await appDatabaseId(worker.dir, env).catch(() => null);
      if (databaseId === null) {
        answers.push({ ...here, state: "not-provisioned" });
        continue;
      }
      if (options.remoteSkip !== null) {
        answers.push({ ...here, state: "skipped", reason: options.remoteSkip });
        continue;
      }

      let present: string[];
      try {
        present = await readSearchObjects({ databaseId, names: names.SEARCH_OBJECTS });
      } catch {
        answers.push({ ...here, state: "unreadable" });
        continue;
      }
      const state = names.searchIndexState(present);
      // **A table that is not there is not drift.** `search.fts` on with no index at all is the state
      // the runtime already answers for — `listThreads` falls back to a `LIKE` scan and logs the same
      // remedy — and reporting it here would double a finding that is not this check's.
      if (!state.table || state.triggers === "all") {
        answers.push({ ...here, state: "ok" });
        continue;
      }
      answers.push({ ...here, state: "drift", triggers: state.triggers });
    }
  }

  if (answers.length === 0) return { state: "not-applicable", environments: [] };
  if (answers.some((answer) => answer.state === "drift")) return { state: "findings", environments: answers };
  if (answers.every((answer) => answer.state === "ok")) return { state: "ok", environments: answers };
  return { state: "could-not-check", environments: answers };
}

/**
 * One line per environment that has something to say — a drift, or a read that did not happen. The
 * block is the finding, and an `ok` environment contributes nothing.
 *
 * A skip gets a line for the same reason `environmentMigrations` gives one: a missing line must never be
 * mistaken for a clean one.
 */
export function describeSupportSearchTriggers(check: SupportSearchTriggersCheck): string[] {
  const lines: string[] = [];
  for (const answer of check.environments) {
    switch (answer.state) {
      case "ok":
        break;
      case "drift":
        lines.push(
          answer.triggers === "none"
            ? `${answer.env}: pithy_support_search is provisioned and has no triggers, so nothing indexes a new message. Run pithy support provision.`
            : `${answer.env}: pithy_support_search has only some of its triggers, so some writes are not indexed. Run pithy support provision.`,
        );
        break;
      case "not-provisioned":
        lines.push(
          `${answer.env}: not provisioned — env.${answer.env} has no DB database_id, so there is no index to check.`,
        );
        break;
      case "skipped":
        lines.push(
          answer.reason === "offline"
            ? `${answer.env}: skipped — offline, so no index was read.`
            : `${answer.env}: skipped — no Cloudflare credentials, so no index was read.`,
        );
        break;
      case "unreadable":
        lines.push(`${answer.env}: could not be read, so whether the index has its triggers is unknown.`);
        break;
      case "not-composed":
        lines.push(`${answer.env}: pithy.config.ts did not compose for ${answer.env}, so no index was read.`);
        break;
    }
  }
  return lines;
}
