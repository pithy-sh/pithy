// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import { z } from "zod";
import { PaymentsRail } from "./rail";

/** A received notification body, as the rail delivered it. Only the envelope is fixed; shapes differ. */
const NotificationPayload = z
  .record(z.string(), z.unknown())
  .describe("The notification body as received, before any rail-specific interpretation.");

/**
 * What one event changed when it projected — every purchase row it wrote, split by whether the row renews.
 *
 * **A list, because one notification can touch several rows.** Lemon Squeezy's refund writes the invoice row
 * and the subscription's standing row from one delivery, and a list of one would have to pick. Split the way
 * the management reads split — `payments:purchases:read` and `payments:subscriptions:read` — so a client
 * holding only the narrower grant can still follow the ids it is allowed to open. Disjoint: a subscription
 * row's id is in `subscriptionIds` and nowhere else.
 *
 * A row the projection read and left alone — an exact replay, an event older than the row — is not a row
 * this event changed, so it is not listed. Two empty lists is a real answer: the event finished and changed
 * nothing. That is a different fact from the column being null, which is an event finished before #830
 * recorded anything.
 */
export const PaymentsWebhookEventTargets = z
  .object({
    purchaseIds: z
      .array(z.string())
      .describe("The purchase rows this event created or moved that do not renew — their own UUIDs."),
    subscriptionIds: z
      .array(z.string())
      .describe("The purchase rows this event created or moved that renew — the ids the subscription read lists."),
  })
  .describe("Every purchase and subscription row one event changed when it projected.");
export type PaymentsWebhookEventTargets = z.output<typeof PaymentsWebhookEventTargets>;

/** The `projected_targets` column: the targets as JSON text, Zod-validated on write and on read. */
const WebhookEventTargetsColumn = sqliteJson(PaymentsWebhookEventTargets);

/**
 * The column value a finishing writer stores. One encoder for the three writers that finish an event — the
 * webhook, the Paddle sweep, the orphan repair — so they cannot write the JSON three ways, and it goes
 * through the codec the row schema reads it back with.
 */
export function encodeWebhookEventTargets(targets: PaymentsWebhookEventTargets): string {
  // The codec's encode side is the JSON text; its declared output admits the decoded object too, because the
  // decode side accepts an already-parsed value.
  return WebhookEventTargetsColumn.encode(targets) as string;
}

/** The answer for an event that finished and changed nothing — recorded, and empty. */
export const NO_WEBHOOK_EVENT_TARGETS: PaymentsWebhookEventTargets = Object.freeze({
  purchaseIds: [],
  subscriptionIds: [],
}) as PaymentsWebhookEventTargets;

/**
 * One received provider notification — the row in `pithy_payments_webhook_events`, keyed
 * `UNIQUE (rail, providerEventId)`.
 *
 * Every provider delivers at-least-once and retries, so a redelivery is expected and must be recognized
 * rather than reprocessed. This is the replay source, and it is what makes "why didn't this renew"
 * answerable: `receivedAt` says whether the notification arrived at all, `processedAt` whether it was
 * finished with, `abandonedAt` whether a repair pass gave up on it, and `error` why.
 *
 * ## Why two timestamps and no status column (#337)
 *
 * `processedAt` used to be the whole answer, and three writers meant three different things by it —
 * projected, tried and failed, and given up on. Because the webhook guard short-circuits on it, two of
 * those three silently stopped a purchase from ever being projected.
 *
 * **The defect was not too few states. It was every reader spelling out its own predicate over a column
 * whose meaning the writers disagreed about.** A stored `status` enum makes the writers exhaustive and
 * leaves the readers exactly as free to write `status <> 'pending'` — which is the short-circuit that was
 * wrong. So the fix has to be a named question each reader asks by name, and once there is one, the
 * storage shape is the smaller decision.
 *
 * Given that, two nullable timestamps beat an enum twice over. They answer *when*, which is what this
 * table is read for, and they cannot contradict themselves the way `status = 'projected'` beside a null
 * `processedAt` can. An enum would add an invariant nothing enforces; a timestamp is its own evidence.
 *
 * So the state is **derived, never stored** — see {@link webhookEventState} — and the two readers that
 * matter ask different questions of it: {@link isWebhookEventFinished} for the guard's short-circuit, and
 * {@link isWebhookEventOutstanding} for a repair pass. Both switch over every state, so a fifth one cannot
 * be added without each reader saying what it means by it.
 *
 * A third reader asks a question the state cannot answer — see {@link webhookEventAwaitsOwner}. It exists
 * because a link repairs one kind of unfinished row and not the others, and *which* kind is in `error`.
 */
export const PaymentsWebhookEvent = z
  .object({
    id: z.string().describe("The row's UUID."),
    rail: PaymentsRail.describe("Which store delivered the notification."),
    providerEventId: z
      .string()
      .describe(
        "The rail's own event id. `UNIQUE (rail, providerEventId)` — a redelivery is recognized, not reprocessed.",
      ),
    payload: sqliteJson(NotificationPayload).describe(
      "The notification body, Zod-validated on write and on read. The replay source, so it is stored whole.",
    ),
    receivedAt: SQLiteDate.describe("When the notification arrived. Present even for one that never processed."),
    processedAt: SQLiteDate.nullable().describe(
      "When this delivery was finished with — projected, or deliberately nothing to project — or null while it has not been. The only column the webhook guard short-circuits on, so it means 'we have finished this' and never 'we have seen this'. Null with an old `receivedAt` is the drift signal.",
    ),
    abandonedAt: SQLiteDate.nullable()
      .optional()
      .describe(
        "When a repair pass gave up on this event so its stream could advance, or null. Separate from `processedAt` because abandoning is that pass's decision about its own progress and must never answer for a webhook: a later delivery of the same event has to be reprocessed, and fixing the cause has to be able to repair it. Optional because the webhook path never abandons anything and the column defaults to null for it.",
      ),
    error: z
      .string()
      .nullable()
      .describe(
        "Why this delivery did not project — or, beside a set `processedAt`, why there was never anything to project. Internal text: it is read by an operator and never rendered to a client. Its presence is not the state; the two timestamps are, because an explanation must not be able to change one.",
      ),
    attempts: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "How many times a repair pass has tried this event and failed. Optional because the webhook path neither retries nor counts, and the column defaults to 0 for it; the sweep uses it to bound how long one unprojectable event may hold the stream up before it is quarantined.",
      ),
    projectedTargets: WebhookEventTargetsColumn.nullable()
      .optional()
      .describe(
        "What this event changed when it finished — every purchase and subscription row it wrote — or null when nothing was recorded: an event not finished yet, or one finished before `payments_0003_webhook_targets` added the column. Written by every finishing path, so it is the join from a notification to the rows it explains.",
      ),
    createdAt: SQLiteDate.describe("When this row was written."),
  })
  .describe("One received provider notification — the row in `pithy_payments_webhook_events`, the replay source.");
export type PaymentsWebhookEvent = z.output<typeof PaymentsWebhookEvent>;
export type PaymentsWebhookEventRow = z.input<typeof PaymentsWebhookEvent>;

/**
 * What has become of a recorded delivery. Four cases, and each one behaves differently.
 *
 * - `pending` — it arrived and nothing has tried it yet.
 * - `failed` — it was tried, it did not project, and it is still outstanding.
 * - `abandoned` — a repair pass gave up so its stream could advance. Outstanding, but not to that pass.
 * - `finished` — projected, or deliberately nothing to project. Nothing is left to do.
 */
export type PaymentsWebhookEventState = "pending" | "failed" | "abandoned" | "finished";

/**
 * The two timestamps and the reason, as a reader gets them off a narrow `select`.
 *
 * Deliberately the **encoded** shape rather than {@link PaymentsWebhookEvent}: both readers want two or
 * three columns, and making them decode a whole row — payload included — to answer "may this be
 * short-circuited" would be a JSON parse per redelivery. `undefined` is accepted beside `null` for the
 * same reason a defaulted column can read back absent.
 */
export interface PaymentsWebhookEventProgress {
  /** `processed_at`, as `SQLiteDate` accepts it, or absent. Only its presence is read here. */
  readonly processedAt?: z.input<typeof SQLiteDate> | null;
  /** `abandoned_at`, likewise. */
  readonly abandonedAt?: z.input<typeof SQLiteDate> | null;
  /** `error`, or absent. */
  readonly error?: string | null;
}

/**
 * Classify one recorded delivery. **Derived here, once, rather than stored** — see the module doc.
 *
 * Finished wins over abandoned, and that ordering is the point rather than an accident: an event the sweep
 * gave up on and a later delivery then projected is *finished*, and `abandonedAt` stays on the row as the
 * record of how close that purchase came to being lost.
 */
export function webhookEventState(row: PaymentsWebhookEventProgress): PaymentsWebhookEventState {
  if (row.processedAt !== null && row.processedAt !== undefined) return "finished";
  if (row.abandonedAt !== null && row.abandonedAt !== undefined) return "abandoned";
  if (row.error !== null && row.error !== undefined) return "failed";
  return "pending";
}

/**
 * What a management read says a recorded delivery became (#830). **Three answers**, the ones a client acts on:
 *
 * - `projected` — finished: it became a purchase, or there was nothing in it to become one. What it changed is
 *   in `projectedTargets`.
 * - `pending` — arrived and not finished, whether or not it has been tried. `attempts` says how often.
 * - `abandoned` — a repair pass gave up on it. Still repairable by a delivery, and the reason is on the row.
 *
 * `failed` and `pending` are one answer here because the difference between them is a repair pass's
 * bookkeeping, and the count beside the state already carries it.
 */
export type PaymentsWebhookEventReadState = "projected" | "pending" | "abandoned";

/** Classify one recorded delivery for a management read. Derived from {@link webhookEventState}, never stored. */
export function webhookEventReadState(row: PaymentsWebhookEventProgress): PaymentsWebhookEventReadState {
  const state = webhookEventState(row);
  switch (state) {
    case "finished":
      return "projected";
    case "pending":
    case "failed":
      return "pending";
    case "abandoned":
      return "abandoned";
  }
}

/**
 * May a redelivery be answered as a duplicate without running anything?
 *
 * **Only for a delivery that is finished with.** This is the webhook guard's short-circuit, and it is the
 * whole of #337: while it meant "we have seen this", a delivery that arrived and failed was answered 200
 * for ever, and no path in this package repaired it.
 */
export function isWebhookEventFinished(state: PaymentsWebhookEventState): boolean {
  switch (state) {
    case "finished":
      return true;
    case "pending":
    case "failed":
    case "abandoned":
      return false;
  }
}

/**
 * The prefix an event's `error` carries when the one thing missing was **an owner**.
 *
 * `error` is free text an operator reads, and two writers put two different sentences in it for the same
 * condition — the webhook handler's "no subject could be resolved", and the sweep's own `orphaned:`. That
 * was fine while nothing queried it. It stopped being fine with #341: linking an account has to find exactly
 * the rows that were waiting on that link, and "waiting on a link" is not derivable from the two timestamps —
 * a quarantine after three failures wears the same pair.
 *
 * So the reason is written on the row, once, by a constant both writers share. A prefix rather than a column
 * because it costs no migration and stays legible to the operator reading `error`, and it is a prefix rather
 * than a substring so the match is anchored and a note quoting the word cannot be mistaken for one.
 *
 * See {@link webhookEventAwaitsOwner} for the reader, and `projection/orphans.ts` for what it is read by.
 */
export const WEBHOOK_EVENT_ORPHANED = "orphaned:";

/**
 * The word the Paddle sweep writes at the head of `error` when it gives up on an event after a bounded number
 * of attempts. Here beside {@link WEBHOOK_EVENT_ORPHANED} rather than private to the sweep, because a reader —
 * {@link webhookEventErrorCode} — names it, and a writer and a reader spelling one word twice drift.
 */
export const WEBHOOK_EVENT_QUARANTINED = "quarantined";

/** Every code the kit defines. A prefix is published only when it is one of these. */
const KIT_ERROR_CODES: ReadonlySet<string> = new Set(
  KitErrorPayload.options.map((member) => member.shape.code.value as string),
);

/**
 * What a management read may say about a stored `error`: **its code, never its sentence**. (#830)
 *
 * The column is operator text, and the sentence after the code is throw-site context — a store's
 * transaction ids, an amount, a SKU — which is exactly what `clientError` strips from every other surface.
 * So the read publishes a classification and nothing more:
 *
 * - the kit error code a projection failure was recorded under (`payments/product_not_found`), and only
 *   when the prefix is one the kit's own union defines — so text that merely *looks* like a code is not
 *   promoted onto the wire by its shape;
 * - `orphaned` or `quarantined`, the two markers this package writes for itself;
 * - `unclassified` for everything else — a rail's note, prose from an older build.
 *
 * Null when there is no error at all.
 */
export function webhookEventErrorCode(error: string | null | undefined): string | null {
  if (error === null || error === undefined) return null;
  if (error.startsWith(WEBHOOK_EVENT_ORPHANED)) return "orphaned";
  if (error.startsWith(`${WEBHOOK_EVENT_QUARANTINED}:`)) return "quarantined";
  const colon = error.indexOf(":");
  const head = colon === -1 ? error : error.slice(0, colon);
  return KIT_ERROR_CODES.has(head) ? head : "unclassified";
}

/**
 * Is this event outstanding for want of an owner, rather than for want of anything else?
 *
 * The question the relink repair asks, and it is deliberately narrower than "not finished". A quarantined
 * event, a failed projection, an unmapped SKU — none of those is repaired by an account linking, and running
 * them again on that signal would be a second unbounded retry loop wearing the first one's clothes.
 *
 * `abandoned` and `failed` both qualify, because both paths produce an orphan and they produce different
 * states: the sweep abandons one so its stream can advance, and the webhook handler leaves one failed so a
 * redelivery repairs it. Neither is finished, and both are waiting on the same thing.
 */
export function webhookEventAwaitsOwner(row: PaymentsWebhookEventProgress): boolean {
  if (webhookEventState(row) === "finished") return false;
  return (row.error ?? "").startsWith(WEBHOOK_EVENT_ORPHANED);
}

/**
 * Has a repair pass anything left to do with this event?
 *
 * `abandoned` is false here, and false is right: the bound exists so one unprojectable event cannot hold a
 * stream up for ever, and a pass that picked its own quarantines back up would restart the count and stall
 * again. That is the asymmetry the two readers exist for — the pass must move on, and a webhook delivery
 * must still be able to repair what it walked past.
 */
export function isWebhookEventOutstanding(state: PaymentsWebhookEventState): boolean {
  switch (state) {
    case "pending":
    case "failed":
      return true;
    case "abandoned":
    case "finished":
      return false;
  }
}
