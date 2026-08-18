// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { HostEnvReport } from "../workflow/hostEnv";
import { hostEnvProviderSentence } from "../workflow/hostEnv";

/**
 * How a capability checks that its own settings **work** — the seam `pithy doctor` runs (#411).
 *
 * Everything doctor asked before this was a question about *presence*: is the option key written, is the
 * binding declared, is the ledger level. So a project could be entirely green while `fromAddress` named a
 * domain nobody onboarded, the signing key was never created, `BASE_URL` was staging's URL in production's
 * config, and no mail arrived. Presence is not the same question as correctness, and only the capability
 * knows the second one.
 *
 * ## It hangs off the capability, never off the manifest
 *
 * The declaration sits on the {@link import("./capability").Capability} object, beside `health`, because
 * `pithy.manifest.json` looks like the obvious signal and is the wrong one: `@pithy-sh/matchmaking` and
 * `@pithy-sh/rating` are published capability packages that ship no manifest, and a manifest-keyed rule
 * skips both in silence. The CLI already holds every composed instance (`project/workerScope.ts`), so
 * discovery costs it nothing and misses nothing.
 *
 * A capability with nothing worth checking declares nothing. That is ordinary, silent, and not a fault.
 *
 * ## Two tiers, because they cost different things
 *
 * - **local** — does the value parse, is it the right shape, is it right for this environment. Free,
 *   offline, and always run. It validates through the very Zod object the capability's host Worker
 *   validates at boot ({@link hostEnvFindings} is the bridge), so the check an operator runs and the
 *   check the host runs cannot come to two answers.
 * - **account** — is the domain a zone here, does the secret exist, is the database there. One Cloudflare
 *   call, so it is opt-in and it is skipped whenever the account cannot be reached.
 *
 * Both are faults. A local finding fails `pithy doctor`'s exit; an account finding does too, **but only
 * when the account was reached** — an unreachable account is reported as *skipped*, never as a pass, and
 * gates nothing. Three answers, and a boolean can hold two of them.
 *
 * ## Nothing here writes
 *
 * A check reports. `pithy upgrade`, `pithy <capability> provision` and the commands each finding names are
 * what change anything, which is why every finding carries the action that resolves it.
 */

/** One setting that does not work, and the one thing an operator does about it. */
export const SettingsFinding = z
  .object({
    setting: z
      .string()
      .min(1)
      .describe(
        "What is wrong — the env field, config key, or account resource, spelled as the operator would find it. It leads the line, so it is the name they search for.",
      ),
    environment: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "The environment this is about, or `null` where the setting is the same in all of them. A per-environment fault is reported once per environment, because that is how many edits it takes.",
      ),
    problem: z
      .string()
      .min(1)
      .describe("Why it does not work, in one sentence. The problem line, in the same voice every PithyError uses."),
    action: z
      .string()
      .min(1)
      .describe(
        "What resolves it: the `pithy` command, the `pithy.config.ts` key, or the one-time account action. Never optional — a finding nobody can act on is a complaint.",
      ),
  })
  .describe("One capability setting that does not work, with the action that resolves it.");
export type SettingsFinding = z.infer<typeof SettingsFinding>;

/** One environment the project declares, and what this Worker's own config says about it. */
export interface SettingsEnvironment {
  /** The environment id — `dev`, `staging`, `prod`. Verbatim, never `production`. */
  name: string;
  /**
   * The origin this Worker answers on in that environment, or `null` where its config names none.
   *
   * Supplied by the CLI rather than resolved by the capability: which hostname an environment serves is
   * the adopter's declaration to make, and `project/domains.ts` is the one reader of it.
   */
  origin: string | null;
}

/** What a check is told about the project it is checking. Both tiers get it; the account tier gets more. */
export interface SettingsCheckContext {
  /** The root config's `name` — the leading segment of every resource this project provisions. */
  project: string;
  /** The Worker whose `pithy.config.ts` composed this capability. */
  worker: string;
  /** Every environment the project declares, in declaration order. */
  environments: readonly SettingsEnvironment[];
}

/**
 * The account questions a check may ask — a closed vocabulary, on purpose.
 *
 * Closed for the reason `CapabilityHealth` is: handing a capability a raw Cloudflare client would make
 * every capability a place a network call can be invented, and would put `@pithy-sh/cloudflare` in the
 * dependency list of packages that need none of it. Three questions cover what the first checks ask; a
 * fourth lands here, once, when a capability actually needs it.
 *
 * Every method may throw. A throw is the account failing to answer, and the runner reports that
 * capability's account tier as unchecked rather than as a pass.
 */
export interface SettingsAccountReader {
  /** Every D1 database name this account holds. */
  d1Databases(): Promise<readonly string[]>;
  /** Whether this account holds a Cloudflare zone covering the hostname — the prerequisite for onboarding it. */
  zone(hostname: string): Promise<boolean>;
  /** Whether a declared secret has a value in that environment. The name is the registry's, not a binding's. */
  secret(request: { name: string; environment: string }): Promise<boolean>;
}

/** What the account tier is told: everything the local tier gets, plus the account it may ask. */
export interface SettingsAccountContext extends SettingsCheckContext {
  /** The account, as the closed set of questions above. */
  account: SettingsAccountReader;
}

/**
 * A capability's settings check, as it hangs off the capability.
 *
 * `local` is required — a capability that declares this seam declares at least the free half of it. A
 * check that would only ever reach the account is a check that says nothing offline, and offline is where
 * most of these faults are cheapest to find.
 */
export interface CapabilitySettings {
  /** The free half. Pure, offline, and always run. */
  local(context: SettingsCheckContext): SettingsFinding[] | Promise<SettingsFinding[]>;
  /** The half that costs a Cloudflare call. Omitted where a capability has nothing to ask the account. */
  account?(context: SettingsAccountContext): Promise<SettingsFinding[]>;
}

/**
 * Turn a host env's own parse report into findings — the bridge that makes "one schema, two readers" real.
 *
 * A capability's local tier builds the env its host *would* be handed, runs {@link
 * import("../workflow/hostEnv").checkHostEnv} against its own declaration, and hands the report here. The
 * problem line is Zod's own message and the action line is {@link hostEnvProviderSentence} — the same
 * words the host writes into its log before it refuses to start. Two readers of one declaration, and no
 * second wording to drift.
 */
export function hostEnvFindings(report: HostEnvReport<unknown>, environment: string | null): SettingsFinding[] {
  return report.problems.map((problem) => ({
    setting: problem.field,
    environment,
    problem: problem.reason,
    action: hostEnvProviderSentence(problem.provider),
  }));
}
