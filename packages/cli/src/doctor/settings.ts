// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type {
  SettingsAccountReader,
  SettingsEnvironment,
  SettingsFinding,
} from "@pithy-sh/core/src/capability/settings";

/**
 * Whether each composed capability's **settings work**, as opposed to being merely present (#411).
 *
 * Every other check in this directory asks a presence question — is the option key written, is the binding
 * declared, is the ledger level. All of them can pass while `fromAddress` names a domain nobody onboarded,
 * the signing key was never created, `BASE_URL` is staging's URL in production's config, and no mail
 * arrives. Only the capability knows what its own values have to be, so the capability declares the check
 * (`@pithy-sh/core/src/capability/settings.ts`) and this runs it.
 *
 * ## What this module is, and is not
 *
 * It is the **runner**: it walks the composed instances, hands each declared check its context, collects
 * findings, and keeps a check that could not run apart from one that passed. Every source it needs is a
 * seam — the environments, the account — so the whole of it is testable without a project or a network,
 * which is the same reason `checkProjectName` takes its account probe as a parameter.
 *
 * It is not a check of its own. Nothing here knows what an email setting is, and nothing here reads a
 * `pithy.manifest.json`: discovery keys on the capability instance, because `@pithy-sh/matchmaking` and
 * `@pithy-sh/rating` ship no manifest and a manifest-keyed rule would skip them in silence.
 *
 * ## The three rules it exists to keep
 *
 * - **`null` means the question does not arise.** No composed capability declares a check, so there is
 *   nothing to report — the same fact `checkDevSecrets` reports as `null` for a project with no registry.
 *   A capability declaring nothing is ordinary, and it is silent.
 * - **A check that did not run is never rendered as a pass.** A local check that throws, and an account
 *   check the account never answered, land in {@link SettingsCheck.unchecked} — not in `findings`, and not
 *   in `checked`.
 * - **Skipped is a third answer.** When the account cannot be reached — offline, no credentials, no answer
 *   — the account tier is `skipped` with the reason, no account check runs, and nothing gates the exit.
 *   A local finding gates. An account finding gates too, because by then the account *was* reached.
 *
 * Nothing here writes. `pithy upgrade`, `pithy <capability> provision`, and the command each finding names
 * are what change anything.
 */

/** One Worker's name and the capabilities its own `pithy.config.ts` composes. */
export interface SettingsScope {
  /** The Worker, as `apps/<name>` and the health block name it. */
  name: string;
  /** Its composed capability instances, app capability included. */
  capabilities: readonly Capability[];
}

/** Which half of a check something came from. The two cost different things and gate on different terms. */
export type SettingsTier = "local" | "account";

/** One finding, plus where it was found. */
export interface SettingsFindingEntry extends SettingsFinding {
  /** The Worker whose composition produced it. */
  worker: string;
  /** The capability that reported it. */
  capability: string;
  /** Which tier reported it. */
  tier: SettingsTier;
}

/** One capability-and-tier nobody could answer for. Never a pass, and never a fault. */
export interface SettingsUnchecked {
  worker: string;
  capability: string;
  tier: SettingsTier;
}

/**
 * The check's verdict, listed positively.
 *
 * - `ok` — every check that ran passed, and nothing was left unanswered.
 * - `faults` — at least one setting does not work. This is what fails the exit.
 * - `could-not-check` — nothing is wrong that anybody established, and something could not be asked.
 */
export type SettingsState = "ok" | "faults" | "could-not-check";

/**
 * Why the account tier did not run.
 *
 * Four reasons, and they are not interchangeable in a report: `offline` is a decision somebody made,
 * `no-credentials` is a project that has not been set up, `unreachable` is a network or an account that
 * did not answer, and `not-declared` is nobody having asked the account anything. A single boolean would
 * have said "not checked" to all four, which is the conflation `CloudflareAccessState` grew `not_checked`
 * and `probe_failed` to avoid.
 */
export type SettingsAccountSkip = "offline" | "no-credentials" | "unreachable" | "not-declared";

/** Whether the account tier ran, and why not when it did not. */
export interface SettingsAccountTier {
  state: "checked" | "skipped";
  /** The reason, set exactly when `state` is `skipped`. */
  reason: SettingsAccountSkip | null;
}

/** What the whole check found, across every Worker. */
export interface SettingsCheck {
  state: SettingsState;
  /** Whether the account half ran at all. Reported whether or not it found anything. */
  account: SettingsAccountTier;
  /** Every capability whose check ran to completion, in Worker then composition order. */
  checked: { worker: string; capability: string }[];
  /** Every setting that does not work, in the order the checks reported them. */
  findings: SettingsFindingEntry[];
  /** Every capability-and-tier that could not be asked. */
  unchecked: SettingsUnchecked[];
}

/**
 * The account, or the reason there is none to ask.
 *
 * Resolved once per run and shared by every capability: the credentials are account-scoped, so asking a
 * second time could only produce a second answer to one question.
 */
export type SettingsAccountConnection =
  | { state: "reachable"; reader: SettingsAccountReader }
  | { state: "skipped"; reason: SettingsAccountSkip };

/** Everything the runner needs, all of it injectable. */
export interface CapabilitySettingsOptions {
  /** The root config's `name` — the leading segment of every name this project provisions. */
  project: string;
  /** The Workers in scope. `--worker <name>` has already narrowed this; the runner never re-enumerates. */
  workers: readonly SettingsScope[];
  /**
   * The environments a Worker declares, and the origin it answers on in each.
   *
   * Per Worker, because an origin is a Worker's own declaration — two Workers in one project answer on
   * two hostnames, and a check told otherwise would report the wrong one as drift.
   */
  environments: (worker: string) => Promise<readonly SettingsEnvironment[]>;
  /**
   * Reach the account. Called **at most once**, and only when some composed capability declares an account
   * tier — a project whose capabilities ask the account nothing pays for no call, the same rule
   * `probeAccountEvidence` follows.
   */
  connect: () => Promise<SettingsAccountConnection>;
}

/** Every composed capability that declares a check, flattened with the Worker it came from. */
function declared(workers: readonly SettingsScope[]): { worker: string; capability: Capability }[] {
  const found: { worker: string; capability: Capability }[] = [];
  for (const worker of workers) {
    for (const capability of worker.capabilities) {
      if (capability.settings) found.push({ worker: worker.name, capability });
    }
  }
  return found;
}

/**
 * Run every composed capability's settings check.
 *
 * Never throws — a diagnostic has to keep working in exactly the broken environment it exists to
 * diagnose, and the checks here are adopter-supplied code reached through a live `import()`. Every throw
 * becomes an `unchecked` entry naming the capability and the tier, which is the one actionable fact in it;
 * nothing derived from what was thrown is kept, because a capability's own failure names config paths and
 * sometimes values.
 */
export async function checkCapabilitySettings(options: CapabilitySettingsOptions): Promise<SettingsCheck | null> {
  const entries = declared(options.workers);
  // The question does not arise: no capability composed here has anything to say about its own settings.
  if (entries.length === 0) return null;

  const findings: SettingsFindingEntry[] = [];
  const unchecked: SettingsUnchecked[] = [];
  const checked: { worker: string; capability: string }[] = [];

  // Resolved once, ahead of the loop, and only when something will ask it. A second call could answer
  // differently, and a report whose two halves disagree about whether the account was reached is worse
  // than one that never asked.
  const wantsAccount = entries.some((entry) => entry.capability.settings?.account);
  const connection: SettingsAccountConnection = wantsAccount
    ? await connectQuietly(options.connect)
    : { state: "skipped", reason: "not-declared" };

  for (const { worker, capability } of entries) {
    const settings = capability.settings;
    if (!settings) continue;
    let context: { project: string; worker: string; environments: readonly SettingsEnvironment[] };
    try {
      context = { project: options.project, worker, environments: await options.environments(worker) };
    } catch {
      // Nothing was checked against nothing: without the declared set there is no environment to judge a
      // per-environment value in, and a check run against an empty list would report a clean pass.
      unchecked.push({ worker, capability: capability.name, tier: "local" });
      continue;
    }

    let ranLocal = false;
    try {
      for (const finding of await settings.local(context)) {
        findings.push({ ...finding, worker, capability: capability.name, tier: "local" });
      }
      ranLocal = true;
    } catch {
      unchecked.push({ worker, capability: capability.name, tier: "local" });
    }

    if (settings.account && connection.state === "reachable") {
      try {
        for (const finding of await settings.account({ ...context, account: connection.reader })) {
          findings.push({ ...finding, worker, capability: capability.name, tier: "account" });
        }
      } catch {
        unchecked.push({ worker, capability: capability.name, tier: "account" });
      }
    }

    if (ranLocal) checked.push({ worker, capability: capability.name });
  }

  return {
    // Listed positively, and a fault outranks an unanswered question: a project with one of each has
    // something to fix, and the line that says so must not be softened into "could not check".
    state: findings.length > 0 ? "faults" : unchecked.length > 0 ? "could-not-check" : "ok",
    account:
      connection.state === "reachable"
        ? { state: "checked", reason: null }
        : { state: "skipped", reason: connection.reason },
    checked,
    findings,
    unchecked,
  };
}

/**
 * Reach the account, and treat a throw as unreachable rather than as a lost report.
 *
 * `try`/`catch` rather than `.catch()` for the reason `commands/doctor.ts` states about its own guards: a
 * seam that throws before returning a promise is not a rejected promise, and `.catch()` never sees it.
 */
async function connectQuietly(connect: () => Promise<SettingsAccountConnection>): Promise<SettingsAccountConnection> {
  try {
    return await connect();
  } catch {
    return { state: "skipped", reason: "unreachable" };
  }
}

/**
 * One finding as one sentence — the capability, the setting, the environment it is about, then the problem
 * and the action.
 *
 * The `--json` `detail` and the source of the text block's two lines, so a consumer never has to
 * reassemble the wording from the fields. The environment is in parentheses and absent when the finding is
 * about every environment at once, which is the difference between one edit and three.
 */
export function describeSettingsFinding(entry: SettingsFindingEntry): string {
  const where = entry.environment === null ? "" : ` (${entry.environment})`;
  return `${entry.capability}: ${entry.setting}${where} — ${entry.problem} ${entry.action}`;
}

/** The account tier's own sentence — which of the four things happened, in the run's own words. */
export function describeSettingsAccount(tier: SettingsAccountTier): string {
  if (tier.state === "checked") return "account checks ran";
  if (tier.reason === "not-declared") return "no capability asks the account anything";
  const why =
    tier.reason === "offline"
      ? "offline"
      : tier.reason === "no-credentials"
        ? "no Cloudflare credentials"
        : "the account did not answer";
  // Said out loud, every time: a tier nobody ran is not a tier that passed, and the one thing a reader
  // must not take from a quiet report is that the account was checked.
  return `account checks skipped (${why}) — nothing here was established about the account`;
}
