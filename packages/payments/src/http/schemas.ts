// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { JsonDate } from "@pithy-sh/core/src/data/codecs";
import { EntitlementKey } from "@pithy-sh/core/src/entitlement/entitlement";
import { z } from "zod";
import { PaymentsRail } from "../data/rail";

/**
 * Everything a caller may send to a payments route, declared here and parsed on the route line. Reading a
 * route tells you what it accepts without opening the handler, and `c.req.valid()` is the only way a handler
 * can reach a body at all — the Biome plugin bans the raw accessors under `src/http/**`.
 *
 * ## What is deliberately absent
 *
 * **The user.** Never a field on a purchase route. A purchase belongs to the authenticated caller, from the
 * `AuthContext` seam; a body that could name a `userId` would let any signed-in caller submit a receipt
 * against somebody else. The two control-plane schemas at the bottom are the deliberate exception, and the
 * exception is the feature: support acting on another account is what they are for, which is why they sit
 * behind a scoped credential and are audited on every write.
 *
 * **The product.** Also never a field, and this one is easy to get wrong. The catalog product is resolved from
 * the *verified* payload's SKU, not from anything the client declared: a client-supplied `productId` would let
 * a caller present a cheap receipt as an expensive product. The client sends the store's artifact and nothing
 * about what it thinks it bought.
 *
 * **The environment.** The deployment's own, from `ENVIRONMENT`. A body naming it would be a sandbox purchase
 * asking to be treated as production.
 *
 * The size bounds are not decoration. A receipt is an unauthenticated string that gets base64-decoded and
 * DER-parsed, so bounding it bounds that work; the limits are generous against real StoreKit and Play
 * artifacts and still refuse a megabyte of nonsense before any parsing starts.
 */

/**
 * The longest receipt accepted. A StoreKit 2 signed transaction is a few kilobytes — its certificate chain is
 * most of it — and Google's purchase tokens are shorter. 16 KiB is roomy for both and small enough that a
 * flood of them cannot be a parsing denial of service.
 */
const MAX_RECEIPT_LENGTH = 16_384;

/** The most receipts one restore may carry. A store's entitlement list is short; a thousand is not a restore. */
const MAX_RESTORE_RECEIPTS = 50;

/** The longest a catalog product id may be, matching the SKU bound the catalog itself uses. */
const MAX_PRODUCT_ID_LENGTH = 200;

/** The longest a user id may be. A UUID is 36; the bound is generous against an adopter's own id scheme. */
const MAX_USER_ID_LENGTH = 200;

export const PurchaseSubmission = z
  .object({
    rail: PaymentsRail.describe("Which store the receipt came from. Decides which verifier runs and nothing else."),
    receipt: z
      .string()
      .min(1)
      .max(MAX_RECEIPT_LENGTH)
      .describe(
        "The store's own artifact, exactly as its SDK returned it — a StoreKit 2 signed transaction, a Play purchase token. Everything about what was bought is read from inside it after it verifies, never from the request.",
      ),
  })
  .describe("A client submitting one purchase for verification. The purchaser is the authenticated caller.");
export type PurchaseSubmission = z.infer<typeof PurchaseSubmission>;

export const RestoreRequest = z
  .object({
    rail: PaymentsRail.describe("Which store the history came from."),
    receipts: z
      .array(
        z.string().min(1).max(MAX_RECEIPT_LENGTH).describe("One store artifact from the caller's purchase history."),
      )
      .min(1)
      .max(MAX_RESTORE_RECEIPTS)
      .describe(
        "The caller's current store entitlements, as the store's own artifacts. Restore is client-driven because only the device can enumerate what its store account owns.",
      ),
  })
  .describe("A client re-submitting its store purchase history, to bind it to the authenticated caller.");
export type RestoreRequest = z.infer<typeof RestoreRequest>;

/**
 * Apple's webhook body. The Apple rail declares the same one field for itself, because it parses the bytes in
 * order to verify them and must not import across the HTTP seam to do it. Change one, change the other.
 */
export const AppleWebhookNotification = z
  .object({
    signedPayload: z
      .string()
      .min(1)
      .describe(
        "The App Store Server Notification V2, as a compact JWS. The guard has already verified it against Apple's pinned certificate chain by the time a handler reads this.",
      ),
  })
  .describe("The body Apple POSTs to the notification endpoint. One field, carrying everything.");
export type AppleWebhookNotification = z.infer<typeof AppleWebhookNotification>;

/**
 * What a caller may ask to buy: a catalog product id, and nothing else.
 *
 * No price, no amount, no currency, no return URL. The price comes from the catalog entry the id resolves to,
 * and the return URLs come from config — a client that could name where hosted Checkout returns to could send a
 * paying customer to a page it controls, and a client that could name a price could buy Pro for the price of a
 * coin pack. The purchaser is the authenticated caller, as everywhere else.
 */
export const CheckoutRequest = z
  .object({
    productId: z
      .string()
      .min(1)
      .max(MAX_PRODUCT_ID_LENGTH)
      .describe(
        "The logical catalog product to buy — the key in `products`, never a store SKU. Resolved against config, so an unknown one is a 404 rather than a bad request.",
      ),
  })
  .describe("A caller asking to start hosted checkout for one catalog product.");
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

/**
 * Google's webhook body: a Pub/Sub push, not a Play notification.
 *
 * The Google rail declares the same shape for itself, for the reason Apple's does — it decodes the bytes in order
 * to check them and must not import across the HTTP seam to do it. Change one, change the other.
 *
 * **The proof is not in here.** A Pub/Sub push body carries no signature at all: authenticity is the OIDC token
 * in the `Authorization` header, which the guard has already verified by the time a handler reads this. So this
 * validator's job is only to say the body is shaped like a push, which is what keeps a malformed one a 400 rather
 * than something a handler has to defend against.
 */
export const GoogleWebhookNotification = z
  .object({
    message: z
      .object({
        data: z
          .string()
          .min(1)
          .describe("The Play developer notification, base64-encoded. Decoded and checked by the guard."),
        messageId: z
          .string()
          .min(1)
          .describe("Pub/Sub's own message id — stable across redeliveries, which is what makes it the dedupe key."),
        publishTime: z.string().min(1).optional().describe("When Pub/Sub published the message, RFC 3339."),
      })
      .loose()
      .describe("The Pub/Sub message carrying one Play developer notification."),
    subscription: z
      .string()
      .min(1)
      .optional()
      .describe("The push subscription's resource name. Recorded for diagnosis; nothing is decided from it."),
  })
  .loose()
  .describe("The body Pub/Sub POSTs to the Google notification endpoint.");
export type GoogleWebhookNotification = z.infer<typeof GoogleWebhookNotification>;

/**
 * Stripe's webhook body: an event envelope.
 *
 * Shape-only, like Google's. **The proof is not in here** — it is the HMAC in the `Stripe-Signature` header, which
 * the guard has already checked against the exact received bytes by the time a handler reads this. So this
 * validator's job is to say the body is shaped like an event, which keeps a malformed one a 400 rather than
 * something a handler has to defend against. The Stripe rail declares the same shape for itself, in
 * `rails/stripe/objects.ts`, because it parses the bytes in order to read them and must not import across the
 * HTTP seam. Change one, change the other.
 */
export const StripeWebhookNotification = z
  .object({
    id: z.string().min(1).describe("The event id — `evt_…`. The dedupe key, stable across Stripe's retries."),
    type: z.string().min(1).describe("What happened — `customer.subscription.updated`."),
    created: z.number().int().describe("Stripe's own timestamp for the event, in seconds since the epoch."),
    data: z
      .object({ object: z.record(z.string(), z.unknown()).describe("The object the event is about.") })
      .loose()
      .describe("The event's payload."),
  })
  .loose()
  .describe("The body Stripe POSTs to the notification endpoint.");
export type StripeWebhookNotification = z.infer<typeof StripeWebhookNotification>;

/**
 * A control-plane grant: who, which entitlement, and for how long.
 *
 * The one place in this package where `userId` is a request field, and the only reason it is legal is the gate
 * ahead of it — a manual grant is support acting on somebody else's account, so naming that account is the
 * whole point. Every other route reads the caller from the `AuthContext` seam precisely because a body that
 * could name a user would let any signed-in caller write against another one. Here that power *is* the
 * feature, which is why the route requires a scoped control-plane credential and audits the write.
 *
 * No product, no rail, no price. A manual grant is not a purchase and must not pretend to be one: it writes
 * the read model directly, with null provenance, and the purchase record stays empty because nothing was
 * bought.
 */
export const EntitlementGrantRequest = z
  .object({
    userId: z
      .string()
      .min(1)
      .max(MAX_USER_ID_LENGTH)
      .describe(
        "The account to grant. Support acts on somebody else's account, so this is the one route where the subject is a request field rather than the authenticated caller.",
      ),
    entitlement: EntitlementKey.describe(
      "The entitlement key to grant, as gating code names it. Not a store SKU, and not required to be in the catalog — comping a key nothing sells is the durable case.",
    ),
    expiresAt: JsonDate.optional().describe(
      "When the grant lapses, as an ISO 8601 timestamp. Omit for a comp that never ends. A past timestamp writes a row that grants nothing, which is a slower way of revoking.",
    ),
  })
  .describe("A control-plane request to grant one entitlement to one account, with no purchase behind it.");
export type EntitlementGrantRequest = z.output<typeof EntitlementGrantRequest>;

/**
 * A control-plane revoke: who, and which entitlement.
 *
 * No expiry, because a revoke is immediate — the read model is the truth every gate hits, so the account
 * loses access on the next request rather than at the end of a period. Revoking a key the account never held
 * is legal and idempotent: the inactive row is itself the record that somebody decided it.
 */
export const EntitlementRevokeRequest = z
  .object({
    userId: z
      .string()
      .min(1)
      .max(MAX_USER_ID_LENGTH)
      .describe(
        "The account to revoke. As with the grant, the subject is named because support is acting on another account.",
      ),
    entitlement: EntitlementKey.describe("The entitlement key to revoke, as gating code names it."),
  })
  .describe("A control-plane request to revoke one entitlement from one account, effective immediately.");
export type EntitlementRevokeRequest = z.output<typeof EntitlementRevokeRequest>;
