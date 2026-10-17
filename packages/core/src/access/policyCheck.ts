// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CapabilitySettings, SettingsFinding } from "../capability/settings";
import { outsidePolicy, type VisibilityPolicy } from "./visibility";

/**
 * `pithy doctor`'s check for records a narrowed visibility policy no longer allows.
 *
 * **Narrowing `allowed` never rewrites a record.** Making a public file private breaks every link already
 * published — and for media each one is a Cloudflare call before its bytes are signed — so the kit does
 * not do it behind anyone's back. A write that would create a record outside the policy is refused; the
 * records already outside it are named, here, per deployed environment, and moving them is the adopter's
 * explicit act.
 *
 * The local tier says nothing: which records exist is a fact about a deployed database, which only the
 * account tier can read. An unprovisioned environment, or an account that cannot be reached, is unchecked
 * rather than clean.
 */
export interface RecordsOutsidePolicyOptions {
  /** The capability, for the finding's wording — `media`, `storage`. */
  readonly capability: string;
  /** What one record is called, for the finding's wording — `media record`, `file`. */
  readonly noun: string;
  /** The table the records live in, as named in SQL. */
  readonly table: string;
  /** The resolved policy this Worker composes. */
  readonly policy: VisibilityPolicy;
  /** How to move one record to an allowed level — the route or the call. */
  readonly remedy: string;
}

/** The settings check: every record outside the policy, named, per deployed environment. */
export function recordsOutsidePolicy(options: RecordsOutsidePolicyOptions): CapabilitySettings {
  const levels = outsidePolicy(options.policy);
  return {
    local: () => [],
    async account(context) {
      if (levels.length === 0) return [];
      const findings: SettingsFinding[] = [];
      for (const environment of context.environments) {
        if (environment.name === "dev") continue;
        const ids = await context.account.appRows({
          environment: environment.name,
          workerDirectory: context.workerDirectory,
          table: options.table,
          column: "visibility",
          values: levels,
        });
        if (ids.length === 0) continue;
        const plural = ids.length === 1 ? options.noun : `${options.noun}s`;
        findings.push({
          setting: `${options.capability} visibility.allowed`,
          environment: environment.name,
          problem: `${ids.length} ${plural} ${ids.length === 1 ? "is" : "are"} ${levels.join(" or ")}, which visibility.allowed (${options.policy.allowed.join(", ")}) no longer allows: ${ids.join(", ")}.`,
          action: `Nothing is rewritten for you. ${options.remedy}, or widen visibility.allowed in ${context.workerDirectory}'s pithy.config.ts.`,
        });
      }
      return findings;
    },
  };
}
