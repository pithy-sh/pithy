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
 * ## The same contribution answers an export (#622)
 *
 * An access request arrives before an erasure, not after. So a contribution may also say what this capability
 * holds about the subject, on the read side: `export` answers one JSON object, and the control plane's export
 * route assembles one document from every composed contribution, in the same order the purge runs them. A
 * contribution with no `export` is listed as holding rows it did not say how to export, which is the honest
 * answer and the one an operator can act on.
 *
 * ## An adopter declares one too
 *
 * On their own `app` capability, for their own tables, with the same types. The contract is exported for
 * exactly that, and nothing distinguishes a kit contribution from theirs.
 */

/**
 * The kinds of subject a purge erases. Closed, so a typo is refused where it is written rather than becoming
 * a contribution no purge ever asks for. `organization` joined with organization state (#623): a capability
 * holding rows scoped to a tenant declares one for it, and the organization purge runs it.
 */
export const PurgeSubject = z
  .enum(["user", "organization"])
  .describe(
    "The kind of subject a purge erases. `user` is one person's account in `@pithy-sh/auth`, identified by its user id. `organization` is one tenant in `@pithy-sh/organization`, identified by its organization id.",
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
  /**
   * What this capability holds about the subject, as one JSON object — the read side of `erase` (#622). It
   * answers an access request, so it carries the subject's own data and never a credential: no session token,
   * no provider token, no push token. Optional: a contribution without one is listed in the export as rows it
   * erases and did not say how to export. A throw costs this capability's entry, never the document.
   */
  readonly export?: (context: PurgeContext) => Promise<Record<string, unknown>>;
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
    if (contribution.export !== undefined && typeof contribution.export !== "function") {
      throw new ValidationError({
        message: `The ${capability} capability's ${subject.data} purge has an export that is not a function.`,
        action: "Give it an `export` that answers what this capability holds about the subject, or leave it out.",
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

/** What one step's export answered: its data, that it declared none, or that it could not be read. */
export type PurgeExportEntry =
  | {
      readonly capability: string;
      readonly summary: string;
      readonly state: "exported";
      readonly data: Record<string, unknown>;
    }
  | { readonly capability: string; readonly summary: string; readonly state: "not_exported" }
  | { readonly capability: string; readonly summary: string; readonly state: "unavailable" };

/** Whether an export answered what the contract promises: one plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read every step's export for one subject — the export document's body, in step order (#622).
 *
 * **Each read is guarded on its own and they run concurrently**, the shape the user pane's sub-reads have
 * (#380): one capability whose table will not read costs its own entry as `unavailable`, and the rest of the
 * document still answers the request. What the read threw is not carried — it names a query and a table, and
 * the document crosses a trust boundary. An answer that is not one object is `unavailable` too, because the
 * document promises an object per capability and a client validates it.
 */
export async function purgeExports(steps: readonly PurgeStep[], context: PurgeContext): Promise<PurgeExportEntry[]> {
  return Promise.all(
    steps.map(async ({ step, contribution }): Promise<PurgeExportEntry> => {
      const base = { capability: step, summary: contribution.summary };
      const read = contribution.export;
      if (read === undefined) return { ...base, state: "not_exported" };
      try {
        const data = await read(context);
        return isRecord(data) ? { ...base, state: "exported", data } : { ...base, state: "unavailable" };
      } catch {
        return { ...base, state: "unavailable" };
      }
    }),
  );
}
