// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { z } from "zod";
import { MemberState } from "./enums";

/**
 * One tester on one cohort's roster — the row in `pithy_testers_members`.
 *
 * **The state and its dates are a projection of the event log, never the source of truth.** They live
 * here so the common reads — "who is on this roster", "who is due a nudge" — are one indexed query
 * instead of a replay, but every one of them is rebuilt from `pithy_testers_events` by
 * `replayMember`. If the two ever disagree, the events win and the projection is wrong. That is the
 * whole reason a correction to history is a recomputation rather than an argument.
 *
 * **The email address is the join key to `@pithy-sh/auth`, and it is stored lowercased.** A tester is
 * invited by address and becomes visible only when they sign in with it; matching is exact, because
 * auth's `email` column is unique and every Pithy sign-in is provider-verified. No `userId` is stored:
 * caching it would create a second thing to keep in step, and the lookup is a single indexed hit.
 */
export const TestersMember = z
  .object({
    id: z
      .string()
      .describe(
        "The member's UUID. Text rather than a sequential integer because it appears in control-plane responses and in the audit trail, and a countable id there tells a reader how large the roster is and lets them address rows they were never handed. The opt-in links carry `optInToken`, not this.",
      ),
    cohortId: z.string().describe("The cohort this member belongs to. Indexed — every roster read starts here."),
    email: z
      .string()
      .describe(
        "The invited address, lowercased. The join key to `pithy_auth_users.email`, and the address every invitation and nudge is sent to. Unique per cohort.",
      ),
    name: z.string().nullable().describe("A display name the developer supplied when inviting, or null."),
    optInToken: z
      .string()
      .describe(
        "The tester's confirmation credential — 32 bytes of CSPRNG, base64url. The token IS the credential, as with `@pithy-sh/storage`'s share links: it is looked up on every visit, which is what makes it revocable where a signed token could only expire. Generated when the row is created, so nothing has to be minted at send time and no secret is needed to build an invitation in any environment. Unique across the table.",
      ),
    state: MemberState.describe(
      "The member's current roster state, projected from the event log. Never written by inactivity — a quiet tester is still opted in.",
    ),
    invitedAt: SQLiteDate.describe(
      "When the first invitation was sent. Every member has one; it is how they got here.",
    ),
    acceptedAt: SQLiteDate.nullable().describe(
      "When they answered the first email saying they will test, or null. Consent, not enrollment: it is a tap on a link, needs no account, and proves nothing about installing or opting in at the store — that is `optedInAt`.",
    ),
    optedInAt: SQLiteDate.nullable().describe(
      "When they followed Pithy's confirmation link, or null. PITHY'S ESTIMATE of their opt-in date — it records that they clicked our link, not that Google recorded an opt-in. The two can differ and no API exposes Google's.",
    ),
    lapsedAt: SQLiteDate.nullable().describe(
      "When they opted out or were removed, or null. Written only by an explicit act — never by going quiet.",
    ),
    lastInvitedAt: SQLiteDate.describe(
      "When an invitation was most recently sent, including resends. Distinct from `invitedAt` so the streak still measures from the first contact.",
    ),
    lastNudgedAt: SQLiteDate.nullable().describe(
      "When a nudge was most recently enqueued for this tester, or null. The cooldown reads this, and it is written at enqueue rather than at delivery: a cooldown that waited for the send Workflow would let a retried request mail twice.",
    ),
    nudgeCount: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "How many nudges have been enqueued since this tester last answered one. Cleared when they accept the invitation or confirm the opt-in, so it measures unanswered probes rather than lifetime volume. Feeds the health score's unanswered-probe penalty and the cap that stops chasing after three.",
      ),
    unreachable: SQLiteBoolean.describe(
      "Whether this address hard-bounced or is suppressed. SQLite has no boolean, so the column is `0`/`1` and the codec is the only place that conversion happens — it carried a hand-written integer and a rationale about summing it in SQL, and no SQL anywhere sums it: every count is a filter over already-decoded rows.",
    ),
    createdAt: SQLiteDate.describe("When the member row was created."),
    updatedAt: SQLiteDate.describe("When the member row was last written."),
  })
  .describe(
    "One tester on one cohort in `pithy_testers_members` — a projection of the event log, kept for cheap reads. Every opt-in figure on it is Pithy's estimate; Google's equivalent is not readable.",
  );
export type TestersMember = z.output<typeof TestersMember>;
export type TestersMemberRow = z.input<typeof TestersMember>;
