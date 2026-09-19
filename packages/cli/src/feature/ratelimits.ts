// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import {
  type FeatureIdentity,
  featureSecretEntryName,
  isFeatureOwnedName,
  parseFeatureName,
} from "@pithy-sh/core/src/naming/feature";
import { hash6, kebab } from "@pithy-sh/core/src/naming/resource";
import { parse } from "comment-json";
import type { SecretsStore, StoreEntry } from "../provision/store";

/**
 * **A feature's own rate-limit namespaces, allocated so no two owners can ever hold one (#643).**
 *
 * Cloudflare keys a rate limiter's counters by `namespace_id`, a number, across the whole account. A feature
 * that kept production's id spent production's per-IP budget, and a hashed id (the first fix) made two branches
 * or two projects share one a hundredth of the time. A number that fits the binding cannot carry a project, an
 * issue and a slug injectively, so the id is **allocated and recorded**, not derived:
 *
 * - **A reserved range.** Every feature id is ten digits starting with 1 ({@link isFeatureRatelimitId}). A
 *   declared environment may not use one: `pithy provision --feature` refuses a tracked config that does, in any
 *   Worker and any stanza. So no staging or prod id of a project with features is in the range a feature draws
 *   from, and a project that has none is refused the moment it provisions its first.
 * - **A claim per limiter, in the account's one Secrets Store.** Each allocation is an entry named for the
 *   feature, `<project>-f<issue>-<slug>--ratelimit-<id>-<limiter>`, the one store every project in the account
 *   shares, so every feature of every project sees every claim. Two claims on one id are settled the way
 *   `createSecretIfAbsent` settles two entries of one name: the oldest stands, whoever looks, and the other run
 *   withdraws its claim and takes the next free id.
 * - **One claim per limiter, not per Worker.** A limiter is the namespace its Worker declares, so two Workers
 *   bound to one namespace in production share one in the feature, and two distinct ones never merge.
 *
 * Teardown removes every claim the feature holds, by parsing, so an id comes back when the branch goes.
 */

/** The lowest feature id: ten digits, a leading 1. */
export const FEATURE_RATELIMIT_MIN = 1_000_000_000;
/** How many ids the reserved range holds: `1000000000` through `1999999999`, all under 2^31. */
export const FEATURE_RATELIMIT_SPAN = 1_000_000_000;

/** Is this a feature's id — inside the range no declared environment may use? */
export function isFeatureRatelimitId(id: string): boolean {
  return /^1[0-9]{9}$/.test(id);
}

/** The `thing` every claim's name carries after the feature's head. */
const CLAIM_THING = "ratelimit";

/**
 * The limiter a `ratelimits` entry is: the namespace it declares, or its binding name when it declares none.
 * This is what a claim is made for, so two entries that share a namespace in production share one here.
 */
export function limiterKey(entry: { name?: unknown; namespace_id?: unknown }): string {
  if (entry.namespace_id !== undefined && entry.namespace_id !== null && String(entry.namespace_id) !== "") {
    return `ns-${kebab(String(entry.namespace_id)) || hash6(String(entry.namespace_id))}`;
  }
  return `binding-${kebab(String(entry.name ?? "")) || "unnamed"}`;
}

/** The store entry recording that this feature holds `id` for `limiter`. A feature name, so it parses back. */
export function ratelimitClaimName(identity: FeatureIdentity, limiter: string, id: string): string {
  return featureSecretEntryName(identity, `${CLAIM_THING}-${id}-${limiter}`);
}

/** One claim read off the store: which id, which feature, which limiter, and the entry that records it. */
interface Claim {
  entry: StoreEntry;
  id: string;
  limiter: string;
}

/** Every claim any feature of any project holds, read off the store's entries. */
function claimsIn(entries: readonly StoreEntry[]): Claim[] {
  const claims: Claim[] = [];
  for (const entry of entries) {
    const parsed = parseFeatureName(entry.name);
    if (parsed === null) continue;
    const [thing, id, ...limiter] = parsed.thing.split("-");
    if (thing !== CLAIM_THING || id === undefined || !isFeatureRatelimitId(id)) continue;
    claims.push({ entry, id, limiter: limiter.join("-") });
  }
  return claims;
}

/** The claim that stands on each id: the oldest, the smaller entry id breaking a tie — one answer, whoever asks. */
function standing(claims: readonly Claim[]): Map<string, Claim> {
  const byId = new Map<string, Claim>();
  for (const claim of claims) {
    const held = byId.get(claim.id);
    const older =
      held === undefined ||
      claim.entry.created.getTime() < held.entry.created.getTime() ||
      (claim.entry.created.getTime() === held.entry.created.getTime() && claim.entry.id < held.entry.id);
    if (older) byId.set(claim.id, claim);
  }
  return byId;
}

/** Where probing starts for a limiter: stable in the feature and the limiter, so a quiet account allocates alike. */
function firstCandidate(identity: FeatureIdentity, limiter: string): number {
  let hash = 0x811c9dc5;
  for (const char of ratelimitClaimName(identity, limiter, "0")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return FEATURE_RATELIMIT_MIN + (hash % FEATURE_RATELIMIT_SPAN);
}

/** The next id in the reserved range, wrapping. */
function next(id: number): number {
  return FEATURE_RATELIMIT_MIN + ((id - FEATURE_RATELIMIT_MIN + 1) % FEATURE_RATELIMIT_SPAN);
}

/** Gives up after this many lost races on one limiter, rather than spin against a store that will not settle. */
const MAX_ATTEMPTS = 32;

/**
 * **Allocate this feature's namespace for each limiter**, reusing one it already holds. Resolves limiter →
 * id. Never an id another claim stands on, one a tracked config declares, or one another limiter here holds.
 */
export async function allocateFeatureRatelimits(options: {
  identity: FeatureIdentity;
  /** Every limiter the feature's Workers bind, by {@link limiterKey}. */
  limiters: readonly string[];
  /** Every `namespace_id` the project's tracked configs declare, in any Worker and any stanza. */
  declared: ReadonlySet<string>;
  store: Required<Pick<SecretsStore, "list">> & Pick<SecretsStore, "create" | "remove">;
}): Promise<Map<string, string>> {
  const { identity, store } = options;
  const allocated = new Map<string, string>();
  const limiters = [...new Set(options.limiters)].sort();
  if (limiters.length === 0) return allocated;

  for (const limiter of limiters) {
    for (let attempt = 0; ; attempt += 1) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new InternalError({
          message: "A rate-limit namespace could not be allocated for this feature.",
          action: "Run pithy provision --feature again.",
          detail: `limiter ${limiter}: lost ${MAX_ATTEMPTS} races for a namespace id in the Secrets Store`,
        });
      }
      const claims = claimsIn(await store.list());
      const stands = standing(claims);
      const mine = claims.filter(
        (claim) => claim.limiter === limiter && isFeatureOwnedName(identity, claim.entry.name),
      );
      // Already held, and still standing: this feature's namespace, kept across every re-run.
      const kept = mine.find((claim) => stands.get(claim.id) === claim && !isTaken(claim.id, allocated, options));
      if (kept) {
        allocated.set(limiter, kept.id);
        for (const other of mine) if (other !== kept) await store.remove(other.entry.name);
        break;
      }
      // Any claim of ours that lost is withdrawn, so the id goes back to whoever holds it.
      for (const lost of mine) await store.remove(lost.entry.name);

      let candidate = firstCandidate(identity, limiter);
      while (stands.has(String(candidate)) || isTaken(String(candidate), allocated, options)) {
        candidate = next(candidate);
      }
      const id = String(candidate);
      const name = ratelimitClaimName(identity, limiter, id);
      await store.create(name, id);
      // Read back: the claim stands only if no older one on the same id appeared beside it.
      const after = standing(claimsIn(await store.list())).get(id);
      if (after?.entry.name === name) {
        allocated.set(limiter, id);
        break;
      }
      await store.remove(name);
    }
  }
  return allocated;
}

function isTaken(id: string, allocated: ReadonlyMap<string, string>, options: { declared: ReadonlySet<string> }) {
  return options.declared.has(id) || [...allocated.values()].includes(id);
}

/** Every claim this feature holds, by name — what teardown removes. */
export async function featureRatelimitClaims(
  identity: FeatureIdentity,
  store: Required<Pick<SecretsStore, "list">>,
): Promise<string[]> {
  return claimsIn(await store.list())
    .filter((claim) => isFeatureOwnedName(identity, claim.entry.name))
    .map((claim) => claim.entry.name);
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
  /** Every id it declares for the top level and every declared environment, by where. */
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
  for (const [name, stanza] of Object.entries(config.env ?? {})) {
    if (name !== FEATURE_ENVIRONMENT) collect(list(stanza?.ratelimits), `env.${name}`);
  }
  return { worker: worker.name, limiters, declared };
}

/**
 * **Refuse a declared environment's id inside the feature range**, in any Worker of the project. It is the half
 * of the reservation that keeps staging and prod out of what features draw from, so it is checked across every
 * Worker's tracked config, never only the one being written.
 */
export function assertNoDeclaredFeatureIds(workers: readonly WorkerRatelimits[]): void {
  for (const worker of workers) {
    for (const { id, where } of worker.declared) {
      if (!isFeatureRatelimitId(id)) continue;
      throw new ValidationError({
        message: `${worker.worker} declares rate-limit namespace ${id} in ${where}. Ten digits starting with 1 are reserved for features.`,
        action: `Give that limiter a namespace_id below ${FEATURE_RATELIMIT_MIN} in wrangler.jsonc.`,
        detail: `Feature namespaces are allocated from ${FEATURE_RATELIMIT_MIN} to ${FEATURE_RATELIMIT_MIN + FEATURE_RATELIMIT_SPAN - 1}, and a declared id there could be handed to a branch.`,
      });
    }
  }
}
