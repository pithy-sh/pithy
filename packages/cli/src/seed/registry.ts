// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { type ComposedSeeds, composeSeeds } from "@pithy-sh/core/src/seed/compose";

/** Options controlling how {@link buildSeedPlan} composes the project's seed sets. */
export interface BuildSeedPlanOptions {
  /** The environment being seeded. A set runs only if its `environments` lists this value. */
  env: string;
  /** Whether `example` sets are composed in (the project's `seed.includeExamples`; default off). */
  includeExamples: boolean;
}

/**
 * Compose every capability's `seeds` into one ordered, env-filtered registry — the CLI's thin seam
 * over core's `composeSeeds`, the peer of `buildRegistryFromCapabilities` for migrations. Returns the
 * runnable sets (library-before-app by `order`, then namespaced key) plus the keys of sets present but
 * disallowed for `env` (`skippedByEnv`), so the command can report a set it refused to run rather than
 * silently doing nothing. Ordering, namespacing, example filtering, and the env allowlist all live in
 * core; this wrapper is the single import site `pithy seed` composes through.
 */
export function buildSeedPlan(capabilities: Capability[], options: BuildSeedPlanOptions): ComposedSeeds {
  return composeSeeds(capabilities, { env: options.env, includeExamples: options.includeExamples });
}
