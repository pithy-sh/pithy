// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { FeatureMap, QuotaMap } from "../config/allowances";
import { PaymentsSubject } from "./subject";

/**
 * One subject's allowance override — the row in `pithy_payments_overrides`, keyed `UNIQUE (subjectType,
 * subjectId)`.
 *
 * **Keyed on the subject, never on an entitlement key.** An override survives a tier change, which is the
 * whole point: a negotiated email allowance must still stand the day the customer upgrades. Keyed on a key,
 * it would die with the old key at the worst possible moment. Its own table, too, so the entitlement
 * projection never has to preserve a column it does not own.
 *
 * **It grants no key.** A subject with an override and no entitlement is still refused at every gate; the
 * override only shades the numbers the subject's keys resolve to. It composes with a `manual` grant rather
 * than replacing one: a comped `enterprise` key and a pinned email number are two rows in two tables.
 *
 * **Sparse.** `quotas` and `features` carry only what was negotiated, and every name they omit keeps
 * tracking the plan. A full replacement would freeze every other allowance at the day it was written, and an
 * upgrade would silently do nothing for this customer until somebody rewrote it by hand.
 *
 * **`unrestricted` is a mode, not a list** — unlimited and on for every name, including names declared after
 * the row was written. An enumeration of today's names would quietly stop covering an enterprise contract the
 * first release a name was added.
 *
 * **`version` is what makes a write safe for two operators.** The read carries it, a set must send it back,
 * and a set naming a version behind this row's is refused rather than applied, so one operator's stale pane
 * cannot silently overwrite another's pin.
 *
 * **So a version never repeats, and a cleared row is kept, empty.** Deleting it would put the subject back at
 * version 0, the next set would write version 1 again, and a pane still holding the deleted row's 1 would pass
 * the check and overwrite a newer pin. An empty row — not unrestricted, nothing pinned — is no override to
 * every read ({@link isEmptyOverride}); it only remembers the version.
 */
export const PaymentsOverride = z
  .object({
    id: z.string().describe("The row's UUID."),
    subjectType: PaymentsSubject.shape.subjectType.describe(
      "Whether `subjectId` names a user or an organization. Half the key — the id alone is ambiguous.",
    ),
    subjectId: PaymentsSubject.shape.subjectId.describe("The subject whose allowances this shades."),
    unrestricted: SQLiteBoolean.describe(
      "Whether every quota is unlimited and every feature on, for every name present and future, except the names `quotas` and `features` pin.",
    ),
    quotas: sqliteJson(QuotaMap).describe(
      "Pinned quotas by name — a whole number from 0, or null for unlimited. A name absent here resolves normally.",
    ),
    features: sqliteJson(FeatureMap).describe("Pinned features by name. A name absent here resolves normally."),
    version: z
      .number()
      .int()
      .positive()
      .describe("Advances on every write. A set must name the version it read, or it is refused as stale."),
    reason: z
      .string()
      .describe("Why the last write was made — a contract, a goodwill credit, a migration. Required on every set."),
    createdAt: SQLiteDate.describe("When this subject was first given an override."),
    updatedAt: SQLiteDate.describe("When the override last changed."),
  })
  .describe("One subject's allowance override — the row in `pithy_payments_overrides`.");
export type PaymentsOverride = z.output<typeof PaymentsOverride>;
export type PaymentsOverrideRow = z.input<typeof PaymentsOverride>;

/**
 * Whether a row overrides nothing: not unrestricted, and no name pinned. What a clear leaves behind — the row
 * is kept so its version never repeats — and what every read treats as no override at all.
 */
export function isEmptyOverride(row: PaymentsOverride): boolean {
  return !row.unrestricted && Object.keys(row.quotas).length === 0 && Object.keys(row.features).length === 0;
}
