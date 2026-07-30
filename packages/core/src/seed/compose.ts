// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "../capability/capability";
import { InternalError } from "../error/pithyError";
import type { SeedSet } from "./seed";

/** Width of the zero-padded `order` prefix in a composed key — the stable sort anchor. */
const ORDER_DIGITS = 4;

/** Maximum per-set `order`, derived from the prefix width so the two never drift. */
export const MAX_SEED_ORDER = 10 ** ORDER_DIGITS - 1;

/** Options controlling how `composeSeeds` filters and resolves the registry. */
export interface ComposeSeedsOptions {
  /** The environment being seeded. A set is included only if its `environments` lists this value. */
  env: string;
  /** Whether `example` sets are composed in (the project's `seed.includeExamples`; default off). */
  includeExamples: boolean;
}

/** One capability's seed set, resolved into a stably-keyed, ready-to-run entry. */
export interface ResolvedSeedSet {
  /** The namespaced, order-prefixed key: `NNNN_<capability>_<name>` — the stable sort/identity key. */
  key: string;
  /** The capability that contributed this set (the namespace). */
  capability: string;
  /** The original set. */
  set: SeedSet;
}

/** The result of composing every capability's seed sets for one environment. */
export interface ComposedSeeds {
  /** The runnable sets, ordered library-before-app (`order`, then the namespaced key). */
  sets: ResolvedSeedSet[];
  /**
   * The namespaced keys of sets present in the registry but not allowed in the requested env (their
   * `environments` did not list it). Surfaced so the CLI can refuse a set explicitly targeted for a
   * disallowed env, rather than silently doing nothing.
   */
  skippedByEnv: string[];
}

/** A bad `order` is a capability-author mistake — surfaced at compose (build), so the value rides along. */
function assertValidOrder(order: number, capability: string, name: string): void {
  if (!Number.isInteger(order) || order < 0 || order > MAX_SEED_ORDER) {
    throw new InternalError({
      message: `seed order ${order} (set "${name}" in capability "${capability}") must be an integer in 0..${MAX_SEED_ORDER}.`,
    });
  }
}

/**
 * Merge every capability's `seeds` into one ordered registry for `env`, mirroring the migration
 * composer. Each set's key is `NNNN_<capability>_<name>` (NNNN = zero-padded `order`), so the sort
 * is dependency-correct (libraries before app) and stable across releases. `example` sets are
 * dropped unless `includeExamples`; sets whose `environments` does not list `env` are dropped from
 * the runnable list but reported in `skippedByEnv` (the env-allowlist safety layer). A set name used
 * twice within one capability throws an `InternalError` attributed to that capability.
 */
export function composeSeeds(capabilities: readonly Capability[], options: ComposeSeedsOptions): ComposedSeeds {
  const sets: ResolvedSeedSet[] = [];
  const skippedByEnv: string[] = [];

  for (const cap of capabilities) {
    const seen = new Set<string>();
    for (const set of cap.seeds ?? []) {
      if (seen.has(set.name)) {
        throw new InternalError({
          message: `Duplicate seed set "${set.name}" in capability "${cap.name}".`,
          action: "Give every seed set within a capability a unique name.",
        });
      }
      seen.add(set.name);
      assertValidOrder(set.order, cap.name, set.name);

      // Example sets are config-gated: absent entirely unless the project opted in. This is not an
      // env skip, so it is never reported — it is simply not part of the registry.
      if (set.example && !options.includeExamples) continue;

      const prefix = String(set.order).padStart(ORDER_DIGITS, "0");
      const key = `${prefix}_${cap.name}_${set.name}`;

      if (!set.environments.includes(options.env)) {
        skippedByEnv.push(key);
        continue;
      }
      sets.push({ key, capability: cap.name, set });
    }
  }

  sets.sort((a, b) => a.set.order - b.set.order || a.key.localeCompare(b.key));
  return { sets, skippedByEnv };
}
