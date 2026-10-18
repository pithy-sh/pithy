// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { grantedEntitlementKeys } from "@pithy-sh/core/src/entitlement/entitlement";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import {
  type AllowanceDeclarations,
  declaredFeatureNames,
  declaredQuotaNames,
  type FeatureMap,
  type QuotaMap,
} from "../config/allowances";
import { PaymentsOverride } from "../data/override";
import { encodeSubjectReference, type PaymentsSubject } from "../data/subject";
import { PAYMENTS_OVERRIDES_TABLE, type PaymentsDatabase, paymentsDatabase } from "../data/tables";
import { PaymentsOverrideStaleError } from "../error/errors";
import { resolveEntitlements } from "../projection/resolve";
import type { AllowanceOverride } from "./allowance";

/**
 * Per-subject overrides — the writes behind the control plane's set and clear, and the read every resolver
 * shares.
 *
 * **The first runtime-writable input to an entitlement decision in the kit**, so each rule below is one of the
 * things that keeps it narrow:
 *
 * - **A name must be declared.** A patch naming `emals` is refused naming it and listing what is declared,
 *   the shape a grant of an unknown key already gets. `unrestricted` names nothing, so it is exempt.
 * - **A ceiling is a ceiling.** Where a declaration states `overrideMax`, a set past it is refused naming the
 *   limit — never clamped, because a clamped number is a wrong number nobody chose.
 * - **A write is a merge by name.** A set changes only the names it carries, so coming back months later to
 *   add 100 to one allowance is a request naming one allowance — and one operator's stale pane cannot erase
 *   another's pin by omission.
 * - **A write names the version it read.** A version behind the row is `payments/override_stale`, and nothing
 *   is written. The compare is inside the write's own `WHERE`, so two writers racing on one row cannot both
 *   pass a check made a statement earlier.
 * - **A reason is required on every set**, and the audit event carries it. Six months later, the question
 *   anybody asks about an override is why.
 */

/** A subject's override row, or undefined when it has none. */
export async function readOverride(
  db: PaymentsDatabase,
  subject: PaymentsSubject,
): Promise<PaymentsOverride | undefined> {
  const row = await db
    .selectFrom(PAYMENTS_OVERRIDES_TABLE)
    .selectAll()
    .where("subjectType", "=", subject.subjectType)
    .where("subjectId", "=", subject.subjectId)
    .executeTakeFirst();
  return row === undefined ? undefined : PaymentsOverride.parse(row);
}

/** The resolver's view of a row: the three facts resolution reads, or null for no override. */
export function allowanceOverride(row: PaymentsOverride | undefined): AllowanceOverride | null {
  if (row === undefined) return null;
  return { unrestricted: row.unrestricted, quotas: row.quotas, features: row.features };
}

/** The version a write must name: the row's, or 0 when there is no row yet. */
export function overrideVersion(row: PaymentsOverride | undefined): number {
  return row?.version ?? 0;
}

/** What a set or a clear changed, for the audit event and the response. */
export interface OverrideChange {
  /** The row before the write, or undefined when there was none. */
  before: PaymentsOverride | undefined;
  /** The row after the write, or undefined when the write removed it. */
  after: PaymentsOverride | undefined;
}

/** The clock and the id minter. */
export interface OverrideWriteOptions {
  /** The write timestamp. Defaults to now. */
  now?: Date;
  /** The id minter for a row that does not exist yet. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

/** A sparse patch: the names to pin, and nothing about the names it omits. */
export interface OverridePatch {
  /** Quotas to pin, by name. */
  quotas?: QuotaMap;
  /** Features to pin, by name. */
  features?: FeatureMap;
}

/** Refuse a patch naming anything the declarations do not mention, naming it and listing what is declared. */
function requireDeclaredNames(declarations: AllowanceDeclarations, patch: OverridePatch): void {
  const quotas = declaredQuotaNames(declarations);
  for (const name of Object.keys(patch.quotas ?? {})) {
    if (quotas.includes(name)) continue;
    throw new ValidationError({
      message: `No quota "${name}" is declared. Declared quotas: ${quotas.join(", ") || "none"}.`,
      action: "Override a quota this project declares, or declare it in pithy.config.ts first.",
    });
  }
  const features = declaredFeatureNames(declarations);
  for (const name of Object.keys(patch.features ?? {})) {
    if (features.includes(name)) continue;
    throw new ValidationError({
      message: `No feature "${name}" is declared. Declared features: ${features.join(", ") || "none"}.`,
      action: "Override a feature this project declares, or declare it in pithy.config.ts first.",
    });
  }
}

/**
 * The ceiling an override of `name` is bounded by for a subject holding `held`, or undefined for none.
 *
 * **The keys the subject holds decide, because the ceiling belongs to the tier.** `growth` states that its
 * customers' email allowance may be shaded up to 100,000. Among the held keys that declare the quota, the
 * most permissive applies — and a held key declaring the quota with *no* ceiling leaves it unbounded, since a
 * ceiling that gets in the way of a genuine deal is worse than none. A subject holding no key that declares
 * the quota is bounded the same way by every declaration of it.
 */
export function overrideCeiling(
  declarations: AllowanceDeclarations,
  held: ReadonlySet<string>,
  name: string,
): number | undefined {
  const speaking = Object.entries(declarations.entitlements).filter(([, declaration]) => name in declaration.quotas);
  const heldSpeaking = speaking.filter(([key]) => held.has(key));
  const deciding = heldSpeaking.length > 0 ? heldSpeaking : speaking;
  let ceiling: number | undefined;
  for (const [, declaration] of deciding) {
    const stated = declaration.overrideMax?.[name];
    if (stated === undefined) return undefined;
    ceiling = ceiling === undefined ? stated : Math.max(ceiling, stated);
  }
  return ceiling;
}

/** Refuse a quota pin past its ceiling, naming the limit. Unlimited (`null`) is past every ceiling. */
function requireWithinCeilings(declarations: AllowanceDeclarations, held: ReadonlySet<string>, quotas: QuotaMap): void {
  for (const [name, value] of Object.entries(quotas)) {
    const ceiling = overrideCeiling(declarations, held, name);
    if (ceiling === undefined) continue;
    if (value !== null && value <= ceiling) continue;
    throw new ValidationError({
      message: `"${name}" may be overridden up to ${ceiling}, and ${value === null ? "unlimited" : value} is past it.`,
      action: `Send a number no larger than ${ceiling}, or raise \`overrideMax.${name}\` in pithy.config.ts. Unlimited for every name is \`unrestricted\`.`,
    });
  }
}

/** The three facts an override row holds. */
interface OverrideState {
  unrestricted: boolean;
  quotas: QuotaMap;
  features: FeatureMap;
}

/** What a set carries besides the change itself. */
interface OverrideWrite {
  /** Who. */
  subject: PaymentsSubject;
  /** The version the caller read. 0 when it read no override. */
  version: number;
  /** Why. */
  reason: string;
}

/** The stale refusal, with the two versions in `detail`. */
function stale(subject: PaymentsSubject, sent: number, current: number): PaymentsOverrideStaleError {
  return new PaymentsOverrideStaleError({
    detail: `The override for ${encodeSubjectReference(subject)} is at version ${current}; the write named ${sent}.`,
  });
}

/**
 * Write `next` over the subject's row, but only if the row is still at `write.version`.
 *
 * The compare is the statement's own: an update `WHERE version = ?` on an existing row, and an insert that
 * does nothing on conflict for a row that did not exist. Zero rows written is the stale answer either way,
 * because the two writers it protects were never going to be serialized by anything else.
 */
async function writeVersioned(
  d1: D1Database,
  write: OverrideWrite,
  change: (before: PaymentsOverride | undefined) => OverrideState,
  options: OverrideWriteOptions,
): Promise<OverrideChange> {
  const db = paymentsDatabase(d1);
  const now = options.now ?? new Date();
  const before = await readOverride(db, write.subject);
  const current = overrideVersion(before);
  if (write.version !== current) throw stale(write.subject, write.version, current);
  // Computed from the row this write read and checked, never from an earlier read — so the merge base and
  // the version the `WHERE` compares are the same row.
  const next = change(before);

  const record = PaymentsOverride.encode({
    id: before?.id ?? (options.newId ?? (() => crypto.randomUUID()))(),
    subjectType: write.subject.subjectType,
    subjectId: write.subject.subjectId,
    unrestricted: next.unrestricted,
    quotas: next.quotas,
    features: next.features,
    version: current + 1,
    reason: write.reason,
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
  });

  const changes = {
    unrestricted: record.unrestricted,
    quotas: record.quotas,
    features: record.features,
    version: record.version,
    reason: record.reason,
    updatedAt: record.updatedAt,
  };
  const written = await withD1Retry(async () =>
    before === undefined
      ? db
          .insertInto(PAYMENTS_OVERRIDES_TABLE)
          // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side; Kysely's insert type derives from it.
          .values(record as any)
          .onConflict((oc) => oc.columns(["subjectType", "subjectId"]).doNothing())
          .returning("id")
          .executeTakeFirst()
      : db
          .updateTable(PAYMENTS_OVERRIDES_TABLE)
          // biome-ignore lint/suspicious/noExplicitAny: as above — an encoded row, not the app shape.
          .set(changes as any)
          .where("subjectType", "=", write.subject.subjectType)
          .where("subjectId", "=", write.subject.subjectId)
          .where("version", "=", current)
          .returning("id")
          .executeTakeFirst(),
  );
  if (written === undefined) {
    const moved = await readOverride(db, write.subject);
    throw stale(write.subject, write.version, overrideVersion(moved));
  }

  const after = await readOverride(db, write.subject);
  if (after === undefined) {
    throw new InternalError({
      message: "The override could not be recorded.",
      detail: `Wrote the override for ${encodeSubjectReference(write.subject)} but could not read it back.`,
    });
  }
  return { before, after };
}

/** The keys a subject holds that grant access now — what a ceiling is decided by. */
async function heldNow(db: PaymentsDatabase, subject: PaymentsSubject, now: Date): Promise<Set<string>> {
  return grantedEntitlementKeys(await resolveEntitlements(db, subject, now), now);
}

/**
 * Pin numbers and switches for one subject. A merge: the names the patch carries change, every other pin
 * stands, and every name never pinned keeps tracking the plan.
 */
export async function setOverride(
  d1: D1Database,
  declarations: AllowanceDeclarations,
  input: OverrideWrite & OverridePatch,
  options: OverrideWriteOptions = {},
): Promise<OverrideChange> {
  requireDeclaredNames(declarations, input);
  const now = options.now ?? new Date();
  requireWithinCeilings(declarations, await heldNow(paymentsDatabase(d1), input.subject, now), input.quotas ?? {});
  return writeVersioned(
    d1,
    input,
    (before) => ({
      unrestricted: before?.unrestricted ?? false,
      quotas: { ...(before?.quotas ?? {}), ...(input.quotas ?? {}) },
      features: { ...(before?.features ?? {}), ...(input.features ?? {}) },
    }),
    { ...options, now },
  );
}

/**
 * Turn `unrestricted` on or off for one subject. Its own write, behind its own scope: it is the largest grant
 * the kit has, and the only one whose reach grows by itself as names are declared. Pins stand either way.
 * Never bounded by `overrideMax` — being unbounded is what it is for.
 */
export async function setUnrestricted(
  d1: D1Database,
  input: OverrideWrite & { unrestricted: boolean },
  options: OverrideWriteOptions = {},
): Promise<OverrideChange> {
  return writeVersioned(
    d1,
    input,
    (before) => ({ unrestricted: input.unrestricted, quotas: before?.quotas ?? {}, features: before?.features ?? {} }),
    options,
  );
}

/** What a clear names: some pins, or — with neither list — the whole override. */
export interface OverrideClear {
  /** Who. */
  subject: PaymentsSubject;
  /** The version the caller read. Optional: a clear that names none is not checked. */
  version?: number;
  /** Quota pins to remove. */
  quotas?: readonly string[];
  /** Feature pins to remove. */
  features?: readonly string[];
  /** Why, when the caller says. A partial clear keeps the last set's reason otherwise. */
  reason?: string;
}

/**
 * Remove pins, or the whole override. **Idempotent**: clearing an override that does not exist is the state
 * the caller asked for, and answers with nothing changed rather than a 404. A name unpinned resolves from the
 * plan again on the next read.
 */
export async function clearOverride(
  d1: D1Database,
  input: OverrideClear,
  options: OverrideWriteOptions = {},
): Promise<OverrideChange> {
  const db = paymentsDatabase(d1);
  const before = await readOverride(db, input.subject);
  if (before === undefined) return { before: undefined, after: undefined };
  if (input.version !== undefined && input.version !== before.version) {
    throw stale(input.subject, input.version, before.version);
  }

  const whole = input.quotas === undefined && input.features === undefined;
  if (whole) {
    const removed = await withD1Retry(() =>
      db
        .deleteFrom(PAYMENTS_OVERRIDES_TABLE)
        .where("subjectType", "=", input.subject.subjectType)
        .where("subjectId", "=", input.subject.subjectId)
        .where("version", "=", before.version)
        .returning("id")
        .executeTakeFirst(),
    );
    if (removed === undefined) {
      throw stale(input.subject, before.version, overrideVersion(await readOverride(db, input.subject)));
    }
    return { before, after: undefined };
  }

  return writeVersioned(
    d1,
    { subject: input.subject, version: before.version, reason: input.reason ?? before.reason },
    (current) => {
      const quotas = { ...(current?.quotas ?? {}) };
      for (const name of input.quotas ?? []) delete quotas[name];
      const features = { ...(current?.features ?? {}) };
      for (const name of input.features ?? []) delete features[name];
      return { unrestricted: current?.unrestricted ?? false, quotas, features };
    },
    options,
  );
}
