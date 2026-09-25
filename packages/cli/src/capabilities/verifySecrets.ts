// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **`pithy secrets verify` — the detector, its verdict, and its exit code.**
 *
 * Kept out of the command body for the reason `rotateSecrets.ts` is: a state and the sentence describing
 * it need one producer each, or a partial run gets phrased as a complete one.
 *
 * ## Four exit codes, because a script has to tell a finding from a fault
 *
 * - **0** — verified, or *withheld*. Nothing was found. `--json` still says which, and a withheld verdict
 *   never reads as a clean one in the field an agent keys on.
 * - **1** — the command could not run: an environment's manager did not answer. Retryable, and the code
 *   every ordinary failure already uses.
 * - **4** — {@link EXIT_STORE_UNVERIFIED}. Something was found. Nobody should retry this; somebody has to
 *   look.
 * - **5** — {@link EXIT_MASTER_KEY_UNREADABLE}. The master key will not resolve. Its own code because it
 *   is its own repair, and because reporting it as 1 tells a cron to keep retrying the one state that
 *   will never fix itself (D15).
 *
 * **A finding outranks a fault.** One flaky environment beside one broken store used to exit 1 —
 * the finding masked by the fault, which is exactly what a distinct code exists to prevent. So the
 * verdict is taken over every environment that *did* answer, and the unreachable one keeps its own
 * rendered line. (It also keeps the report out of `withErrorReporting`'s `process.exit(1)`, which does
 * not flush a pending write to a pipe — under `| tee` the report printed first could be truncated.)
 *
 * ## What is printed
 *
 * Counts, key versions, and store entry names. Never a secret's name, never a value, never what a
 * decrypt failure said — {@link StoreVerification} has no field that could carry one, and the sweep's
 * entry names are Secrets Store addresses rather than secrets. An entry with no project segment is
 * printed with the sentence saying it cannot be attributed to this project, because `SECRETS_ENCRYPTION_KEYS`
 * is a name a sibling project in the same account produces too, and this report must not be the reason
 * somebody deletes one.
 */

import type { StoreVerification } from "@pithy-sh/secrets/src/admin/verifyStore";
import type { SecretStoreVerifier } from "@pithy-sh/secrets/src/cli/dispatch";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { classifyStoreEntry, type StoreEntryCensus, type StoreEntryClass } from "./storeEntryCensus";

/**
 * The exit status for **the store was read and something is wrong with it**.
 *
 * Distinct from `1`, which means the command could not run and the operator should try again, and from
 * `3` (`EXIT_ROLLED_NOT_RECORDED`), which is a different irreversible state entirely. `2` stays with
 * citty and the shell for usage errors.
 */
export const EXIT_STORE_UNVERIFIED = 4;

/**
 * The exit status for **`SECRETS_ENCRYPTION_KEYS` will not resolve** (D15).
 *
 * The #647 end state, and the one thing in this command that must never be reported as retryable. The
 * remedy is to look at what the binding resolves to, which no number of retries performs.
 */
export const EXIT_MASTER_KEY_UNREADABLE = 5;

/** One environment's answer, or the fact that it gave none. */
export interface EnvironmentVerification {
  /** The environment asked. */
  env: ManagedEnvironment;
  /** `verified` when its manager answered — whatever the answer said. `unreachable` when it did not. */
  state: "verified" | "unreachable";
  /** The manager's account of its store. Present exactly when `state` is `verified`. */
  verification?: StoreVerification;
  /** What stopped the ask. Present exactly when `state` is `unreachable`; rendered by the caller, never here. */
  cause?: unknown;
}

/** What the store sweep found, with the names it is entitled to print. */
export interface StoreSweep {
  /** How many listed entries fell into each class. Always complete, whatever was withheld. */
  counts: Record<StoreEntryClass, number>;
  /** Bare names this project's registry supplies. Always reported — see the module docblock. */
  unscoped: string[];
  /** Scoped names nothing composes. Empty when the orphan verdict was withheld. */
  orphans: string[];
  /** Master-key-shaped names nothing composes. Never debris, and empty when the verdict was withheld. */
  keyMaterial: string[];
  /** Scoped names in a scope this checkout does not declare. Empty when the verdict was withheld. */
  unknownScope: string[];
  /** Why the orphan verdict was not computed, or null when it was. */
  withheld: string | null;
}

/** Everything one run of the command established. */
export interface VerificationReport {
  /** One entry per environment asked, in the order asked. */
  environments: EnvironmentVerification[];
  /** What the store sweep found, or null when no sweep ran. */
  sweep: StoreSweep | null;
  /** Why no sweep ran, or null when one did (or when none was asked for). */
  notSwept: string | null;
}

/** The whole answer, in one word. */
export type VerificationVerdict = "verified" | "withheld" | "failed" | "key-unreadable";

/** Ask each environment's manager in turn. One environment's silence never costs another its answer. */
export async function runSecretsVerification(options: {
  verifier: SecretStoreVerifier;
  environments: readonly ManagedEnvironment[];
}): Promise<EnvironmentVerification[]> {
  const out: EnvironmentVerification[] = [];
  for (const env of options.environments) {
    try {
      out.push({ env, state: "verified", verification: await options.verifier.verifyStore({ env }) });
    } catch (cause) {
      // Recorded rather than thrown, so the environments after this one are still asked. The caller
      // decides whether it ends the run — and a finding elsewhere outranks it.
      out.push({ env, state: "unreachable", cause });
    }
  }
  return out;
}

/**
 * Classify every listed entry against the census.
 *
 * The `unscoped` class survives a withheld verdict and the other three do not. `unscoped` is a positive
 * membership test against names the registry supplies and does not depend on the accounted set being
 * complete; `orphan` is the *absence* of a composed name, which an incomplete census cannot establish.
 * Suppressing both would silence the one check that finds #647's fingerprint in exactly the projects
 * whose provisioning is least tidy.
 */
export function sweepStoreEntries(entries: readonly string[], census: StoreEntryCensus): StoreSweep {
  const counts: Record<StoreEntryClass, number> = {
    accounted: 0,
    unscoped: 0,
    orphan: 0,
    "key-material": 0,
    "unknown-scope": 0,
    feature: 0,
    foreign: 0,
  };
  const sweep: StoreSweep = {
    counts,
    unscoped: [],
    orphans: [],
    keyMaterial: [],
    unknownScope: [],
    withheld: census.unresolved,
  };
  for (const entry of entries) {
    const classification = classifyStoreEntry(entry, census);
    counts[classification] += 1;
    if (classification === "unscoped") sweep.unscoped.push(entry);
    if (census.unresolved !== null) continue;
    if (classification === "orphan") sweep.orphans.push(entry);
    if (classification === "key-material") sweep.keyMaterial.push(entry);
    if (classification === "unknown-scope") sweep.unknownScope.push(entry);
  }
  return sweep;
}

/** Whether one environment's account of its store holds a finding. */
function environmentFailed(verification: StoreVerification): boolean {
  if (verification.keySet === "unreadable") return true;
  if (verification.unreadable > 0) return true;
  if (verification.currentVersion === null || !verification.currentVersionHeld) return true;
  // A live at-rest pass is the one state where a missing version may be a key that has not propagated
  // yet. The Worker already re-read the binding; this is the second guard, and it says re-run rather
  // than pointing an operator at the master key.
  return verification.missingVersions.length > 0 && !verification.rotationInProgress;
}

/** Whether any environment reports a master key that will not resolve. */
function anyKeyUnreadable(report: VerificationReport): boolean {
  return report.environments.some((entry) => entry.verification?.keySet === "unreadable");
}

/**
 * The verdict over the whole run.
 *
 * Precedence, worst first: an unresolvable master key, then any other finding, then a withheld sweep,
 * then verified. An unreachable environment is not in this ordering at all — it is a fault rather than a
 * finding, and the caller rethrows it only when nothing was found.
 */
export function verificationVerdict(report: VerificationReport): VerificationVerdict {
  if (anyKeyUnreadable(report)) return "key-unreadable";
  const found =
    report.environments.some((entry) => entry.verification !== undefined && environmentFailed(entry.verification)) ||
    (report.sweep?.unscoped.length ?? 0) > 0 ||
    // **A stray master key is a finding, and this is the one the command exists for (#647 review).** It was
    // collected, rendered and then not counted: the run printed `Key material: …` and exited 0 as `verified`.
    // A master-key-shaped entry no composed name accounts for is the exact debris the sibling outage left —
    // a second entry holding a key beside the real one — so it cannot be the one class that reads as healthy.
    (report.sweep?.keyMaterial.length ?? 0) > 0 ||
    (report.sweep?.orphans.length ?? 0) > 0;
  if (found) return "failed";
  // A sweep that did not happen, or one that could not complete, must never read as one that found
  // nothing. It is not a failure either — nobody has been shown evidence of anything.
  if (report.notSwept !== null || report.sweep?.withheld != null) return "withheld";
  return "verified";
}

/** The exit status a verdict produces. See the module docblock for why each is its own. */
export function verificationExitCode(verdict: VerificationVerdict): number {
  if (verdict === "key-unreadable") return EXIT_MASTER_KEY_UNREADABLE;
  if (verdict === "failed") return EXIT_STORE_UNVERIFIED;
  return 0;
}

/** The first environment that gave no answer, for the caller to rethrow once nothing was found. */
export function firstUnreachable(report: VerificationReport): unknown | undefined {
  return report.environments.find((entry) => entry.state === "unreachable")?.cause;
}

/** One environment's lines. Counts and versions; never a name, a value, or a failure's own text. */
function environmentLines(entry: EnvironmentVerification): string[] {
  if (entry.state === "unreachable" || entry.verification === undefined) {
    return [`${entry.env}: no answer. The manager could not be reached.`];
  }
  const verification = entry.verification;
  if (verification.keySet === "unreadable") {
    return [
      `${entry.env}: the master key will not resolve. ${verification.rows} stored ${rowWord(verification.rows)}, none opened.`,
      `Check what SECRETS_ENCRYPTION_KEYS resolves to for ${entry.env}. Nothing in this store can be read until it does.`,
    ];
  }
  const lines = [
    `${entry.env}: ${verification.readable} of ${verification.rows} ${rowWord(verification.rows)} opened. Key versions ${versionList(verification)}.`,
  ];
  if (verification.unreadable > 0) {
    lines.push(`${verification.unreadable} stored ${rowWord(verification.unreadable)} would not open.`);
  }
  if (verification.missingVersions.length > 0) {
    lines.push(
      `Rows reference key ${versionWord(verification.missingVersions)} ${verification.missingVersions.join(", ")}, which SECRETS_ENCRYPTION_KEYS does not hold.`,
    );
    lines.push(
      verification.rotationInProgress
        ? "An at-rest rotation is running. Run this again once it finishes."
        : "Find out what removed that key version before changing anything. Restoring it is the repair, and it is the one value a wrong edit makes unrecoverable.",
    );
  }
  if (verification.currentVersion === null) {
    lines.push("The active key pointer is not a version number. Every new write will fail.");
  } else if (!verification.currentVersionHeld) {
    lines.push(
      `The active key pointer is version ${verification.currentVersion}, which SECRETS_ENCRYPTION_KEYS does not hold. Every new write will fail.`,
    );
  }
  return lines;
}

/** `row` / `rows`. */
function rowWord(count: number): string {
  return count === 1 ? "row" : "rows";
}

/** `version` / `versions`. */
function versionWord(versions: readonly number[]): string {
  return versions.length === 1 ? "version" : "versions";
}

/** The histogram on one line: `1 (12 rows), 2 (3 rows)`, or `none` for an empty store. */
function versionList(verification: Extract<StoreVerification, { keySet: "resolved" }>): string {
  if (verification.keyVersions.length === 0) return "none";
  return verification.keyVersions.map((bar) => `${bar.keyVersion} (${bar.rows} ${rowWord(bar.rows)})`).join(", ");
}

/** The sweep's lines. */
function sweepLines(report: VerificationReport): string[] {
  if (report.notSwept !== null) return [`Store not swept. ${report.notSwept}`];
  const sweep = report.sweep;
  if (sweep === null) return [];
  const lines = [`Store: ${sweep.counts.accounted} accounted, ${sweep.counts.foreign} another project's.`];
  for (const entry of sweep.unscoped) {
    lines.push(`Unscoped entry: ${entry}. Something wrote a name it composed itself.`);
  }
  if (sweep.unscoped.length > 0) {
    // The name carries no project segment, so it cannot be attributed to this project. A sibling project
    // hitting the same defect produces the identical name, and this report must not be why it is deleted.
    lines.push("An unscoped name says nothing about which project wrote it. Find out before removing one.");
  }
  for (const entry of sweep.orphans) lines.push(`Orphan: ${entry}. No composed name accounts for it.`);
  for (const entry of sweep.keyMaterial) {
    lines.push(`Key material: ${entry}. No composed name accounts for it. Removing it makes a store unreadable.`);
  }
  for (const entry of sweep.unknownScope) {
    lines.push(`Unrecognized scope: ${entry}. This checkout does not declare that environment.`);
  }
  if (sweep.withheld !== null) lines.push(`Orphan verdict withheld. ${sweep.withheld}`);
  return lines;
}

/** Every line an operator reads, in order. */
export function verificationReportLines(report: VerificationReport): string[] {
  return [...report.environments.flatMap(environmentLines), ...sweepLines(report)];
}

/** The one `--json` object. `verdict` is the field an agent keys on; `verified` is its boolean shorthand. */
export function verificationJson(report: VerificationReport): Record<string, unknown> {
  const verdict = verificationVerdict(report);
  return {
    command: "secrets verify",
    verdict,
    // A withheld verdict is not a clean one. The boolean exists because a gate wants one, and it is
    // false for anything but a run that actually established the store is sound.
    verified: verdict === "verified",
    exitCode: verificationExitCode(verdict),
    environments: report.environments.map((entry) => ({
      env: entry.env,
      state: entry.state,
      ...(entry.verification === undefined ? {} : { verification: entry.verification }),
    })),
    ...(report.sweep === null ? {} : { sweep: report.sweep }),
    ...(report.notSwept === null ? {} : { notSwept: report.notSwept }),
  };
}
