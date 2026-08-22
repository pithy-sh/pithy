// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PaymentsVerificationFailedError } from "../error/errors";
import type { PaymentsRail } from "./rail";
import type { PurchaseStatus } from "./status";

/**
 * When a paused subscription comes back — the one place every rail answers it.
 *
 * A pause is not an ending, and the single most useful thing anything can say about one is the date it
 * ends. Two rails parsed that date out of a provider response and then dropped it, which is worse than
 * never reading it: the value was provably present and understood, and no caller could reach it (#369).
 * So the answer is stated once here rather than per rail, and the seam is shaped so a sixth rail inherits
 * it instead of repeating the omission.
 *
 * ## Three facts, and they are different facts
 *
 * - **Not paused.** `status` is anything but `paused`, and there is nothing to resume. `resumesAt` is null
 *   and {@link pauseResumesAt} will not let it be anything else — a date beside a live subscription is a
 *   sentence nobody can write ("active until it resumes on the 14th"), and the purchases table carries a
 *   check constraint saying so.
 * - **Paused, with a date.** The provider named it. `resumesAt` is that instant, decoded from the
 *   provider's own string and never computed from anything else.
 * - **Paused, indefinitely.** The provider was asked and said none: a Play pause with no `autoResumeTime`,
 *   a Paddle pause with no scheduled resume, a Lemon Squeezy pause with `resumes_at: null`. `resumesAt` is
 *   null, and "paused until the 14th" and "paused indefinitely" are different sentences a consumer will
 *   want to write.
 *
 * **Null on a paused row therefore means indefinite, not "we did not look"** — and that is only true
 * because {@link PAYMENTS_PAUSE_RESUMPTION} is total over the rails and every rail able to report `paused`
 * either reads its provider's field or states why there is no field to read. A rail's `{ none }` reason is
 * a fact about that store, so a consumer that wants to distinguish "this store never dates a pause" from
 * "this pause has no date" reads the table: it is exported for exactly that question.
 *
 * ## Never computed
 *
 * The date is the provider's or it does not exist. Nothing here adds a pause duration to a start date, and
 * nothing falls back to a period end — the fallback available when this was filed was `periodEnd`, which
 * is a period end and not a resumption, and reaching for it would have put a wrong date in a letter to a
 * paying customer. That is worse than an absent one. The only input this function takes is the string the
 * provider sent, which is what makes "never computed" a property of the signature rather than a promise.
 */

/** How one rail answers "when does this come back": the provider field it reads, or why there is none. */
export type PauseResumption =
  | {
      /** The provider field carrying the resume date, in that provider's own spelling. */
      readonly field: string;
    }
  | {
      /** Why this rail has no resume date to read. A fact about the store, not an exemption. */
      readonly none: string;
    };

/**
 * Every rail, and where its paused subscriptions state their resume date.
 *
 * `satisfies Record<PaymentsRail, …>` rather than a partial map, exactly as `PAYMENTS_TABLE_DISCLOSURE`
 * is: **a sixth rail does not compile until somebody decides how it answers this.** That is the structural
 * half of the gate; `pause.test.ts` is the other half, and drives each declared field through the rail
 * that reads it.
 */
export const PAYMENTS_PAUSE_RESUMPTION = {
  /**
   * No pause at all. StoreKit has no paused state — a subscriber either renews, lapses, or is refunded —
   * so `appleStatus` cannot produce `paused` and there is no date to look for.
   */
  apple: { none: "StoreKit has no paused subscription state, so no Apple purchase is ever projected as paused." },
  /** Play states it directly. Absent for an indefinite pause, which is a state Play genuinely has. */
  google: { field: "pausedStateContext.autoResumeTime" },
  /**
   * Stripe's `paused` is not a pause with a date. It is a trial that ended with no payment method while
   * `trial_settings.end_behavior.missing_payment_method` is `pause`, and it resumes when a card arrives
   * rather than on a date — Stripe publishes none for it.
   *
   * `pause_collection.resumes_at` is a **different mechanism**: pausing collection leaves the subscription
   * `active`, so it never produces a row this field could sit on. Modeling that is a separate question
   * about a state this package does not have, and it is on #369's sweep rather than smuggled in here.
   */
  stripe: {
    none: "Stripe's `paused` is a trial ended without a payment method; it resumes when one arrives, and Stripe publishes no date for it. `pause_collection.resumes_at` is a different mechanism that leaves the status `active`.",
  },
  /** Lemon Squeezy states it on the pause object. Null there is an open-ended pause. */
  lemonSqueezy: { field: "pause.resumes_at" },
  /**
   * Paddle states it on the scheduled change — and **not** in the field named after it.
   *
   * Verified against a live sandbox on 2026-08-15. Pausing immediately with a `resume_at` leaves
   * `scheduled_change: { action: "resume", effective_at: "2026-10-01T00:00:00Z", resume_at: null }`: the
   * date moves to `effective_at` and the field literally called `resume_at` is null. `resume_at` carries
   * it only while a *pause* is scheduled and the subscription is still `active`, which is not a paused
   * subscription and not this field. Pausing with no resume date leaves `scheduled_change: null` — an
   * indefinite pause, reported as one.
   *
   * A fix keyed on `resume_at` alone would therefore have shipped null for every paused Paddle
   * subscription while looking correct, so both spellings are read and the one that means resumption wins.
   */
  paddle: { field: "scheduled_change.effective_at (action `resume`), or scheduled_change.resume_at" },
} as const satisfies Record<PaymentsRail, PauseResumption>;

/**
 * A rail that reads a resume date, as a type.
 *
 * Derived from the table rather than restated, so {@link pauseResumesAt} **cannot be called** for a rail
 * declared `{ none }`: a store with no resume date has no way to report one, and the refusal is a compile
 * error rather than a review comment.
 */
export type ResumingRail = {
  [Rail in PaymentsRail]: (typeof PAYMENTS_PAUSE_RESUMPTION)[Rail] extends { readonly field: string } ? Rail : never;
}[PaymentsRail];

/** What a rail hands over: which rail, what state it is reporting, and the provider's own string. */
export interface PauseResumptionInput {
  /** The rail reporting. Only a rail declaring a field in {@link PAYMENTS_PAUSE_RESUMPTION} may. */
  rail: ResumingRail;
  /** The normalized status this event carries. Anything but `paused` has nothing to resume. */
  status: PurchaseStatus;
  /**
   * The provider's own resume date, verbatim — an RFC 3339 string. Null, undefined or empty is the
   * provider saying there is none, which is an indefinite pause rather than a missing read.
   */
  reported: string | null | undefined;
}

/**
 * The resume date to project, from what the provider said.
 *
 * Refuses an unreadable string rather than passing it on: `new Date("soon")` is an Invalid Date, and
 * `SQLiteDate` encodes one as `NaN` — a corrupt column value that no read can tell from a real instant.
 * That is the same refusal every other timestamp on these rails makes, and it leaves the delivery recorded
 * for the reconciliation pass rather than silently written.
 */
export function pauseResumesAt(input: PauseResumptionInput): Date | null {
  // A resume date belongs to a pause. A live subscription's next date is its renewal, and a canceled
  // one's is its period end; neither is a resumption, and neither may be written here.
  if (input.status !== "paused") return null;
  const { reported } = input;
  if (reported === null || reported === undefined || reported === "") return null;

  const parsed = new Date(reported);
  if (Number.isNaN(parsed.getTime())) {
    throw new PaymentsVerificationFailedError({
      detail: `${input.rail}: the resume date "${reported}" is not a readable timestamp.`,
    });
  }
  return parsed;
}
