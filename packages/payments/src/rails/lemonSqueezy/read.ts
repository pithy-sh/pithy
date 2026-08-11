// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsProviderUnavailableError } from "../../error/errors";
import type { PaymentsLemonSqueezyCredentials } from "../../secret/registry";
import { type LemonSqueezyHttpFetch, lemonSqueezyJson } from "./api";
import { LemonSqueezyOrder, LemonSqueezySubscription } from "./objects";

/**
 * The reads this rail makes of Lemon Squeezy: a subscription, and an order.
 *
 * Both exist for two callers with different needs, which is why they return `undefined` rather than throwing
 * on an absent object. The webhook parser reads a subscription to learn which variant an invoice bills; the
 * reconciliation pass reads one to find out what a purchase looks like now. For the first, an absent
 * subscription is a delivery that cannot be projected; for the second it is the contract's documented
 * "the store no longer knows this purchase". Neither is a failure of the rail.
 *
 * A store that cannot be *reached* throws `payments/provider_unavailable`, which is what tells the
 * reconciliation Workflow to fail the step and retry, and what makes the webhook guard answer non-2xx so
 * Lemon Squeezy redelivers.
 */

/** What a read needs: the credentials, and the transport to make it through. */
export interface LemonSqueezyReadOptions {
  /** The rail's credentials. The API key is read at the point of need and never cached. */
  credentials: PaymentsLemonSqueezyCredentials;
  /** The HTTP seam. */
  transport: LemonSqueezyHttpFetch;
}

/** A JSON:API single-resource answer, narrowed to the attributes the caller will parse. */
const Envelope = z.object({
  data: z.object({ id: z.string(), attributes: z.record(z.string(), z.unknown()) }).loose(),
});

/** Read one object, or `undefined` when the store has no such thing. */
async function readObject(
  path: string,
  what: string,
  options: LemonSqueezyReadOptions,
): Promise<{ id: string; attributes: Record<string, unknown> } | undefined> {
  const body = await lemonSqueezyJson(options.transport, path, {
    what,
    apiKey: options.credentials.apiKey,
    absentOn404: true,
  });
  if (body === undefined) return undefined;

  const envelope = Envelope.safeParse(body);
  if (!envelope.success) {
    throw new PaymentsProviderUnavailableError({
      detail: `Lemon Squeezy answered for ${what} with a body that is not a JSON:API resource.`,
    });
  }
  return { id: envelope.data.data.id, attributes: envelope.data.data.attributes };
}

/** The subscription with this id, or `undefined` when Lemon Squeezy has none. */
export async function readSubscription(
  id: string,
  options: LemonSqueezyReadOptions,
): Promise<LemonSqueezySubscription | undefined> {
  const object = await readObject(`/subscriptions/${encodeURIComponent(id)}`, `subscription ${id}`, options);
  return object === undefined ? undefined : LemonSqueezySubscription.parse(object.attributes);
}

/** The order with this id, or `undefined` when Lemon Squeezy has none. */
export async function readOrder(id: string, options: LemonSqueezyReadOptions): Promise<LemonSqueezyOrder | undefined> {
  const object = await readObject(`/orders/${encodeURIComponent(id)}`, `order ${id}`, options);
  return object === undefined ? undefined : LemonSqueezyOrder.parse(object.attributes);
}
