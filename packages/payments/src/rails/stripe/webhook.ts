// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PaymentsVerificationFailedError } from "../../error/errors";
import type { PaymentsStripeCredentials } from "../../secret/registry";
import type { VerifiedNotification, WebhookDelivery } from "../contract";
import { mapStripeEvent, StripeEvent } from "./objects";
import { STRIPE_SIGNATURE_HEADER, verifyStripeSignature } from "./signature";

/**
 * One Stripe webhook delivery: verified, read, and normalized.
 *
 * Three steps, in this order, and the order is the point. **Authenticity first** — the HMAC covers the exact
 * received bytes, so nothing about the body is trustworthy until it passes, and a forgery is refused before a
 * single field is read. Then the **envelope**, because an event's `type` is what says which object it carries.
 * Then the **mapping**, which is `objects.ts`'s job and the only part that knows what Stripe's vocabulary means.
 *
 * The stored payload is the whole event, not the object inside it. The webhook row is the replay source, and
 * the envelope carries the event id, the type, and Stripe's own timestamp — which is what makes "why didn't this
 * renew" answerable from the table without going back to Stripe.
 */

/** What verifying one Stripe delivery needs: the endpoint's secret, and a clock for the replay window. */
export interface StripeWebhookOptions {
  /** Stripe's credential block. Only `webhookSecret` is used here; the API key belongs to the other paths. */
  credentials: PaymentsStripeCredentials;
  /** The clock, for the signature's freshness window. Injected so tests are deterministic. */
  now: Date;
  /** The freshness window, in seconds. Defaults to Stripe's own five minutes. */
  toleranceSeconds?: number;
}

/** Verify and normalize one Stripe webhook delivery. Throws when authenticity cannot be established. */
export async function parseStripeNotification(
  delivery: WebhookDelivery,
  options: StripeWebhookOptions,
): Promise<VerifiedNotification> {
  await verifyStripeSignature(
    delivery.body,
    delivery.headers.get(STRIPE_SIGNATURE_HEADER),
    options.credentials.webhookSecret,
    { now: options.now, toleranceSeconds: options.toleranceSeconds },
  );

  let raw: unknown;
  try {
    raw = JSON.parse(delivery.body) as unknown;
  } catch (cause) {
    // Cannot happen from Stripe — the bytes just proved they came from Stripe. If it ever does, it must not
    // become a half-read event.
    throw new PaymentsVerificationFailedError(
      { detail: "Stripe: the delivery verified but its body is not JSON." },
      { cause },
    );
  }

  const parsed = StripeEvent.safeParse(raw);
  if (!parsed.success) {
    // Never echo the body: it is a customer's purchase, and it carries their Stripe identifiers.
    throw new PaymentsVerificationFailedError({
      detail: `Stripe: the delivery is not a Stripe event — ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`)
        .join(", ")}.`,
    });
  }

  const event = parsed.data;
  const mapped = mapStripeEvent(event);
  return {
    // Stripe's own event id. `UNIQUE (rail, providerEventId)` on it is what makes a redelivery recognized rather
    // than reprocessed, and Stripe retries every non-2xx for three days.
    providerEventId: event.id,
    payload: event as Record<string, unknown>,
    event: mapped.event,
    providerAccountId: mapped.providerAccountId,
    accountReference: mapped.accountReference,
    note: mapped.note,
  };
}
