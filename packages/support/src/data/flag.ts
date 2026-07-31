// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";

/**
 * One viewer's private view of one thread, in `pithy_support_thread_flags`.
 *
 * The other deliberate exception to "no coordination state", and the milder of the two. `archived` is
 * shared because done means done; these are **per viewer** because nobody coordinates around them —
 * whether Ada has read a thread says nothing about whether Grace has, and two people marking the same
 * thread read is not a conflict. Keeping them in their own table rather than as columns on the thread
 * is what makes that structural instead of a convention.
 *
 * `viewer` is the control-plane subject — the management client's identity, not a Pithy user. There
 * is no user table behind it and there does not need to be: the value is opaque, and a connection
 * that goes away simply leaves rows nothing reads.
 */
export const SupportThreadFlag = z
  .object({
    id: z.string().describe("UUID primary key."),
    threadId: z.string().describe("The `pithy_support_threads.id` these flags apply to."),
    viewer: z
      .string()
      .describe(
        "The control-plane subject whose view this is. Unique together with `threadId`, so a viewer has exactly one row per thread and marking read twice is an upsert rather than a second row.",
      ),
    read: SQLiteBoolean.describe("Whether this viewer has read the thread."),
    snoozedUntil: SQLiteDate.nullish().describe(
      "Hide the thread from this viewer's inbox until this moment. Null means not snoozed. A time rather than a boolean, so a snooze expires on its own and nothing has to sweep.",
    ),
    createdAt: SQLiteDate.describe("When the flag row was created."),
    updatedAt: SQLiteDate.describe("When the flag row was last written."),
  })
  .describe("One viewer's read/snooze state for one thread — private, uncoordinated, and safe to lose.");
export type SupportThreadFlag = z.output<typeof SupportThreadFlag>;
