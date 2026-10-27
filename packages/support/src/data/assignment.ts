// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * The `assignee` filter value meaning *nobody has it*. Reserved: an assignment to a ref spelled this way is
 * refused at the boundary (`http/schemas.ts`), so the filter can never mean two things.
 */
export const UNASSIGNED = "none";

/**
 * Who assigned a thread: a management client through the control plane, or a signed-in user of the app
 * through support's staff power. Recorded per change, because the two are different evidence about who
 * acted, exactly as the audit trail's `actorType` is.
 */
export const SupportAssignmentActorType = z
  .enum(["control-plane", "user"])
  .describe(
    "How the assigner was verified: `control-plane` for a management client's scoped credential, `user` for a signed-in user of the app holding support's staff power.",
  );
export type SupportAssignmentActorType = z.output<typeof SupportAssignmentActorType>;

/**
 * One change of a thread's assignee in `pithy_support_assignments` — append-only, one row per change.
 *
 * The thread carries the **current** assignee because that is what the inbox filters on; this carries
 * **every** change, the same split the classification table has with the thread. Nothing here is updated
 * and nothing is deleted while the thread stands. A change that changed nothing — the current assignee
 * assigned again — writes no row, so every row here is a real handover.
 */
export const SupportAssignment = z
  .object({
    id: z.string().describe("UUID primary key."),
    threadId: z.string().describe("The `pithy_support_threads.id` whose assignee changed."),
    assigneeRef: z
      .string()
      .nullish()
      .describe("Who has the thread after this change, as an opaque reference, or null when it was unassigned."),
    assigneeName: z.string().nullish().describe("How that assignee was shown at the time, or null when unassigned."),
    previousRef: z.string().nullish().describe("Who had the thread before this change, or null when nobody did."),
    previousName: z.string().nullish().describe("How the previous assignee was shown, or null when nobody had it."),
    actorType: SupportAssignmentActorType.describe("How the person or client making the change was verified."),
    assignedBy: z.string().describe("Who made the change — the control-plane subject, or the signed-in user's id."),
    note: z
      .string()
      .nullish()
      .describe(
        "Why, in the assigner's own words, when they gave a reason. Staff-written, never customer text, and shown to anybody who can read the thread.",
      ),
    createdAt: SQLiteDate.describe("When the change was made."),
  })
  .describe("One append-only change of a support thread's assignee in `pithy_support_assignments`.");
export type SupportAssignment = z.output<typeof SupportAssignment>;
