// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What Paddle actually stores on a paused subscription, recorded from the live sandbox on 2026-08-15.
 *
 * Not invented. `sub_01kzybh940drg5p1dagqv4xj37` was paused through the API twice — once with a resume
 * date, once without — and read back with `GET /subscriptions/{id}` each time. Every value below is from
 * those responses: the pause fields from the paused reads, which were narrowed to exactly these, and the
 * identity fields (`id`, `customer_id`, `created_at`, the item's price) from the same subscription, which
 * was resumed afterwards and is active again. Nothing is here that was not read back.
 *
 * **The recording refutes the obvious fix.** #369 describes the Paddle half as "`scheduled_change.resume_at`
 * is the same story", and a change keyed on that field would have shipped null for every paused Paddle
 * subscription while reading as if it worked: pausing with `resume_at: "2026-10-01T00:00:00Z"` moves the
 * date onto a **`resume` scheduled change's `effective_at`** and leaves `resume_at` **null**. That field
 * carries a date only while a `pause` is scheduled and the subscription is still `active`, which is not a
 * paused subscription at all.
 *
 * The pair also pins the other half of the design: an open-ended pause is `scheduled_change: null`, so a
 * null resume date on a paused Paddle row is Paddle saying "indefinitely" rather than this rail declining
 * to look.
 */

/** The date the pause was asked to end at, verbatim as it was sent and as Paddle echoed it back. */
export const PADDLE_PAUSE_RESUME_AT = "2026-10-01T00:00:00Z";

/**
 * A subscription paused **with** a resume date — `pause({ effective_from: "immediately", resume_at })`.
 *
 * Note `resume_at: null` beside an `effective_at` carrying the date. That inversion is the whole reason
 * `subscriptionResumesAt` reads the action rather than the field named after the answer.
 */
export const PADDLE_PAUSED_WITH_RESUME_DATE = {
  id: "sub_01kzybh940drg5p1dagqv4xj37",
  status: "paused",
  customer_id: "ctm_01kzybg67tdbn7emh9c2n3zs17",
  paused_at: "2026-08-15T13:43:55.956Z",
  scheduled_change: { action: "resume", effective_at: PADDLE_PAUSE_RESUME_AT, resume_at: null, items: null },
  current_billing_period: { starts_at: "2026-08-13T20:03:06.313818Z", ends_at: "2026-09-13T20:03:06.313818Z" },
  next_billed_at: PADDLE_PAUSE_RESUME_AT,
  items: [{ price: { id: "pri_01kzvyz9e21z9vbhd7xqq3csyh" }, status: "inactive" }],
  created_at: "2026-08-13T20:03:07.008Z",
};

/**
 * The same subscription paused **without** one — `pause({ effective_from: "immediately" })`.
 *
 * `scheduled_change` is null and so is `next_billed_at`: Paddle has nothing to say about when this comes
 * back, because nothing decided it. That is the indefinite pause, and it is a real state rather than a gap.
 */
export const PADDLE_PAUSED_INDEFINITELY = {
  id: "sub_01kzybh940drg5p1dagqv4xj37",
  status: "paused",
  customer_id: "ctm_01kzybg67tdbn7emh9c2n3zs17",
  paused_at: "2026-08-15T13:44:10.712Z",
  scheduled_change: null,
  current_billing_period: { starts_at: "2026-08-15T13:44:09.279Z", ends_at: "2026-09-15T13:44:09.279Z" },
  next_billed_at: null,
  items: [{ price: { id: "pri_01kzvyz9e21z9vbhd7xqq3csyh" }, status: "inactive" }],
  created_at: "2026-08-13T20:03:07.008Z",
};
