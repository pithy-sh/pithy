// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { InternalError, ValidationError } from "../error/pithyError";
import { MessageKey, messageDomain } from "../i18n/catalog";

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
 * ## One contribution, one step
 *
 * The purge Workflow runs every composed contribution as **its own step**. A step that fails retries alone, and
 * the ones that finished are not re-run — which is why every `erase` must be idempotent: a step is retried after a
 * failure that may have come after its rows were already gone, and erasing nothing must then succeed.
 *
 * A capability's one contribution for a subject is named for the capability. An `app` that composes several
 * features, each keeping a person's rows, declares one contribution per feature for that subject instead, each with
 * its own `step` name, and each runs as `<capability>/<step>` — so one failing table retries that feature's erase
 * and no other. Two for one subject without distinct step names are refused, because they would share a step.
 *
 * ## The same contribution answers an export
 *
 * An access request arrives before an erasure, not after. So a contribution may also say what this capability
 * holds about the subject, on the read side: `export` answers one JSON object, and the control plane's export
 * route assembles one document from every composed contribution, in the same order the purge runs them. A
 * contribution with no `export` is listed as holding rows it did not say how to export, which is the honest
 * answer and the one an operator can act on.
 *
 * ## Or it keeps them, and says why
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
 * a contribution no purge ever asks for. A capability holding rows scoped to a tenant declares one for
 * `organization`, and the organization purge runs it.
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
   * none, or no longer has one. For a capability that holds rows by address rather than by id: a tester's
   * membership, a suppression, an invitation.
   *
   * **A function, never a value**, so the address is read inside the step that needs it and is never carried in
   * a Workflow's journal, where a purge would otherwise leave it behind. Absent where nobody can say, and a
   * contribution that needs it then finds nothing by address.
   */
  readonly address?: () => Promise<string | null>;
  /**
   * The deletion this purge erases under: who asked, why, how, and when. Filled for an `organization` subject from
   * its lifecycle history, so a contribution can tell members or record the act without reading another
   * capability's tables. Absent for a `user` subject, and for a deletion recorded before its history kept a mode.
   */
  readonly deletion?: PurgeDeletion;
}

/** The deletion a purge runs under, as the subject's lifecycle history recorded it. */
export interface PurgeDeletion {
  /**
   * Who deleted it, as the owning capability's history names them: `type` is its actor kind (`owner`,
   * `control-plane`, `system`), `id` the person or management client, null for `system`.
   */
  readonly actor: { readonly type: string; readonly id: string | null };
  /** Why, in the deleter's words, or the fixed sentence the capability records when they gave none. */
  readonly reason: string | null;
  /** `soft`, with a window that has since closed, or `hard`, with none. */
  readonly mode: "soft" | "hard";
  /** When it was deleted. */
  readonly at: Date;
}

/** What every contribution says, whichever its disposition. */
interface PurgeContributionBase {
  /** The kind of subject this erases. */
  readonly subject: PurgeSubject;
  /**
   * This contribution's own step name, when a capability splits one subject's purge into several — `scores`,
   * `runs`. The step runs, records and exports as `<capability>/<step>`. Optional on a capability's only contribution
   * for a subject, which is named for the capability alone; required on each of several, and distinct among them.
   * A lowercase slug: letters, digits and hyphens, starting with a letter.
   */
  readonly step?: string;
  /**
   * One sentence on what is erased, anonymized or kept — `Deletes the user's uploads and their stored bytes.`
   * Recorded with the step that ran it, so the trail says what a purge did and not only that it ran.
   */
  readonly summary: string;
  /**
   * What this capability holds about the subject, as one JSON object — the read side of `erase`. It
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
 * A contribution that **keeps** the subject's rows through a purge, and says why. A payment record kept
 * for tax law, a suppression that must outlive the person or the unsubscribe stops holding, the audit trail of
 * who acted. The purge records the step as retained and never erases a row of it; the export carries the rows
 * and the basis, because rows that are kept are rows that are answered for.
 */
export interface RetainingPurgeContribution extends PurgeContributionBase {
  /**
   * Why the rows are kept, in one sentence written for the person — `Kept for tax records.` `basisKey` names the
   * catalog key that translates it, under this capability's own domain (`payments/purge.retained`); the export reads
   * it in the person's locale. `basis` is the English, and what every reader gets when no catalog has the key.
   */
  readonly retain: { readonly basis: string; readonly basisKey?: string };
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
  /**
   * The step's name — the capability's, or `<capability>/<step>` for a named contribution — so a retried step names
   * who failed. The Workflow step, the purge record and the audit event all carry it.
   */
  readonly step: string;
  /** The capability that declared the contribution. */
  readonly capability: string;
  /** The contribution this step runs. */
  readonly contribution: PurgeContribution;
}

/** A step name: a lowercase slug, so `<capability>/<step>` reads as one name and splits at one place. */
const STEP_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Refuse a capability's purge contributions that no purge could run as declared: an unknown subject, two for
 * one subject that would share a step, or one with nothing to record. Called by `defineCapability`, so the refusal
 * names the capability where it is written rather than surfacing in a Workflow on the day somebody is deleted.
 */
export function assertPurgeContributions(capability: string, contributions: readonly PurgeContribution[]): void {
  const bySubject = new Map<PurgeSubject, PurgeContribution[]>();
  for (const contribution of contributions) {
    const subject = PurgeSubject.safeParse(contribution.subject);
    if (!subject.success) {
      throw new ValidationError({
        message: `The ${capability} capability declares a purge for "${String(contribution.subject)}", which is not a subject a purge erases.`,
        action: `Declare it for one of: ${PurgeSubject.options.join(", ")}.`,
      });
    }
    bySubject.set(subject.data, [...(bySubject.get(subject.data) ?? []), contribution]);
  }
  for (const [subject, declared] of bySubject) assertStepNames(capability, subject, declared);
  for (const contribution of contributions) assertContribution(capability, contribution);
}

/**
 * Refuse step names that would not give every contribution for one subject a step of its own: a name that is not a
 * slug, an unnamed one beside others, or two sharing a name.
 */
function assertStepNames(capability: string, subject: PurgeSubject, declared: readonly PurgeContribution[]): void {
  for (const { step } of declared) {
    if (step !== undefined && (typeof step !== "string" || !STEP_NAME.test(step))) {
      throw new ValidationError({
        message: `The ${capability} capability's ${subject} purge has the step name "${String(step)}", which is not a lowercase slug.`,
        action:
          "Name the step with lowercase letters, digits and hyphens, starting with a letter — `scores`, `synced-progress`.",
      });
    }
  }
  if (declared.length < 2) return;
  const unnamed = declared.filter((each) => each.step === undefined).length;
  if (unnamed > 0) {
    const names = declared.map((each) => (each.step === undefined ? "unnamed" : `"${each.step}"`)).join(", ");
    throw new ValidationError({
      message: `The ${capability} capability declares ${declared.length} purge contributions for ${subject} (${names}), and ${unnamed} ${unnamed === 1 ? "has" : "have"} no step name.`,
      action:
        "Give each its own `step` name, so the purge runs and retries each on its own, or fold them into one contribution.",
    });
  }
  const seen = new Set<string>();
  for (const { step } of declared) {
    if (step === undefined) continue;
    if (seen.has(step)) {
      throw new ValidationError({
        message: `The ${capability} capability declares two ${subject} purge contributions with the step name "${step}".`,
        action: "Give each its own `step` name: two with one name would share a step, and a retry would re-run both.",
      });
    }
    seen.add(step);
  }
}

/** Refuse one contribution with nothing to record, an export that is not a function, or no disposition. */
function assertContribution(capability: string, contribution: PurgeContribution): void {
  const purge = purgeLabel(contribution);
  if (contribution.summary.trim() === "") {
    throw new ValidationError({
      message: `The ${capability} capability's ${purge} has no summary.`,
      action: "Say in one sentence what it erases. The purge records it with the step.",
    });
  }
  if (contribution.export !== undefined && typeof contribution.export !== "function") {
    throw new ValidationError({
      message: `The ${capability} capability's ${purge} has an export that is not a function.`,
      action: "Give it an `export` that answers what this capability holds about the subject, or leave it out.",
    });
  }
  if (contribution.retain !== undefined) {
    assertRetention(capability, purge, contribution);
    return;
  }
  if (typeof contribution.erase !== "function") {
    throw new ValidationError({
      message: `The ${capability} capability's ${purge} has no erase function.`,
      action:
        "Give it an `erase` that removes or anonymizes the subject's rows, or a `retain` that says why it keeps them.",
    });
  }
}

/** How a refusal names one contribution: `user purge`, or `user purge step "scores"` for a named one. */
function purgeLabel(contribution: PurgeContribution): string {
  return contribution.step === undefined
    ? `${contribution.subject} purge`
    : `${contribution.subject} purge step "${contribution.step}"`;
}

/**
 * Refuse a retaining contribution the person could not be answered with: no basis, a basis key outside the
 * capability's own domain, no export, or an erase too.
 */
function assertRetention(capability: string, purge: string, contribution: PurgeContribution): void {
  const retain = contribution.retain as { basis?: unknown; basisKey?: unknown } | undefined;
  const basis = retain?.basis;
  if (typeof basis !== "string" || basis.trim() === "") {
    throw new ValidationError({
      message: `The ${capability} capability's ${purge} retains the rows with no basis.`,
      action: "Say in one sentence, written for the person, why they are kept — `Kept for tax records.`",
    });
  }
  if (retain?.basisKey !== undefined) assertBasisKey(capability, purge, retain.basisKey);
  if (typeof contribution.export !== "function") {
    throw new ValidationError({
      message: `The ${capability} capability's ${purge} retains the rows and has no export.`,
      action: "Give it an `export`: rows that are kept are rows an access request is answered with.",
    });
  }
  if (contribution.erase !== undefined) {
    throw new ValidationError({
      message: `The ${capability} capability's ${purge} both retains and erases the rows.`,
      action: "Declare one disposition: `retain` with its basis, or `erase`.",
    });
  }
}

/**
 * Refuse a basis key no catalog could hold for this capability — the rule `composeMessages` holds every `messages`
 * key to: `<domain>/<path>`, and the domain is the contributing capability's own name.
 */
function assertBasisKey(capability: string, purge: string, key: unknown): void {
  const shown = String(key);
  if (!MessageKey.safeParse(key).success) {
    throw new ValidationError({
      message: `The ${capability} capability's ${purge} names the basis key \`${shown}\`, which is not a catalog key.`,
      action: `Name it \`${capability}/<path>\`, as every message key is.`,
    });
  }
  const domain = messageDomain(shown);
  if (domain !== capability) {
    throw new ValidationError({
      message: `The ${capability} capability's ${purge} names the basis key \`${shown}\`, outside its own domain.`,
      action: `Rename it to start with \`${capability}/\`: a capability may only contribute messages under its own domain.`,
      detail: `\`${capability}\` named the basis key \`${shown}\`, whose domain is \`${domain}\`.`,
    });
  }
}

/**
 * The steps a purge of `subject` runs, in composition order — libraries first, the adopter's `app` last — and a
 * capability's named steps in the order it declared them.
 */
export function purgeSteps(
  capabilities: readonly { readonly name: string; readonly purge?: readonly PurgeContribution[] }[],
  subject: PurgeSubject,
): PurgeStep[] {
  const steps: PurgeStep[] = [];
  for (const capability of capabilities) {
    for (const contribution of capability.purge ?? []) {
      if (contribution.subject !== subject) continue;
      const step = contribution.step === undefined ? capability.name : `${capability.name}/${contribution.step}`;
      steps.push({ step, capability: capability.name, contribution });
    }
  }
  return steps;
}

/** What every export entry says: the capability, its sentence, and what a purge does with its rows. */
interface PurgeExportEntryBase {
  readonly capability: string;
  /** The contribution's own step name, for one of a capability's named steps. Absent for an unnamed one. */
  readonly step?: string;
  readonly summary: string;
  /** `erase` — a purge erases or anonymizes these rows — or `retain`, a purge keeps them. */
  readonly disposition: PurgeDisposition;
  /**
   * For `retain`, why the rows are kept, written for the person: the contribution's `basisKey` translated, or its
   * English `basis` when nothing translates it.
   */
  readonly basis?: string;
  /** For `retain`, the catalog key the basis was translated from, when the contribution names one. */
  readonly basisKey?: string;
}

/** A catalog lookup that answers `null` for a key it has no message for — `Translator.maybe`'s shape. */
export type BasisTranslation = (key: string) => string | null;

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
 * Read every step's export for one subject — the export document's body, in step order. A capability's named
 * steps each answer their own entry under that capability, so one feature's unreadable table costs its own part.
 *
 * **Each read is guarded on its own and they run concurrently**, the same shape as the user pane's guarded
 * sub-reads: one capability whose table will not read costs its own entry as `unavailable`, and the rest of
 * the document still answers the request. What the read threw is not carried — it names a query and a table, and
 * the document crosses a trust boundary. An answer that is not one object is `unavailable` too, because the
 * document promises an object per capability and a client validates it.
 */
export async function purgeExports(
  steps: readonly PurgeStep[],
  context: PurgeContext,
  translate?: BasisTranslation,
): Promise<PurgeExportEntry[]> {
  return Promise.all(
    steps.map(async ({ capability, contribution }): Promise<PurgeExportEntry> => {
      const named = contribution.step === undefined ? { capability } : { capability, step: contribution.step };
      const base: PurgeExportEntryBase = isRetained(contribution)
        ? {
            ...named,
            summary: contribution.summary,
            disposition: "retain",
            ...retainedBasis(contribution, translate),
          }
        : { ...named, summary: contribution.summary, disposition: "erase" };
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

/** A retained contribution's basis as the person reads it: its key translated, else its English basis. */
function retainedBasis(
  contribution: RetainingPurgeContribution,
  translate: BasisTranslation | undefined,
): { basis: string; basisKey?: string } {
  const { basis, basisKey } = contribution.retain;
  if (basisKey === undefined) return { basis };
  return { basis: translate?.(basisKey) ?? basis, basisKey };
}

/**
 * One binding a contribution opens off a run's env — or a wiring fault naming it and the capability. The
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
 * Rows as an export carries them: plain JSON, a `Date` as its ISO-8601 string — the shape the export
 * document crosses the wire in, so what a contribution answers is what a reader parses, and a test compares
 * exactly that.
 */
export function exportRows<T>(rows: readonly T[]): Record<string, unknown>[] {
  return JSON.parse(JSON.stringify(rows)) as Record<string, unknown>[];
}

/**
 * A field name that holds a credential — a token, a secret, a password, a digest of one, a sealed value. What an
 * export never carries: an access request is answered with what is held, never with the means to act as
 * the person or to reach what they shared.
 */
const CREDENTIAL_FIELD = /secret|token|password|credential|digest|private_?key|encrypted/i;

/**
 * Every path in an export's data whose field name holds a credential — empty for an export that carries none.
 * Each capability's export test asserts it empty, so a column added later with a token in it fails the build
 * rather than reaching an access request.
 */
export function credentialFields(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => credentialFields(item, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => {
    const here = path ? `${path}.${key}` : key;
    return [...(CREDENTIAL_FIELD.test(key) ? [here] : []), ...credentialFields(inner, here)];
  });
}
