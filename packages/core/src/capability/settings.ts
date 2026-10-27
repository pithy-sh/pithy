// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { InternalError } from "../error/pithyError";
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
    fix: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The `pithy` command that resolves it, whole and runnable as written, when one does. Absent when the remedy is an edit or an account action, and from a capability older than the field — `pithy doctor --json` reports either as `fix: null`.",
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
  /** The Worker whose `pithy.config.ts` composed this capability, by its `wrangler.jsonc` name. */
  worker: string;
  /**
   * That Worker's directory under `apps/` — the value `--worker` takes, and the one a refusal lists (#711).
   *
   * Not `worker` under another name. A scaffold deploys `apps/api` as `acme-api`, so a command a finding names
   * for one Worker is written with this.
   */
  workerDirectory: string;
  /** Every environment the project declares, in declaration order. */
  environments: readonly SettingsEnvironment[];
}

/**
 * The account questions a check may ask — a closed vocabulary, on purpose.
 *
 * Closed for the reason `CapabilityHealth` is: handing a capability a raw Cloudflare client would make
 * every capability a place a network call can be invented, and would put `@pithy-sh/cloudflare` in the
 * dependency list of packages that need none of it. A question lands here once a capability actually needs
 * it, and not before: six cover what the checks ask.
 *
 * Every method may throw. A throw is the account failing to answer, and the runner reports that
 * capability's account tier as unchecked rather than as a pass.
 */
export interface SettingsAccountReader {
  /** Every D1 database name this account holds. */
  d1Databases(): Promise<readonly string[]>;
  /** Whether this account holds a Cloudflare zone covering the hostname — the prerequisite for onboarding it. */
  zone(hostname: string): Promise<boolean>;
  /**
   * Whether that environment's **D1 vault** holds a value under this registry name — asked of its manager
   * Worker, the only thing that can open it.
   *
   * Named for the store it asks, because it used to be `secret()` — "does this secret have a value" — and
   * that question has two stores behind it (#596). A check asking it about a `cf-secrets-store` secret got a
   * confident `false` from a vault the secret never lives in. Ask {@link storeEntry} about one of those.
   */
  vaultSecret(request: { name: string; environment: string }): Promise<boolean>;
  /**
   * Whether the account's **Secrets Store** holds an entry of exactly this name. The name is the entry's, not
   * the registry's: compose it with `environmentScope(project, env).secretEntry(...)`, the namer provisioning
   * created it with, so the check looks where the value went.
   */
  storeEntry(name: string): Promise<boolean>;
  /**
   * The ids of the rows in one of the kit's own tables whose column holds one of `values`, in the app
   * database a Worker binds as `DB` in one deployed environment (#727).
   *
   * Asked by media and storage after a project narrows `visibility.allowed`: narrowing never rewrites a
   * record, so the records left outside the policy have to be *named*, and only the deployed database
   * holds them. Closed in its own way — the table must be a `pithy_` one and the column an identifier,
   * both refused otherwise, and the values are bound, never interpolated — so it reads a fact about a
   * capability's own rows and cannot become a query language.
   */
  appRows(request: AppRowsRequest): Promise<readonly string[]>;
  /**
   * Whether that environment's **D1 vault** holds a `json` secret that still carries a top-level `field` —
   * asked of its manager Worker, which opens the value and answers a bit, never the value (#728). `false`
   * for a secret that is not stored, since it carries nothing.
   *
   * Asked by media of `media-storage-credentials`, which held a supplied Cloudflare token until the runtime
   * token replaced it: the upgrade is finished only once the bundle has been rewritten without it.
   */
  vaultSecretField(request: { name: string; environment: string; field: string }): Promise<boolean>;
  /**
   * Whether the account holds a Cloudflare API token of exactly this name (#728). The name is the token's,
   * composed with the namer that minted it — never a pattern, so a check names one credential it can see.
   *
   * Asked by secrets of the manager token the runtime token superseded, which nothing revokes for you.
   */
  accountToken(name: string): Promise<boolean>;
  /**
   * **Whether an R2 bucket's objects under `prefix` are under an indefinite lock (#822)** — `locked`, `unlocked`, or
   * `missing` when no bucket of that name exists on the account. Asked by audit, whose checkpoints are evidence only
   * while nothing can replace them. Optional, so a reader built before the question existed still compiles; a
   * check asking a reader without it reports the environment unanswered rather than guessing.
   */
  r2BucketLock?(request: { bucket: string; prefix: string }): Promise<"locked" | "unlocked" | "missing">;
}

/** What {@link SettingsAccountReader.appRows} is asked. */
export interface AppRowsRequest {
  /** The deployed environment whose app database is read. `dev` is refused: it has no deployed database. */
  readonly environment: string;
  /** The Worker's `apps/` directory — whose `wrangler.jsonc` names the database for that environment. */
  readonly workerDirectory: string;
  /** The kit table, as it is named in SQL — `pithy_media_assets`. Must carry the `pithy_` prefix. */
  readonly table: string;
  /** The column compared, as it is named in SQL — `visibility`. */
  readonly column: string;
  /** The values that make a row worth naming. */
  readonly values: readonly string[];
}

/** What the account tier is told: everything the local tier gets, plus the account it may ask. */
export interface SettingsAccountContext extends SettingsCheckContext {
  /** The account, as the closed set of questions above. */
  account: SettingsAccountReader;
}

/** One environment an account check could not answer for, and why. */
export interface UnansweredEnvironment {
  /** The environment id. */
  readonly environment: string;
  /** What the account, or the project, said instead of an answer. */
  readonly cause: unknown;
}

/**
 * An account check that answered for some environments and not for others.
 *
 * A check that asks per environment must not let one unanswerable environment cost the others their
 * findings: staging stood up before prod is the ordinary bring-up, and a check that threw on prod's missing
 * database would throw away what it had already found in staging. So it collects what it can, and throws
 * this at the end carrying those findings. The runner reports them as findings and the tier as unchecked,
 * both — a fault and an unanswered question are two facts, and neither hides the other.
 */
export class SettingsAccountIncomplete extends InternalError {
  /** What the environments that did answer were found to have wrong. */
  readonly findings: readonly SettingsFinding[];
  /** The environments that did not answer, in the order they were asked. */
  readonly unanswered: readonly string[];

  constructor(findings: readonly SettingsFinding[], unanswered: readonly UnansweredEnvironment[]) {
    const reasons = unanswered.map(({ environment, cause }) => `${environment}: ${describeCause(cause)}`).join("; ");
    super(
      {
        message: `The account check could not answer for ${unanswered.map(({ environment }) => environment).join(", ")}.`,
        detail: reasons,
      },
      { cause: unanswered[0]?.cause },
    );
    this.findings = findings;
    this.unanswered = unanswered.map(({ environment }) => environment);
  }
}

/** A cause, as one line. */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The findings an account check reached before it threw — none for an ordinary throw, and what it had
 * collected for a {@link SettingsAccountIncomplete}.
 */
export function settingsFindingsBefore(error: unknown): readonly SettingsFinding[] {
  return error instanceof SettingsAccountIncomplete ? error.findings : [];
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
 * **Two or more checks on one capability, as the one `settings` it declares (#728).** Media names records a
 * narrowed visibility no longer admits and a bundle still holding a superseded token: two questions, one
 * capability, one seam.
 *
 * Each tier runs every check's, in declaration order. A check that could not answer for some environments
 * costs those environments and nothing else: the others' findings are kept, and the run ends in one
 * {@link SettingsAccountIncomplete} carrying every finding and every unanswered environment. A check that
 * throws outright is unanswered for every environment the context declares.
 */
export function allSettings(...checks: readonly CapabilitySettings[]): CapabilitySettings {
  const accounts = checks.flatMap((check) => (check.account ? [check.account.bind(check)] : []));
  return {
    async local(context) {
      const findings: SettingsFinding[] = [];
      for (const check of checks) findings.push(...(await check.local(context)));
      return findings;
    },
    ...(accounts.length === 0
      ? {}
      : {
          async account(context) {
            const findings: SettingsFinding[] = [];
            const unanswered: UnansweredEnvironment[] = [];
            for (const account of accounts) {
              try {
                findings.push(...(await account(context)));
              } catch (cause) {
                findings.push(...settingsFindingsBefore(cause));
                if (cause instanceof SettingsAccountIncomplete) {
                  for (const environment of cause.unanswered) {
                    if (!unanswered.some((entry) => entry.environment === environment)) {
                      unanswered.push({ environment, cause: cause.cause ?? cause });
                    }
                  }
                  continue;
                }
                // With no environment to name, there is nothing the throw could be reported against.
                if (context.environments.length === 0) throw cause;
                for (const { name } of context.environments) {
                  if (!unanswered.some((entry) => entry.environment === name))
                    unanswered.push({ environment: name, cause });
                }
              }
            }
            if (unanswered.length > 0) throw new SettingsAccountIncomplete(findings, unanswered);
            return findings;
          },
        }),
  };
}

/**
 * Turn a host env's own parse report into findings — the bridge that makes "one schema, two readers" real.
 *
 * A capability's local tier builds the env its host *would* be handed, runs {@link
 * import("../workflow/hostEnv").checkHostEnv} against its own declaration, and hands the report here. The
 * problem line is Zod's own message and the action line is {@link hostEnvProviderSentence} — the same
 * words the host writes into its log before it refuses to start. Two readers of one declaration, and no
 * second wording to drift. A provider that names a command carries it as `fix` too.
 */
export function hostEnvFindings(report: HostEnvReport<unknown>, environment: string | null): SettingsFinding[] {
  return report.problems.map((problem) => ({
    setting: problem.field,
    environment,
    problem: problem.reason,
    action: hostEnvProviderSentence(problem.provider),
    // The provider's own command, where it names one, as the finding's `fix` (#697): the same words the action
    // line runs, without the sentence around them.
    ...(problem.provider.command === undefined ? {} : { fix: problem.provider.command }),
  }));
}
