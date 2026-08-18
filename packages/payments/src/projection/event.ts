// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PurchaseEnvironment, PurchaseRole } from "../data/purchase";
import { PaymentsRail } from "../data/rail";
import { PurchaseStatus } from "../data/status";
import { PaymentsSubject } from "../data/subject";

/**
 * A provider event, normalized. This is the writer's whole input, and the seam between "how a rail talks"
 * and "what the projection stores": a rail module verifies a receipt or parses a notification and produces
 * one of these, and nothing past this point knows which store it came from.
 *
 * The shape is deliberately a *state*, not a *delta*. A rail reports what the transaction is now, and the
 * writer projects it — so a renewal, a refund, a grace period, and a revocation are all the same code path
 * rather than four handlers that must each be kept correct.
 *
 * `providerEventAt` is the field the whole design leans on. It is the provider's own timestamp, not ours,
 * because ours would record delivery order and delivery order is exactly what providers do not guarantee.
 *
 * **This is the owner-bound half of a two-part shape.** A rail produces an `UnboundProviderEvent` — this
 * object with the subject pair omitted, declared in `rails/contract.ts` — and the route binds an owner onto
 * it to make one of these. The split is the whole reason a store's bytes cannot decide who is entitled: a
 * rail parses a payload and knows the transaction completely and the holder not at all, so the field it
 * would have to fill in does not exist for it to fill in wrongly.
 */
export const ProviderEvent = z
  .object({
    rail: PaymentsRail.describe("Which store the event came from."),
    providerTransactionId: z
      .string()
      .min(1)
      .describe(
        "The rail's own transaction id. Together with `rail` this is the row's identity forever — one provider transaction is one purchase row.",
      ),
    providerProductId: z
      .string()
      .min(1)
      .describe("The rail's own SKU or price id. The writer resolves the logical product from it."),
    subjectType: PaymentsSubject.shape.subjectType.describe(
      "Whether `subjectId` names a user or an organization. Half the owner, and never separable from the other half — the route binds both together or neither.",
    ),
    subjectId: PaymentsSubject.shape.subjectId.describe(
      "The subject the transaction belongs to. A client submission takes it from the authenticated caller through the configured subject seam; a webhook resolves it through the provider-account map or a decoded account reference.",
    ),
    status: PurchaseStatus.describe("The transaction's current normalized state, as the rail reports it."),
    role: PurchaseRole.default("charge").describe(
      "Whether this event records money moving or a subscription's standing. Omitted by every rail but Lemon Squeezy, which reports the two separately because its store does.",
    ),
    environment: PurchaseEnvironment.describe(
      "Which store environment the transaction happened in. Checked against the deployment's own before anything is written.",
    ),
    purchasedAt: z.date().describe("When the store recorded the purchase."),
    expiresAt: z
      .date()
      .nullable()
      .default(null)
      .describe("When access lapses, or null for a purchase that never expires. Null for a one-time purchase."),
    revokedAt: z
      .date()
      .nullable()
      .default(null)
      .describe("When the purchase was refunded or revoked, or null while it stands."),
    resumesAt: z
      .date()
      .nullable()
      .default(null)
      .describe(
        "When a paused subscription resumes, as the provider stated it — never computed, and never set on a status other than `paused`. Null on a paused event is the provider reporting an indefinite pause. Produced only by `pauseResumesAt` in `data/pause.ts`, which is where each rail's source for it is declared.",
      ),
    originalTransactionId: z
      .string()
      .nullable()
      .default(null)
      .describe("The transaction that started the subscription, chaining renewals back to it. Null for a one-off."),
    amountMinor: z
      .number()
      .int()
      .nullable()
      .default(null)
      .describe("The amount charged in the currency's minor unit, or null when the rail did not report one."),
    currency: z
      .string()
      .nullable()
      .default(null)
      .describe("The ISO currency of `amountMinor`, or null when the rail did not report one."),
    providerEventAt: z
      .date()
      .describe(
        "The provider's own timestamp for this event. The monotonic write rule compares against it, so an event staler than the row it would update changes nothing.",
      ),
    payload: z
      .record(z.string(), z.unknown())
      .describe("The verified provider payload, stored as received. The reconciliation and audit record."),
  })
  .describe(
    "One provider event, normalized and bound to its owner — the projection writer's input. A rail produces this shape less the subject pair; the route adds it.",
  );
export type ProviderEvent = z.output<typeof ProviderEvent>;
export type ProviderEventInput = z.input<typeof ProviderEvent>;
