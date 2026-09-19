// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { canonicalIssue, type FeatureIdentity } from "@pithy-sh/core/src/naming/feature";
import { hash6, kebab } from "@pithy-sh/core/src/naming/resource";
import { parse } from "comment-json";
import { z } from "zod";
import { discoverWorkers } from "../project/workers";
import type { ResourceProvisioner } from "../provision/resources";

/**
 * **A feature's own rate-limit namespaces, allocated so no two owners can ever hold one (#643).**
 *
 * Cloudflare keys a rate limiter's counters by `namespace_id`, "a positive integer that uniquely defines this rate
 * limiting namespace within your Cloudflare account", and two bindings sharing one "share the same rate limit
 * counters for a given key", across Workers
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). A feature that kept production's
 * id spent production's per-IP budget, and a hashed id made two branches share one a hundredth of the time. A
 * number cannot carry a project, an issue and a slug injectively, so the id is **allocated and recorded**:
 *
 * - **A reserved range, kit-wide.** Every feature id is an integer from {@link FEATURE_RATELIMIT_MIN} through
 *   {@link FEATURE_RATELIMIT_MAX}. No project running this kit may declare one, in any Worker or stanza:
 *   `pithy provision`, `pithy deploy` and `pithy doctor` all read every tracked `wrangler.jsonc`
 *   ({@link assertNoDeclaredFeatureIds}), whether or not the project has ever provisioned a feature. So an id a
 *   feature draws cannot be any project's declared one. The check reads the **integer**, never the string:
 *   `"01031275746"` and `1.031275746e9` are `1031275746`.
 * - **A claim per limiter, in the account's feature registry** ({@link RatelimitRegistry}): one D1 database per
 *   account, `pithy--feature-registry`, created if absent, holding one row per claim — the id, the feature and the
 *   limiter, nothing else. Not the Secrets Store: the store holds 100 secrets per account
 *   (https://developers.cloudflare.com/secrets-store/manage-secrets/, and the changelog of 2025-05-19), and a claim
 *   per limiter per open branch spent that quota on bookkeeping.
 * - **The oldest claim wins because it is the only one there.** The id is the table's primary key, so a second
 *   claim on it is not a second row that loses a comparison: the insert does nothing. D1 runs "each individual D1
 *   database ... single-threaded, and processes queries one at a time"
 *   (https://developers.cloudflare.com/d1/platform/limits/), and without the Sessions API — which the REST API
 *   does not offer — "all queries will continue to be executed only by the primary database"
 *   (https://developers.cloudflare.com/d1/best-practices/read-replication/). So a read after a write sees it: no
 *   lag to wait out, and no race for a read-back to lose. KV was the other candidate and was ruled out on exactly
 *   this: changes "may take up to 60 seconds or more to be visible in other global network locations", and it is
 *   "not ideal for applications where you need support for atomic operations"
 *   (https://developers.cloudflare.com/kv/concepts/how-kv-works/).
 * - **One claim per limiter, not per Worker.** A limiter is the namespace its Worker declares, so two Workers
 *   bound to one namespace in production share one in the feature, and two distinct ones never merge.
 *
 * Teardown deletes every row the feature holds — exactly its project, issue and slug — so an id comes back when
 * the branch goes, and nobody else's does.
 */

/** The lowest feature id: ten digits, a leading 1. */
export const FEATURE_RATELIMIT_MIN = 1_000_000_000;
/** How many ids the reserved range holds: `1000000000` through `1999999999`, all under 2^31. */
export const FEATURE_RATELIMIT_SPAN = 1_000_000_000;
/** The highest feature id. */
export const FEATURE_RATELIMIT_MAX = FEATURE_RATELIMIT_MIN + FEATURE_RATELIMIT_SPAN - 1;

/**
 * **The integer a declared `namespace_id` names, or `null` when it names none.**
 *
 * Cloudflare documents the value as "a string containing a positive integer" and says "the value must be a valid
 * integer" (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). It does not document how
 * a zero-padded or exponent spelling is read, so this assumes the worst: every spelling a number parser accepts is
 * read as the integer it spells. `"01031275746"`, `" 1031275746 "`, `1031275746` and `"1.031275746e9"` are one id.
 */
export function namespaceIdValue(id: unknown): number | null {
  if (typeof id === "number") return Number.isInteger(id) ? id : null;
  if (typeof id === "bigint") return Number(id);
  if (typeof id !== "string" || id.trim() === "") return null;
  const text = id.trim();
  const spelled = Number(text);
  if (Number.isInteger(spelled)) return spelled;
  // A prefix a lenient parser would stop at, `"1031275746abc"`, is read the lenient way too.
  const leading = Number.parseInt(text, 10);
  return Number.isInteger(leading) ? leading : null;
}

/** Is this id inside the range reserved for features — the one no project may declare? Read as an integer. */
export function isFeatureRatelimitId(id: unknown): boolean {
  const value = namespaceIdValue(id);
  return value !== null && value >= FEATURE_RATELIMIT_MIN && value <= FEATURE_RATELIMIT_MAX;
}

/**
 * The limiter a `ratelimits` entry is: the namespace it declares, or its binding name when it declares none.
 * This is what a claim is made for, so two entries that share a namespace in production share one here. The
 * namespace is read as its integer, so two spellings of one id are one limiter.
 */
export function limiterKey(entry: { name?: unknown; namespace_id?: unknown }): string {
  if (entry.namespace_id !== undefined && entry.namespace_id !== null && String(entry.namespace_id) !== "") {
    const value = namespaceIdValue(entry.namespace_id);
    if (value !== null) return `ns-${value}`;
    return `ns-${kebab(String(entry.namespace_id)) || hash6(String(entry.namespace_id))}`;
  }
  return `binding-${kebab(String(entry.name ?? "")) || "unnamed"}`;
}

/**
 * **The account's record of which feature holds which id** — claim metadata only, never runtime data.
 *
 * Every method reads or writes exactly what it names, and a feature is its exact project, canonical issue and
 * slug. {@link d1RatelimitRegistry} is the real one.
 */
export interface RatelimitRegistry {
  /** The id this feature holds for `limiter`, or `null`. */
  held(identity: FeatureIdentity, limiter: string): Promise<string | null>;
  /** Every id any feature of any project holds. */
  claimed(): Promise<Set<string>>;
  /** Claim `id` for this feature's `limiter` — a no-op when the id, or this feature's limiter, is already claimed. */
  claim(identity: FeatureIdentity, limiter: string, id: string): Promise<void>;
  /** Delete every claim this feature holds; resolves the ids released. */
  release(identity: FeatureIdentity): Promise<string[]>;
}

/** The feature as a registry row carries it: exact, so a sibling slug or another project is another row. */
export function claimOwner(identity: FeatureIdentity): { project: string; issue: string; slug: string } {
  return { project: kebab(identity.project), issue: canonicalIssue(identity.issue), slug: kebab(identity.slug) };
}

/** Where probing starts for a limiter: stable in the feature and the limiter, so a quiet account allocates alike. */
function firstCandidate(identity: FeatureIdentity, limiter: string): number {
  const owner = claimOwner(identity);
  let hash = 0x811c9dc5;
  for (const char of `${owner.project}|${owner.issue}|${owner.slug}|${limiter}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return FEATURE_RATELIMIT_MIN + (hash % FEATURE_RATELIMIT_SPAN);
}

/** The next id in the reserved range, wrapping. */
function next(id: number): number {
  return FEATURE_RATELIMIT_MIN + ((id - FEATURE_RATELIMIT_MIN + 1) % FEATURE_RATELIMIT_SPAN);
}

/** Gives up after this many lost races on one limiter, rather than spin against a registry that will not settle. */
const MAX_ATTEMPTS = 32;

/**
 * **Allocate this feature's namespace for each limiter**, reusing one it already holds. Resolves limiter → id.
 * Never an id another feature holds, one a tracked config declares, or one another limiter here holds.
 *
 * Claim, then read back what the feature holds: a claim that lost to a concurrent run — on the id, or on this
 * feature's limiter — inserted nothing, and the read says what stands.
 */
export async function allocateFeatureRatelimits(options: {
  identity: FeatureIdentity;
  /** Every limiter the feature's Workers bind, by {@link limiterKey}. */
  limiters: readonly string[];
  /** Every `namespace_id` the project's tracked configs declare, in any Worker and any stanza. */
  declared: ReadonlySet<string>;
  registry: RatelimitRegistry;
}): Promise<Map<string, string>> {
  const { identity, registry } = options;
  const allocated = new Map<string, string>();
  const declared = new Set([...options.declared].map((id) => String(namespaceIdValue(id) ?? id)));
  for (const limiter of [...new Set(options.limiters)].sort()) {
    for (let attempt = 0; ; attempt += 1) {
      const held = await registry.held(identity, limiter);
      if (held !== null) {
        allocated.set(limiter, held);
        break;
      }
      if (attempt >= MAX_ATTEMPTS) {
        throw new InternalError({
          message: "A rate-limit namespace could not be allocated for this feature.",
          action: "Run pithy provision --feature again.",
          detail: `limiter ${limiter}: ${MAX_ATTEMPTS} claims in the feature registry, none of them standing`,
        });
      }
      const taken = await registry.claimed();
      let candidate = firstCandidate(identity, limiter);
      const busy = (id: number): boolean =>
        taken.has(String(id)) || declared.has(String(id)) || [...allocated.values()].includes(String(id));
      while (busy(candidate)) candidate = next(candidate);
      await registry.claim(identity, limiter, String(candidate));
    }
  }
  return allocated;
}

/** The D1 database every feature of every project in the account records its claims in. Not a feature name. */
export const RATELIMIT_REGISTRY_DATABASE = "pithy--feature-registry";

/** The one statement that makes the table, run before every use: idempotent, and the whole schema. */
export const RATELIMIT_REGISTRY_SCHEMA = `CREATE TABLE IF NOT EXISTS ratelimit_claims (
  namespace_id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  issue TEXT NOT NULL,
  slug TEXT NOT NULL,
  limiter TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  UNIQUE (project, issue, slug, limiter)
)`;

/** Run one statement, resolving its rows. The D1 REST query in a real run; any SQLite in a test. */
export type SqlExecutor = (sql: string, params: string[]) => Promise<unknown[]>;

/** A row the registry reads back: only the id, validated rather than cast. */
const ClaimedIdRow = z
  .object({
    namespace_id: z.union([z.number(), z.string()]).describe("The claimed namespace id."),
  })
  .describe("One claimed namespace id, as the feature registry returns it.");

function idsOf(rows: readonly unknown[]): string[] {
  return rows.map((row) => {
    const parsed = ClaimedIdRow.safeParse(row);
    const value = parsed.success ? namespaceIdValue(parsed.data.namespace_id) : null;
    if (value === null) {
      throw new InternalError({
        message: "The feature registry returned a row it could not read.",
        action: "Run the command again.",
        detail: `unexpected ratelimit_claims row: ${JSON.stringify(row)}`,
      });
    }
    return String(value);
  });
}

/** **The registry over SQL** — the D1 database in a real run. The schema is ensured once per registry. */
export function sqlRatelimitRegistry(execute: SqlExecutor, now: () => Date = () => new Date()): RatelimitRegistry {
  let ready: Promise<unknown> | null = null;
  const run = async (sql: string, params: string[] = []): Promise<unknown[]> => {
    ready ??= execute(RATELIMIT_REGISTRY_SCHEMA, []);
    await ready;
    return execute(sql, params);
  };
  return {
    held: async (identity, limiter) => {
      const { project, issue, slug } = claimOwner(identity);
      const [id] = idsOf(
        await run(
          "SELECT namespace_id FROM ratelimit_claims WHERE project = ? AND issue = ? AND slug = ? AND limiter = ?",
          [project, issue, slug, limiter],
        ),
      );
      return id ?? null;
    },
    claimed: async () => new Set(idsOf(await run("SELECT namespace_id FROM ratelimit_claims"))),
    claim: async (identity, limiter, id) => {
      const { project, issue, slug } = claimOwner(identity);
      await run(
        "INSERT OR IGNORE INTO ratelimit_claims (namespace_id, project, issue, slug, limiter, claimed_at) VALUES (CAST(? AS INTEGER), ?, ?, ?, ?, ?)",
        [id, project, issue, slug, limiter, now().toISOString()],
      );
    },
    release: async (identity) => {
      const { project, issue, slug } = claimOwner(identity);
      return idsOf(
        await run("DELETE FROM ratelimit_claims WHERE project = ? AND issue = ? AND slug = ? RETURNING namespace_id", [
          project,
          issue,
          slug,
        ]),
      );
    },
  };
}

/** One `ratelimits` entry, as far as allocation reads one. */
interface RatelimitEntry {
  name?: unknown;
  namespace_id?: unknown;
}

/** What one Worker's tracked config says about rate limiters. */
export interface WorkerRatelimits {
  /** The Worker's directory, for a refusal to name. */
  worker: string;
  /** The limiters its feature stanza will bind: the top level's, and a tracked `env.feature`'s own. */
  limiters: string[];
  /** Every id it declares, at the top level and in every stanza `feature`'s included, by where. */
  declared: { id: string; where: string }[];
}

/** Read one Worker's tracked `wrangler.jsonc` for its rate limiters. A Worker without one has none. */
export async function readWorkerRatelimits(worker: { name: string; dir: string }): Promise<WorkerRatelimits> {
  let raw: string;
  try {
    raw = await readFile(join(worker.dir, "wrangler.jsonc"), "utf8");
  } catch {
    return { worker: worker.name, limiters: [], declared: [] };
  }
  const config = parse(raw) as unknown as {
    ratelimits?: RatelimitEntry[];
    env?: Record<string, { ratelimits?: RatelimitEntry[] } | undefined>;
  };
  const list = (value: unknown): RatelimitEntry[] => (Array.isArray(value) ? (value as RatelimitEntry[]) : []);
  const top = list(config.ratelimits);
  const own = list(config.env?.[FEATURE_ENVIRONMENT]?.ratelimits);
  const bound = new Set(own.map((entry) => entry.name));
  const limiters = [...own, ...top.filter((entry) => !bound.has(entry.name))].map(limiterKey);
  const declared: { id: string; where: string }[] = [];
  const collect = (entries: RatelimitEntry[], where: string): void => {
    for (const entry of entries) {
      if (entry.namespace_id !== undefined) declared.push({ id: String(entry.namespace_id), where });
    }
  };
  collect(top, "the top level");
  // Every stanza, `feature` included (#643). A feature's allocated ids are written to a generated config under
  // `.wrangler/`, never here, so an id in the range in a tracked file is always one somebody chose.
  for (const [name, stanza] of Object.entries(config.env ?? {})) collect(list(stanza?.ratelimits), `env.${name}`);
  return { worker: worker.name, limiters, declared };
}

/** Every tracked rate-limit id in the reserved range, as one sentence each: what doctor reports and the gates refuse. */
export function declaredFeatureIdFindings(workers: readonly WorkerRatelimits[]): string[] {
  const findings: string[] = [];
  for (const worker of workers) {
    for (const { id, where } of worker.declared) {
      if (!isFeatureRatelimitId(id)) continue;
      const value = String(namespaceIdValue(id));
      const spelled = value === id ? id : `"${id}" (${value})`;
      findings.push(`${worker.worker} declares rate-limit namespace ${spelled} in ${where}.`);
    }
  }
  return findings;
}

/**
 * **Refuse any declared id inside the feature range, in any Worker and any stanza (#643).** Asked by `pithy
 * provision` for every environment, `pithy deploy`, and reported by `pithy doctor` — in every project, whether or
 * not it has features, because a feature of *another* project in the account draws from the same range.
 */
export function assertNoDeclaredFeatureIds(workers: readonly WorkerRatelimits[]): void {
  const [first, ...rest] = declaredFeatureIdFindings(workers);
  if (first === undefined) return;
  throw new ValidationError({
    message: `${first} Namespaces ${FEATURE_RATELIMIT_MIN} through ${FEATURE_RATELIMIT_MAX} are reserved for features.`,
    action: `Give that limiter a namespace_id below ${FEATURE_RATELIMIT_MIN} in wrangler.jsonc.`,
    detail: [
      "Feature namespaces are allocated from that range for every project in the account, so a declared id there could be handed to any branch and share its counters.",
      ...rest,
    ].join(" "),
  });
}

/** Every Worker under `apps/`, read for its declared rate-limit ids — what deploy and doctor read (#643). */
export async function projectRatelimits(projectDir: string): Promise<WorkerRatelimits[]> {
  return Promise.all((await discoverWorkers(projectDir)).map(readWorkerRatelimits));
}

/**
 * **Refuse a project that declares an id in the feature range, anywhere (#643).** `pithy deploy` asks it before
 * anything is built, for every selection: the reservation holds for a project that never provisions a feature,
 * because a feature of another project in the account can draw the id.
 */
export async function assertProjectDeclaresNoFeatureIds(projectDir: string): Promise<void> {
  assertNoDeclaredFeatureIds(await projectRatelimits(projectDir));
}

/**
 * **The account's feature registry, found by name — and created when `create` says so and it is absent.**
 * `null` when it is absent and not to be created: teardown creates nothing, and an account with no registry holds
 * no claim. Found and created through the confirmed-account provisioner, so an unconfirmed account never gets one.
 *
 * Two runs creating it at once: the loser's create fails on the taken name, and it takes the winner's database.
 */
export async function accountRatelimitRegistry(options: {
  d1: Pick<ResourceProvisioner, "find" | "create">;
  execute: (databaseId: string) => SqlExecutor;
  create: boolean;
}): Promise<RatelimitRegistry | null> {
  let found = await options.d1.find(RATELIMIT_REGISTRY_DATABASE);
  if (found === null) {
    if (!options.create) return null;
    try {
      found = await options.d1.create(RATELIMIT_REGISTRY_DATABASE);
    } catch (error) {
      found = await options.d1.find(RATELIMIT_REGISTRY_DATABASE);
      if (found === null) throw error;
    }
  }
  return sqlRatelimitRegistry(options.execute(found.id));
}

/** A D1 database's REST query as a {@link SqlExecutor}: the rows of every result set, in order. */
export function d1Executor(query: (sql: string, params: string[]) => Promise<{ results?: unknown[] }[]>): SqlExecutor {
  return async (sql, params) => (await query(sql, params)).flatMap((result) => result.results ?? []);
}

/**
 * **A registry opened on first use**, so a feature that binds no limiter never creates the account's database, and
 * a teardown on an account that never had one finds nothing to release rather than making one.
 */
export function lazyRatelimitRegistry(open: () => Promise<RatelimitRegistry | null>): RatelimitRegistry {
  let pending: Promise<RatelimitRegistry | null> | null = null;
  const opened = (): Promise<RatelimitRegistry | null> => {
    pending ??= open();
    return pending;
  };
  const required = async (): Promise<RatelimitRegistry> => {
    const registry = await opened();
    if (registry !== null) return registry;
    throw new InternalError({
      message: "The account's feature registry could not be opened.",
      action: "Run the command again.",
      detail: `${RATELIMIT_REGISTRY_DATABASE} is absent and this run may not create it`,
    });
  };
  return {
    held: async (identity, limiter) => (await required()).held(identity, limiter),
    claimed: async () => (await required()).claimed(),
    claim: async (identity, limiter, id) => (await required()).claim(identity, limiter, id),
    release: async (identity) => (await opened())?.release(identity) ?? [],
  };
}
