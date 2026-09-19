// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { parse } from "comment-json";
import { discoverWorkers } from "../project/workers";

/**
 * **A feature's rate-limit namespaces: shared by every feature, never by staging or prod (#643).**
 *
 * Cloudflare keys a rate limiter's counters by `namespace_id`, "a positive integer that uniquely defines this rate
 * limiting namespace within your Cloudflare account", and two bindings sharing one "share the same rate limit
 * counters for a given key", across Workers
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). A feature that kept production's
 * id spent production's per-IP budget. Features may share with each other — a branch is a preview, and one
 * branch's traffic spending another's per-IP budget costs nothing that matters — so the id is **fixed, not
 * allocated**: nothing is claimed, recorded or released, and nothing account-wide is created for it.
 *
 * - **A reserved range, kit-wide.** Every feature id is an integer from {@link FEATURE_RATELIMIT_MIN} through
 *   {@link FEATURE_RATELIMIT_MAX}. No project running this kit may declare one, in any Worker or stanza:
 *   `pithy provision`, `pithy deploy` and `pithy doctor` all read every tracked `wrangler.jsonc`
 *   ({@link assertNoDeclaredFeatureIds}), whether or not the project has ever provisioned a feature. So a feature
 *   id is never a staging or production one. The check reads the **integer**, never the string: `"01031275746"`
 *   and `1.031275746e9` are `1031275746`.
 * - **One fixed id per limiter** ({@link featureNamespaceId}): the limiter's declared namespace `n`, offset into the
 *   range, `1000000000 + n`. An offset is injective, so two distinct declared namespaces are two feature ids and
 *   no hash can collide them. Every feature of every project binds that id for that namespace, and two Workers
 *   bound to one namespace in production share one in every feature. A namespace that cannot be offset into the
 *   range — none, not an integer, below 1, or 1000000000 and above — is refused before anything is created.
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

/** The highest declared namespace a feature can offset into the range: `999999999`, mapped to {@link FEATURE_RATELIMIT_MAX}. */
export const FEATURE_RATELIMIT_DECLARED_MAX = FEATURE_RATELIMIT_SPAN - 1;

/**
 * **The one namespace every feature binds for this limiter (#643)**: its declared `namespace_id` `n`, read as an
 * integer, offset to `1000000000 + n`. Injective by construction — distinct declared namespaces, distinct ids —
 * and inside the reserved range, so never a staging or production id.
 *
 * Refused, naming the limiter, when the entry cannot map: no `namespace_id` (a limiter is its namespace, and a
 * binding name cannot be offset), one not spelled as decimal digits, one below 1 (Cloudflare's "positive integer"), or
 * one of `1000000000` or more — the range's own ids, which are refused anyway, and any higher, which would land
 * past it. Such an id works in staging and prod; a feature needs one below `1000000000`.
 */
export function featureNamespaceId(entry: { name?: unknown; namespace_id?: unknown }, worker?: string): string {
  const limiter = `${worker !== undefined ? `${worker}'s ` : ""}rate limiter ${String(entry.name ?? "(unnamed)")}`;
  const declared = entry.namespace_id;
  // Strict decimal digits only: `"1.5"` and `"1001abc"` are not integers, and reading them the lenient way would
  // give two spellings Cloudflare refuses the id of a limiter it accepts.
  const digits = typeof declared === "number" || typeof declared === "string" ? String(declared).trim() : "";
  const value = /^\d+$/.test(digits) ? Number(digits) : null;
  if (value === null || value < 1 || value > FEATURE_RATELIMIT_DECLARED_MAX) {
    throw new ValidationError({
      message:
        value === null
          ? `The ${limiter} declares no integer namespace_id, so a feature has no namespace to bind for it.`
          : `The ${limiter} declares namespace ${value}, which has no feature namespace.`,
      action: `Give that limiter a namespace_id from 1 through ${FEATURE_RATELIMIT_DECLARED_MAX} in wrangler.jsonc.`,
      detail: `A feature binds ${FEATURE_RATELIMIT_MIN} plus the declared namespace, which must land in ${FEATURE_RATELIMIT_MIN} through ${FEATURE_RATELIMIT_MAX}. Declared: ${JSON.stringify(declared ?? null)}.`,
    });
  }
  return String(FEATURE_RATELIMIT_MIN + value);
}

/** One `ratelimits` entry, as far as the feature range reads one. */
export interface RatelimitEntry {
  name?: unknown;
  namespace_id?: unknown;
}

/** What one Worker's tracked config says about rate limiters. */
export interface WorkerRatelimits {
  /** The Worker's directory, for a refusal to name. */
  worker: string;
  /** The limiters its feature stanza will bind, as declared: a tracked `env.feature`'s own, and the top level's. */
  limiters: RatelimitEntry[];
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
  const limiters = [...own, ...top.filter((entry) => !bound.has(entry.name))];
  const declared: { id: string; where: string }[] = [];
  const collect = (entries: RatelimitEntry[], where: string): void => {
    for (const entry of entries) {
      if (entry.namespace_id !== undefined) declared.push({ id: String(entry.namespace_id), where });
    }
  };
  collect(top, "the top level");
  // Every stanza, `feature` included (#643). A feature's fixed ids are written to a generated config under
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
 * not it has features, because every feature of *every* project in the account binds ids in that range.
 */
export function assertNoDeclaredFeatureIds(workers: readonly WorkerRatelimits[]): void {
  const [first, ...rest] = declaredFeatureIdFindings(workers);
  if (first === undefined) return;
  throw new ValidationError({
    message: `${first} Namespaces ${FEATURE_RATELIMIT_MIN} through ${FEATURE_RATELIMIT_MAX} are reserved for features.`,
    action: `Give that limiter a namespace_id below ${FEATURE_RATELIMIT_MIN} in wrangler.jsonc.`,
    detail: [
      "Every feature of every project in the account binds its limiters in that range, so a declared id there would share its counters with a branch.",
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
 * because a feature of another project in the account can bind the id.
 */
export async function assertProjectDeclaresNoFeatureIds(projectDir: string): Promise<void> {
  assertNoDeclaredFeatureIds(await projectRatelimits(projectDir));
}

/**
 * **Refuse, before anything is created, a feature whose limiters cannot all map (#643)** — the same
 * {@link featureNamespaceId} the stanza writer asks, over every Worker's tracked config.
 */
export function assertFeatureLimitersMap(workers: readonly WorkerRatelimits[]): void {
  for (const worker of workers) for (const entry of worker.limiters) featureNamespaceId(entry, worker.worker);
}
