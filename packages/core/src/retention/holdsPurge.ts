// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { personRowsExport } from "../capability/personRows";
import type { RetainingPurgeContribution } from "../capability/purge";
import { LegalHold } from "../controlPlane/data/hold";
import { CONTROL_PLANE_HOLDS_TABLE } from "../controlPlane/data/tables";

/**
 * What a person's purge means for the legal holds: **nothing is erased, and the export says so and why.**
 *
 * A hold names the user it preserves. The row is the record that a hold stood, from when to when and why it ended,
 * and it is kept after release for exactly that reason; a purge the hold allowed to run does not take the record of
 * the hold with it. The export answers for every hold placed on the person.
 *
 * **Only `user` holds are theirs.** One `subjectId` column names users, organizations and audit tenants, and a
 * tenant may be named by a user's id. **And the export says that a hold stood, never who placed it or why**: the
 * operator who placed or lifted it is another person, and the reasons are counsel's words about a matter the person
 * may be a party to.
 */

/** The one sentence the purge records with this step. */
export const HOLDS_PURGE_SUMMARY = "Keeps every legal hold placed on the user.";

/** Why, in the sentence the person is told. */
export const HOLDS_RETENTION_BASIS = "Kept as the record that a legal hold stood, when it was placed and why it ended.";

/** The user contribution the control plane declares, over the app database its holds live in. */
export function holdsUserPurge(database = "DB"): RetainingPurgeContribution {
  return {
    subject: "user",
    summary: HOLDS_PURGE_SUMMARY,
    retain: { basis: HOLDS_RETENTION_BASIS },
    export: personRowsExport({
      capability: "controlplane",
      database,
      tables: [
        {
          table: CONTROL_PLANE_HOLDS_TABLE,
          schema: LegalHold,
          columns: ["subjectId"],
          match: { subjectType: "user" },
          as: "holds",
          omit: ["placedBy", "releasedBy", "reason", "releaseReason"],
          orderBy: "placedAt",
        },
      ],
    }),
  };
}
