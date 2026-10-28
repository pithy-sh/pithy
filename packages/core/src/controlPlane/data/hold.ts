// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { SQLiteDate } from "../../data/codecs";

/**
 * **A legal hold: one subject preserved, with the reason it was placed and, once released, why.**
 *
 * Placed and released over the control plane, behind `retention:hold`, because a hold is operational and urgent:
 * counsel says preserve everything about this customer, and the next scheduled purge is tonight. While a hold stands
 * no purge, prune or inactivity deletion touches its subject. Released holds are kept — the row is the record that
 * one stood, from when to when, and why it ended — so nothing here is ever deleted.
 */

/** What a hold preserves: one user, one organization, or one tenant's audit trail. */
export const HoldSubjectType = z
  .enum(["user", "organization", "audit"])
  .describe(
    "What the hold preserves: `user`, one account and everything its purge would erase; `organization`, one tenant and everything its purge would erase; `audit`, one tenant's audit trail, which the prune then leaves whole.",
  );
export type HoldSubjectType = z.infer<typeof HoldSubjectType>;

/** Whether a hold is in force. */
export const HoldState = z
  .enum(["active", "released"])
  .describe("`active` while the hold stands; `released` once it has been lifted, with the reason.");
export type HoldState = z.infer<typeof HoldState>;

/** One hold, as `pithy_controlplane_holds` stores it. */
export const LegalHold = z
  .object({
    id: z.string().min(1).describe("The hold's id. Text, never a sequence: it is named on a release route."),
    subjectType: HoldSubjectType,
    subjectId: z
      .string()
      .min(1)
      .max(255)
      .nullable()
      .describe(
        "The held user's or organization's id, or the tenant whose audit trail is held. Null only for an `audit` hold on the untenanted trail.",
      ),
    reason: z.string().min(1).max(500).describe("Why the hold was placed, in whoever placed it's words."),
    placedBy: z.string().describe("The management client's own user id that placed it — the token's `sub`."),
    placedAt: SQLiteDate.describe("When the hold was placed. Ms-epoch in SQLite."),
    state: HoldState,
    releasedAt: SQLiteDate.nullable().describe("When the hold was released, or null while it stands."),
    releasedBy: z.string().nullable().describe("Who released it, or null while it stands."),
    releaseReason: z.string().max(500).nullable().describe("Why it was released, or null while it stands."),
  })
  .describe("A legal hold on one user, one organization or one tenant's audit trail.");
export type LegalHold = z.output<typeof LegalHold>;
