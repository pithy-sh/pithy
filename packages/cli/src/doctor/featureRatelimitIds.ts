// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  declaredFeatureIdFindings,
  FEATURE_RATELIMIT_MAX,
  FEATURE_RATELIMIT_MIN,
  projectRatelimits,
} from "../feature/ratelimits";

/**
 * **Does any Worker declare a rate-limit namespace in the range reserved for features (#643)?**
 *
 * Every feature of every project in the account binds its limiters from {@link FEATURE_RATELIMIT_MIN} through
 * {@link FEATURE_RATELIMIT_MAX}, so a declared id there shares counters with a branch.
 * `pithy provision` and `pithy deploy` refuse it; this says so first, from the files alone. Every tracked
 * `wrangler.jsonc`, every stanza, and the id read as the integer it spells.
 *
 * **It fails the exit**: the commands that ship the stanza refuse it, and the kit never writes an id there.
 */
export interface FeatureRatelimitIdsCheck {
  /** `reserved` when a Worker declares one; `could-not-check` when the files could not be read. */
  state: "ok" | "reserved" | "could-not-check";
  /** One sentence per declared id in the range. */
  findings: string[];
}

/** Read every Worker's tracked config for a declared id in the feature range. Files only. */
export async function checkFeatureRatelimitIds(projectDir: string): Promise<FeatureRatelimitIdsCheck> {
  const findings = declaredFeatureIdFindings(await projectRatelimits(projectDir));
  return { state: findings.length > 0 ? "reserved" : "ok", findings };
}

/** The remedy line under the findings. */
export const FEATURE_RATELIMIT_IDS_ACTION = `Namespaces ${FEATURE_RATELIMIT_MIN} through ${FEATURE_RATELIMIT_MAX} are reserved for features. Give each a namespace_id below ${FEATURE_RATELIMIT_MIN}.`;
