// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ValidationError } from "../error/pithyError";

/**
 * How a capability says what erasing one subject means for its own rows — the purge contribution.
 *
 * ## Why a contribution, and not a cascade
 *
 * A hard delete has to reach rows that `@pithy-sh/media`, `@pithy-sh/support`, `@pithy-sh/testers` and the
 * adopter's own tables hold, and no foreign key reaches across capabilities: each owns its tables, and none
 * references another's. So the only party that knows how one person's rows are erased — deleted outright,
 * or anonymized because a ledger must still add up — is the capability that owns them. It says so here,
 * the way it states its migrations and its seeds, and the purge runs what was composed.
 *
 * ## One capability, one step
 *
 * The purge Workflow (#622) runs every composed contribution as **its own step**, named for the
 * capability. A step that fails retries alone, and the ones that finished are not re-run — which is why a
 * capability may declare at most one contribution per subject, and why every `erase` must be idempotent:
 * a step is retried after a failure that may have come after its rows were already gone, and erasing
 * nothing must then succeed.
 *
 * ## An adopter declares one too
 *
 * On their own `app` capability, for their own tables, with the same types. The contract is exported for
 * exactly that, and nothing distinguishes a kit contribution from theirs.
 */

/**
 * The kinds of subject a purge erases. Closed, so a typo is refused where it is written rather than becoming
 * a contribution no purge ever asks for. `organization` joins when organization state does (#623).
 */
export const PurgeSubject = z
  .enum(["user"])
  .describe(
    "The kind of subject a purge erases. `user` is one person's account in `@pithy-sh/auth`, identified by its user id.",
  );
export type PurgeSubject = z.output<typeof PurgeSubject>;

/** What one step is handed: who is being erased, and this run's bindings. */
export interface PurgeContext {
  /** The subject being erased — its kind, and its id in that kind's own table. */
  readonly subject: { readonly type: PurgeSubject; readonly id: string };
  /** The Worker's bindings for this run, from which the contribution opens its own database. */
  readonly env: Record<string, unknown>;
}

/** One capability's answer to "how are this subject's rows erased". */
export interface PurgeContribution {
  /** The kind of subject this erases. */
  readonly subject: PurgeSubject;
  /**
   * One sentence on what is erased or anonymized — `Deletes the user's uploads and their stored bytes.`
   * Recorded with the step that ran it, so the trail says what a purge did and not only that it ran.
   */
  readonly summary: string;
  /**
   * Erase or anonymize this subject's rows. **Idempotent**: run again after it succeeded, or after a failure
   * that came once the rows were gone, it must succeed having found nothing to do. Throwing fails this step
   * and only this step.
   */
  readonly erase: (context: PurgeContext) => Promise<void>;
}

/** One step of a purge: which capability it runs, and the contribution that capability declared. */
export interface PurgeStep {
  /** The step's name — the capability's, so a retried step names who failed. */
  readonly step: string;
  /** The contribution this step runs. */
  readonly contribution: PurgeContribution;
}

/**
 * Refuse a capability's purge contributions that no purge could run as declared: an unknown subject, two for
 * one subject, or one with nothing to record. Called by `defineCapability`, so the refusal names the capability
 * where it is written rather than surfacing in a Workflow on the day somebody is deleted.
 */
export function assertPurgeContributions(capability: string, contributions: readonly PurgeContribution[]): void {
  const seen = new Set<string>();
  for (const contribution of contributions) {
    const subject = PurgeSubject.safeParse(contribution.subject);
    if (!subject.success) {
      throw new ValidationError({
        message: `The ${capability} capability declares a purge for "${String(contribution.subject)}", which is not a subject a purge erases.`,
        action: `Declare it for one of: ${PurgeSubject.options.join(", ")}.`,
      });
    }
    if (seen.has(subject.data)) {
      throw new ValidationError({
        message: `The ${capability} capability declares two purge contributions for ${subject.data}.`,
        action: "Fold them into one: each capability is one step of the purge, and a retried step re-runs all of it.",
      });
    }
    seen.add(subject.data);
    if (contribution.summary.trim() === "") {
      throw new ValidationError({
        message: `The ${capability} capability's ${subject.data} purge has no summary.`,
        action: "Say in one sentence what it erases. The purge records it with the step.",
      });
    }
    if (typeof contribution.erase !== "function") {
      throw new ValidationError({
        message: `The ${capability} capability's ${subject.data} purge has no erase function.`,
        action: "Give it an `erase` that removes or anonymizes the subject's rows.",
      });
    }
  }
}

/** The steps a purge of `subject` runs, in composition order — libraries first, the adopter's `app` last. */
export function purgeSteps(
  capabilities: readonly { readonly name: string; readonly purge?: readonly PurgeContribution[] }[],
  subject: PurgeSubject,
): PurgeStep[] {
  const steps: PurgeStep[] = [];
  for (const capability of capabilities) {
    const contribution = capability.purge?.find((candidate) => candidate.subject === subject);
    if (contribution) steps.push({ step: capability.name, contribution });
  }
  return steps;
}
