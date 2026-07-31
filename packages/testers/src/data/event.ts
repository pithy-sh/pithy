// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { EventActor, MemberEventKind, NudgeKind } from "./enums";

/** What a `nudged` event carries: which nudge went out, and the email job that carries it. */
export const NudgeEventMetadata = z
  .object({
    nudgeKind: NudgeKind.describe("Which nudge was sent."),
    jobId: z
      .string()
      .describe(
        "The `pithy_email_jobs.id` this nudge became. The join back to delivery, bounces, and the copy that was actually sent.",
      ),
    copySource: z
      .enum(["default", "supplied"])
      .describe(
        "Whether the words were this capability's shipped default or supplied by a control-plane caller. Recorded because a message sent over the adopter's own DKIM signature should be attributable to whoever wrote it.",
      ),
  })
  .describe("Metadata carried by a `nudged` event — which nudge, which email job, and who wrote the words.");
export type NudgeEventMetadata = z.output<typeof NudgeEventMetadata>;

/** Anything an event may carry beyond its kind. Empty for most transitions. */
export const EventMetadata = z
  .object({
    nudge: NudgeEventMetadata.optional().describe("Present on a `nudged` event; absent on every other kind."),
    reason: z
      .string()
      .max(200)
      .optional()
      .describe("A short free-text reason a developer supplied when removing a tester. Never shown to the tester."),
  })
  .describe(
    "Optional context on an event. Deliberately narrow — an event log that accepts arbitrary shapes stops being replayable.",
  );
export type EventMetadata = z.output<typeof EventMetadata>;

/**
 * One thing that happened to a tester — the append-only row in `pithy_testers_events`.
 *
 * **This table is the source of truth, and the streak is replayed from it rather than stored.** The
 * design note in the issue asks for exactly this, and the reason is that a stored counter has no way to
 * be wrong in public: if a member's opt-in date turns out to be mistaken, a counter can only be
 * overwritten, losing both the old value and the fact that it changed. Replaying means a correction is
 * an insert plus a recomputation, and every daily snapshot written before it stays a faithful record of
 * what Pithy believed on that day — which is precisely what a trend chart is claiming to show.
 *
 * Rows are never updated and never deleted except by cohort teardown. `occurredAt` is the ordering key,
 * not `id`: an event can be recorded late (an opt-in confirmed on a phone with a stale clock, a
 * backfill) and replaying by insertion order would put it in the wrong day.
 */
export const TestersEvent = z
  .object({
    id: z
      .number()
      .int()
      .describe("Primary key, auto-incrementing. Internal — an event id is never exposed or linked to."),
    cohortId: z.string().describe("The cohort this event belongs to. Indexed with `occurredAt` for the replay scan."),
    memberId: z
      .string()
      .describe("The member this event is about. Indexed — a per-tester replay reads only their rows."),
    kind: MemberEventKind.describe("What happened."),
    actor: EventActor.describe("Who caused it: the tester, the developer, or the daily pass."),
    occurredAt: SQLiteDate.describe(
      "When it happened — the replay's ordering key, not the insertion order. Ms-epoch in SQLite; a `Date` in app code.",
    ),
    metadata: sqliteJson(EventMetadata).describe(
      "Context for this event, Zod-validated on write and on read. `{}` for a plain transition.",
    ),
    createdAt: SQLiteDate.describe(
      "When the row was inserted. Differs from `occurredAt` for a backfilled event, which is how a late-recorded fact stays distinguishable from a timely one.",
    ),
  })
  .describe(
    "One append-only fact about a tester in `pithy_testers_events` — the source of truth the roster state and the estimated streak are both replayed from.",
  );
export type TestersEvent = z.output<typeof TestersEvent>;
export type TestersEventRow = z.input<typeof TestersEvent>;
