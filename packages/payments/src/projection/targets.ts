// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaymentsWebhookEventTargets } from "../data/webhookEvent";
import type { PurchaseProjection } from "./writer";

/** What the split reads off one projection: whether it wrote, and the row it wrote to or read. */
export type TargetedProjection = {
  readonly outcome: PurchaseProjection["outcome"];
  readonly purchase: Pick<PurchaseProjection["purchase"], "id" | "type" | "providerEventAt">;
};

/** One projection a finishing event made, beside the provider time of the event it projected. */
export type ProjectedEvent = {
  readonly projection: TargetedProjection;
  /** The `providerEventAt` of the event handed to the writer — the version the row carries if this event wrote it. */
  readonly eventAt: Date;
};

/**
 * Every purchase and subscription row a set of projections changed — what a finishing event records about
 * itself (#830).
 *
 * **Changed, not touched.** A projection answering `ignored` wrote nothing on this attempt, but that is two
 * cases. A row strictly newer than the event was moved by some later event, so listing it would claim a change
 * that did not happen. A row carrying the event's *own* version is this event's write, made on an earlier
 * attempt that projected and then failed after — a fulfillment that threw, the second half of a Lemon
 * Squeezy refund — and left the row unfinished for the redelivery, the sweep or the repair to finish. That
 * row is listed: recording two empty lists there would say the event finished and changed nothing, which is
 * the one wrong answer worse than none.
 *
 * The split is on the row's own `type`, the same narrowing `payments:subscriptions:read` applies, so the two
 * lists are disjoint and each id is one a client holding that read can open. A row written twice by one
 * delivery is listed once, in the order it was first written.
 */
export function projectionTargets(projected: readonly ProjectedEvent[]): PaymentsWebhookEventTargets {
  const purchaseIds: string[] = [];
  const subscriptionIds: string[] = [];
  for (const { projection, eventAt } of projected) {
    if (projection.outcome === "ignored" && projection.purchase.providerEventAt.getTime() !== eventAt.getTime()) {
      continue;
    }
    const list = projection.purchase.type === "subscription" ? subscriptionIds : purchaseIds;
    if (!list.includes(projection.purchase.id)) list.push(projection.purchase.id);
  }
  return { purchaseIds, subscriptionIds };
}

/** The provider time of an event, which is all {@link notificationTargets} reads off one. */
type Timed = { readonly providerEventAt: Date };

/**
 * {@link projectionTargets} for the one shape every finishing path has: a notification's charge, and the
 * standing beside it where the rail sent one. Each projection travels with the event it projected, so a
 * caller cannot hand the charge's time to the standing's row.
 */
export function notificationTargets(
  charge: { readonly event: Timed; readonly projection: TargetedProjection },
  standing: { readonly event?: Timed | null; readonly projection?: TargetedProjection | undefined },
): PaymentsWebhookEventTargets {
  const projected: ProjectedEvent[] = [{ projection: charge.projection, eventAt: charge.event.providerEventAt }];
  if (standing.projection !== undefined && standing.event) {
    projected.push({ projection: standing.projection, eventAt: standing.event.providerEventAt });
  }
  return projectionTargets(projected);
}
