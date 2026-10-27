// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { InternalError, ValidationError } from "../error/pithyError";

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
 * ## Or it keeps them, and says why (#814)
 *
 * Not every row about a person should go. A payment record is kept for tax law, a suppression has to outlive the
 * person or the unsubscribe stops holding, and the audit trail is the record of who acted. So a contribution has a
 * third disposition beside erase and anonymize: `retain`, with a one-sentence basis written for the person. The
 * purge records that step as retained and erases nothing of it; the export carries the rows and the basis.
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
  /**
   * The subject's email address, read on demand from the capability that owns the subject — `null` when it has
   * none, or no longer has one (#814). For a capability that holds rows by address rather than by id: a tester's
   * membership, a suppression, an invitation.
   *
   * **A function, never a value**, so the address is read inside the step that needs it and is never carried in
   * a Workflow's journal, where a purge would otherwise leave it behind. Absent where nobody can say, and a
   * contribution that needs it then finds nothing by address.
   */
  readonly address?: () => Promise<string | null>;
}

/** What every contribution says, whichever its disposition. */
interface PurgeContributionBase {
  /** The kind of subject this erases. */
  readonly subject: PurgeSubject;
  /**
   * One sentence on what is erased, anonymized or kept — `Deletes the user's uploads and their stored bytes.`
   * Recorded with the step that ran it, so the trail says what a purge did and not only that it ran.
   */
  readonly summary: string;
  /**
   * What this capability holds about the subject, as one JSON object — the read side of `erase` (#622). It
   * answers an access request, so it carries the subject's own data and never a credential: no session token,
   * no provider token, no push token. Optional on an erasing contribution: one without it is listed in the
   * export as rows it erases and did not say how to export. A throw costs this capability's entry, never the
   * document.
   */
  readonly export?: (context: PurgeContext) => Promise<Record<string, unknown>>;
}

/** A contribution that erases or anonymizes the subject's rows. */
export interface ErasingPurgeContribution extends PurgeContributionBase {
  /**
   * Erase or anonymize this subject's rows. **Idempotent**: run again after it succeeded, or after a failure
   * that came once the rows were gone, it must succeed having found nothing to do. Throwing fails this step
   * and only this step.
   */
  readonly erase: (context: PurgeContext) => Promise<void>;
  /** Never set on an erasing contribution. */
  readonly retain?: undefined;
}

/**
 * A contribution that **keeps** the subject's rows through a purge, and says why (#814). A payment record kept
 * for tax law, a suppression that must outlive the person or the unsubscribe stops holding, the audit trail of
 * who acted. The purge records the step as retained and never erases a row of it; the export carries the rows
 * and the basis, because rows that are kept are rows that are answered for.
 */
export interface RetainingPurgeContribution extends PurgeContributionBase {
  /** Why the rows are kept, in one sentence written for the person — `Kept for tax records.` */
  readonly retain: { readonly basis: string };
  /** Required: what is kept is exported. */
  readonly export: (context: PurgeContext) => Promise<Record<string, unknown>>;
  /** Never set on a retaining contribution. */
  readonly erase?: undefined;
}

/** One capability's answer to "what happens to this subject's rows": erased, anonymized, or kept and why. */
export type PurgeContribution = ErasingPurgeContribution | RetainingPurgeContribution;

/** What a purge does with a contribution's rows: `erase` (or anonymize), or `retain`. */
export type PurgeDisposition = "erase" | "retain";

/** Whether a contribution keeps the subject's rows rather than erasing them. */
export function isRetained(contribution: PurgeContribution): contribution is RetainingPurgeContribution {
  return contribution.retain !== undefined;
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
    if (contribution.retain !== undefined) {
      assertRetention(capability, subject.data, contribution);
      continue;
    }
    if (typeof contribution.erase !== "function") {
      throw new ValidationError({
        message: `The ${capability} capability's ${subject.data} purge has no erase function.`,
        action:
          "Give it an `erase` that removes or anonymizes the subject's rows, or a `retain` that says why it keeps them.",
      });
    }
  }
}

/** Refuse a retaining contribution the person could not be answered with: no basis, no export, or an erase too. */
function assertRetention(capability: string, subject: PurgeSubject, contribution: PurgeContribution): void {
  const basis = (contribution.retain as { basis?: unknown } | undefined)?.basis;
  if (typeof basis !== "string" || basis.trim() === "") {
    throw new ValidationError({
      message: `The ${capability} capability's ${subject} purge retains the rows with no basis.`,
      action: "Say in one sentence, written for the person, why they are kept — `Kept for tax records.`",
    });
  }
  if (typeof contribution.export !== "function") {
    throw new ValidationError({
      message: `The ${capability} capability's ${subject} purge retains the rows and has no export.`,
      action: "Give it an `export`: rows that are kept are rows an access request is answered with.",
    });
  }
  if (contribution.erase !== undefined) {
    throw new ValidationError({
      message: `The ${capability} capability's ${subject} purge both retains and erases the rows.`,
      action: "Declare one disposition: `retain` with its basis, or `erase`.",
    });
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

/** What every export entry says: the capability, its sentence, and what a purge does with its rows. */
interface PurgeExportEntryBase {
  readonly capability: string;
  readonly summary: string;
  /** `erase` — a purge erases or anonymizes these rows — or `retain`, a purge keeps them (#814). */
  readonly disposition: PurgeDisposition;
  /** For `retain`, why the rows are kept, in the sentence the contribution wrote for the person. */
  readonly basis?: string;
}

/** What one step's export answered: its data, that it declared none, or that it could not be read. */
export type PurgeExportEntry =
  | (PurgeExportEntryBase & { readonly state: "exported"; readonly data: Record<string, unknown> })
  | (PurgeExportEntryBase & { readonly state: "not_exported" })
  | (PurgeExportEntryBase & { readonly state: "unavailable" });

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
      const base: PurgeExportEntryBase = isRetained(contribution)
        ? { capability: step, summary: contribution.summary, disposition: "retain", basis: contribution.retain.basis }
        : { capability: step, summary: contribution.summary, disposition: "erase" };
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

/**
 * One binding a contribution opens off a run's env — or a wiring fault naming it and the capability (#814). The
 * purge and the export both run in the adopter's Worker, so a missing binding is that Worker's wiring, and the
 * fault says which binding to add rather than failing deep inside a query.
 */
export function purgeBinding<T>(
  env: Record<string, unknown>,
  name: string,
  capability: string,
  kind = "D1 database",
): T {
  const binding = env[name];
  if (typeof binding !== "object" || binding === null) {
    throw new InternalError({
      message: `The ${capability} capability's ${kind} is not bound, so its purge step could not run.`,
      action: `Bind the ${kind} named ${name} to the Worker that runs the purge.`,
      detail: `${capability} purge contribution found no ${name} binding on the env`,
    });
  }
  return binding as T;
}

/**
 * Rows as an export carries them (#814): plain JSON, a `Date` as its ISO-8601 string — the shape the export
 * document crosses the wire in, so what a contribution answers is what a reader parses, and a test compares
 * exactly that.
 */
export function exportRows<T>(rows: readonly T[]): Record<string, unknown>[] {
  return JSON.parse(JSON.stringify(rows)) as Record<string, unknown>[];
}

/**
 * A field name that holds a credential — a token, a secret, a password, a digest of one, a sealed value. What an
 * export never carries (#814): an access request is answered with what is held, never with the means to act as
 * the person or to reach what they shared.
 */
const CREDENTIAL_FIELD = /secret|token|password|credential|digest|private_?key|encrypted/i;

/**
 * Every path in an export's data whose field name holds a credential — empty for an export that carries none.
 * Each capability's export test asserts it empty, so a column added later with a token in it fails the build
 * rather than reaching an access request (#814).
 */
export function credentialFields(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => credentialFields(item, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => {
    const here = path ? `${path}.${key}` : key;
    return [...(CREDENTIAL_FIELD.test(key) ? [here] : []), ...credentialFields(inner, here)];
  });
}
