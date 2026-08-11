// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PaymentsProductType } from "../config/config";
import { PurchaseEnvironment } from "../data/purchase";
import { PaymentsRail } from "../data/rail";
import { PurchaseStatus } from "../data/status";

/**
 * What the payments routes return, as Zod objects a client can validate against.
 *
 * `schemas.ts` bounds what a caller may send; this file states what it gets back. Both halves are
 * runtime values for the same reason: a management client reading a customer's Worker is crossing a
 * trust boundary and must validate what comes back, and a TypeScript interface is erased before it
 * can help — so every client that had only an interface hand-wrote a mirror, and the mirror drifted
 * the first time a field landed here.
 *
 * **No codecs, and no transform anywhere in this file.** These describe JSON on the wire, so parsing
 * one hands back exactly what went in — which is what lets `responses.test.ts` compare a parsed value
 * with the projection's output and fail on a field either side forgot.
 *
 * **Nothing here is a receipt.** `PaymentsPurchase.payload` is the whole verified provider response,
 * and a bearer artifact; the purchase view is the normalized projection of it, and there is no field
 * that carries the original. The webhook responses are deliberately absent from this file too — they
 * are acknowledgements addressed to Apple, Google and Stripe, not a contract offered to any client.
 */

/** One entitlement as a client reads it. */
export const PaymentsEntitlementView = z
  .object({
    key: z.string().describe("The entitlement key, as the catalog spells it."),
    granted: z.boolean().describe("Whether it grants right now. Re-checked against `expiresAt` on every read."),
    expiresAt: z.iso.datetime().nullable().describe("When it lapses, ISO-8601; null when it does not."),
  })
  .describe("One entitlement: the key, whether it grants right now, and when it lapses.");
export type PaymentsEntitlementView = z.output<typeof PaymentsEntitlementView>;

/** One purchase as a client may see it — the normalized projection, never the stored provider payload. */
export const PaymentsPurchaseView = z
  .object({
    id: z.string().describe("The purchase's UUID."),
    rail: PaymentsRail.describe("Which store this transaction came from."),
    productId: z.string().describe("The catalog product the verified SKU resolved to."),
    type: PaymentsProductType.describe("What kind of product it is."),
    status: PurchaseStatus.describe("The normalized status. Nothing here is ever a rail-specific state."),
    environment: PurchaseEnvironment.describe(
      "The store environment it happened in. A sandbox purchase never grants in production.",
    ),
    purchasedAt: z.iso.datetime().describe("When the store recorded the purchase, ISO-8601."),
    expiresAt: z.iso.datetime().nullable().describe("When the entitlement it bought lapses, ISO-8601; null when none."),
    outcome: z
      .enum(["created", "updated", "ignored"])
      .describe(
        "What the write actually did. `ignored` is a success — a replay of a receipt already projected, or an event staler than the row it would have overwritten.",
      ),
  })
  .describe("One purchase as the projection left it. Never the receipt, which is a bearer artifact.");
export type PaymentsPurchaseView = z.output<typeof PaymentsPurchaseView>;

/** `POST {base}/purchases`. */
export const PaymentsPurchaseResponse = z
  .object({
    purchase: PaymentsPurchaseView.describe("The purchase as this submission left it."),
    entitlements: z.array(PaymentsEntitlementView).describe("What that purchase grants, resolved now."),
  })
  .describe("A verified purchase and the entitlements it produced.");
export type PaymentsPurchaseResponse = z.output<typeof PaymentsPurchaseResponse>;

/** `GET {base}/entitlements` — always the caller's own. */
export const PaymentsEntitlementsResponse = z
  .object({ entitlements: z.array(PaymentsEntitlementView).describe("The caller's entitlements, resolved now.") })
  .describe("Every entitlement the caller holds.");
export type PaymentsEntitlementsResponse = z.output<typeof PaymentsEntitlementsResponse>;

/** `POST {base}/restore`. */
export const PaymentsRestoreResponse = z
  .object({
    purchases: z.array(PaymentsPurchaseView).describe("Every receipt in the batch, as the projection left it."),
    entitlements: z.array(PaymentsEntitlementView).describe("The caller's entitlements after the restore."),
  })
  .describe("What a Restore Purchases run projected, and what the caller now holds.");
export type PaymentsRestoreResponse = z.output<typeof PaymentsRestoreResponse>;

/** `POST {base}/checkout` and `POST {base}/portal` — the hosted Stripe flows. */
export const PaymentsHostedSessionResponse = z
  .object({
    url: z.string().describe("Where to send the browser. Stripe's own hosted page; it expires on Stripe's schedule."),
  })
  .describe("Where to send the buyer for a hosted Stripe flow.");
export type PaymentsHostedSessionResponse = z.output<typeof PaymentsHostedSessionResponse>;

/**
 * `POST {base}/entitlements/grant` and `POST {base}/entitlements/revoke` — the two control-plane routes.
 *
 * One shape for both, because both are the same act read two ways: the entitlement as it now stands.
 * A revoke returns `granted: false` rather than nothing, so a management client renders the state it
 * produced instead of assuming it.
 */
export const PaymentsEntitlementResponse = z
  .object({ entitlement: PaymentsEntitlementView.describe("The entitlement as the write left it.") })
  .describe("The single entitlement a management client granted or revoked, as it now stands.");
export type PaymentsEntitlementResponse = z.output<typeof PaymentsEntitlementResponse>;

/**
 * ## The management read surface
 *
 * Everything below answers a **control-plane** route, so it is read by a dashboard across a trust
 * boundary rather than by the adopter's own app. The `Admin` prefix is what keeps the two apart: a
 * client's view of its own purchase and a management client's view of everybody's are different
 * projections with different rules, and one schema doing both would be one edit away from serving the
 * wider shape to the narrower caller.
 *
 * **The provider payload appears nowhere in this file and is not even selected by the queries behind
 * it** — see `admin/read.ts`. That is where an email address would otherwise reach a purchases list,
 * since payments stores no address of its own.
 */

/**
 * One catalog product, as a management client sees it.
 *
 * **Strictly less than the client projection already ships, and the reasoning is that file's.**
 * `clientProjection` argues that a product's Apple and Google SKUs stay server-side because a browser has
 * no use for them, and that the `grants` block stays there because a currency code and an amount describe
 * the economy. A management client needs less again: it is filling a list of *things that can be comped*,
 * and a comp names an entitlement key. So there is no Stripe price id here either — publishable in a
 * paywall, where it is the thing a Checkout Session names, and simply not this surface's business.
 *
 * The invariant, rather than the field list, is what `controlPlane.workers.test.ts` asserts: every value in
 * the response is one of these four facts about some product. A field added here carrying anything else
 * fails that test whatever it is called, which is the point — a projection somebody must remember not to
 * widen is not a control.
 */
export const PaymentsAdminCatalogProduct = z
  .object({
    id: z.string().describe("The logical product id — the key in `products`, and what lands in every purchase row."),
    type: PaymentsProductType.describe("What kind of product it is. Decides how a renewal and a restore behave."),
    name: z.string().describe("The display name the adopter wrote — `Pro`, `Remove ads`. What a list renders."),
    entitlements: z
      .array(z.string())
      .describe(
        "The entitlement keys this product grants. The whole reason this read exists: a comp names a key, so this is the list a grant control offers instead of a text box.",
      ),
  })
  .describe("One catalog product as a management client sees it: what it is, and what it grants.");
export type PaymentsAdminCatalogProduct = z.output<typeof PaymentsAdminCatalogProduct>;

/**
 * `GET {base}/admin/catalog` — what this project sells.
 *
 * **`enabled` is the same modelled answer `clientProjection` gives, and deliberately the same shape.** A
 * catalog with nothing in it answers `{ enabled: false }` rather than an empty list, so "composed with
 * nothing to sell" is a state a client renders as *there is nothing to comp here* instead of as a dropdown
 * that came back broken. A catalog that failed to load is not this: it is a non-200, or a body that does
 * not parse, and a client that branches on `enabled` never confuses the two.
 *
 * A discriminated union rather than an optional `products`, because the two states are genuinely different
 * answers and an optional array makes "empty" and "absent" indistinguishable at the exact moment a caller
 * needs them apart.
 */
export const PaymentsAdminCatalogResponse = z
  .discriminatedUnion("enabled", [
    z
      .object({
        enabled: z
          .literal(false)
          .describe(
            "This project defines nothing — no product is configured and no key was declared grantable, so there is no entitlement a comp control could offer and no grant that would succeed.",
          ),
      })
      .describe("A project composing payments with an empty catalog. The same answer as not composing it at all."),
    z
      .object({
        enabled: z.literal(true).describe("This project sells something."),
        products: z
          .array(PaymentsAdminCatalogProduct)
          .describe("The catalog, in the order the adopter wrote it — which is the order a list should show."),
        manualEntitlements: z
          .array(z.string())
          .describe(
            "Entitlement keys the adopter declared grantable with no product behind them. Offered beside the products because a comp control that omitted them would refuse the grants it then submitted.",
          ),
      })
      .describe("The catalog, as a management client reads it."),
  ])
  .describe("What this project sells, or that it sells nothing. Never a price, a SKU, or a rail's identifier.");
export type PaymentsAdminCatalogResponse = z.output<typeof PaymentsAdminCatalogResponse>;

/** Where a page resumes, or the end of the list. */
const NextCursor = z
  .string()
  .nullable()
  .describe("Where the next page resumes. Null at the end of the list. Opaque — pass it back verbatim.");

/**
 * One purchase, as a management client sees it.
 *
 * Wider than {@link PaymentsPurchaseView} in the two ways an operator needs and a buyer does not: it
 * names the **owner**, and it names the **money**. Narrower in one: there is no `outcome`, because
 * `outcome` says what a *write* did — projected, replayed, ignored — and a read of the log has no write
 * to report.
 *
 * The provider identifiers are kept and the provider *payload* is not, and the line between them is
 * whether the value is a bearer artifact. A transaction id is the join key an operator pastes into App
 * Store Connect or the Stripe dashboard to settle a dispute; a receipt is the thing that could be
 * replayed. The first is the whole point of the pane and the second never leaves the Worker.
 */
export const PaymentsAdminPurchaseView = z
  .object({
    id: z.string().describe("The purchase's UUID — its stable identifier on this Worker."),
    userId: z
      .string()
      .describe(
        "The account that bought it — the opaque id the adopter's auth capability issued. The only identity field payments stores, and the join key to `auth:users:read`, which is granted separately.",
      ),
    rail: PaymentsRail.describe("Which store this transaction came from."),
    providerTransactionId: z
      .string()
      .describe(
        "The store's own transaction id — what an operator pastes into App Store Connect, Play Console or the Stripe dashboard. An identifier, never a credential: the receipt that would be one is not projected.",
      ),
    originalTransactionId: z
      .string()
      .nullable()
      .describe(
        "The transaction that started this subscription, chaining renewals back to it. Null for a one-time purchase.",
      ),
    productId: z
      .string()
      .describe(
        "The catalog product the verified SKU resolved to, copied at projection time so a later config edit cannot rewrite history.",
      ),
    type: PaymentsProductType.describe("What kind of product it is."),
    status: PurchaseStatus.describe("The normalized status. Nothing here is ever a rail-specific state."),
    environment: PurchaseEnvironment.describe(
      "The store environment it happened in. Rendered rather than filtered on by default: a sandbox transaction read as a production one is the oldest defect in in-app purchasing.",
    ),
    amountMinor: z
      .number()
      .int()
      .nullable()
      .describe(
        "What was charged, in the currency's minor unit — an integer, never a float. Null where the rail reported no amount, which is common on a renewal.",
      ),
    currency: z.string().nullable().describe("The ISO currency the amount is in, or null when none was reported."),
    purchasedAt: z.iso.datetime().describe("When the store recorded the purchase, ISO-8601."),
    expiresAt: z.iso.datetime().nullable().describe("When access lapses, ISO-8601; null for one that never does."),
    revokedAt: z.iso.datetime().nullable().describe("When it was refunded or revoked, ISO-8601; null when it was not."),
    updatedAt: z.iso
      .datetime()
      .describe("When this row was last projected, ISO-8601 — how an operator tells a live row from a stale one."),
  })
  .describe("One purchase as a management client sees it. Never the stored provider payload.");
export type PaymentsAdminPurchaseView = z.output<typeof PaymentsAdminPurchaseView>;

/**
 * One entitlement, as a management client sees it.
 *
 * Wider than {@link PaymentsEntitlementView} by the two facts a buyer has no use for and an operator
 * cannot work without: **whose** it is, and **why** they have it. `manual` is the difference between an
 * entitlement somebody paid for and one somebody decided; `source` is the purchase currently granting
 * it, which answers "why is this account entitled" without a scan.
 */
export const PaymentsAdminEntitlementView = z
  .object({
    userId: z.string().describe("The account holding it — the opaque id the adopter's auth capability issued."),
    key: z.string().describe("The entitlement key the adopter's gating code names — `pro`, `beta`."),
    granted: z
      .boolean()
      .describe(
        "Whether it grants access right now, resolved against `expiresAt` on this read exactly as the hot path resolves it. The stored flag is an optimization; this is the answer.",
      ),
    expiresAt: z.iso.datetime().nullable().describe("When it lapses, ISO-8601; null for one that does not."),
    manual: z
      .boolean()
      .describe(
        "Whether a human wrote this row through the control plane rather than a purchase producing it. A manual grant is held against the projection, so it survives the account's next renewal.",
      ),
    source: z
      .string()
      .nullable()
      .describe(
        "The purchase currently granting this entitlement, or null when nothing does — a comp, or a grant whose purchase has lapsed.",
      ),
  })
  .describe("One entitlement as a management client sees it: whose it is, whether it grants, and why.");
export type PaymentsAdminEntitlementView = z.output<typeof PaymentsAdminEntitlementView>;

/** `GET {base}/admin/purchases`. */
export const PaymentsAdminPurchasesResponse = z
  .object({
    purchases: z.array(PaymentsAdminPurchaseView).describe("The page, most recently purchased first."),
    nextCursor: NextCursor,
  })
  .describe("A page of the purchase log.");
export type PaymentsAdminPurchasesResponse = z.output<typeof PaymentsAdminPurchasesResponse>;

/** `GET {base}/admin/subscriptions` — the same rows, narrowed to the ones that renew. */
export const PaymentsAdminSubscriptionsResponse = z
  .object({
    subscriptions: z
      .array(PaymentsAdminPurchaseView)
      .describe("The page, most recently purchased first. Every row has `type: subscription`."),
    nextCursor: NextCursor,
  })
  .describe("A page of the purchases that renew.");
export type PaymentsAdminSubscriptionsResponse = z.output<typeof PaymentsAdminSubscriptionsResponse>;

/** `GET {base}/admin/entitlements`. */
export const PaymentsAdminEntitlementsResponse = z
  .object({
    entitlements: z.array(PaymentsAdminEntitlementView).describe("The page, most recently first granted first."),
    nextCursor: NextCursor,
  })
  .describe("A page of the entitlement model, across every account.");
export type PaymentsAdminEntitlementsResponse = z.output<typeof PaymentsAdminEntitlementsResponse>;

/**
 * `GET {base}/admin/entitlements/:userId`.
 *
 * No cursor, because there is no page: the table is keyed `UNIQUE (userId, entitlement)`, so this is at
 * most one row per key. An account holding nothing answers an empty list rather than a 404 — an
 * entitlement row appears with the first purchase that grants one, so its absence is not a missing
 * person, and a 404 would make this an existence oracle for user ids.
 */
export const PaymentsAdminUserEntitlementsResponse = z
  .object({
    userId: z.string().describe("The account asked after, echoed so a response stands on its own."),
    entitlements: z
      .array(PaymentsAdminEntitlementView)
      .describe("Every entitlement this account holds, by key. Empty when it holds none."),
  })
  .describe("One account's entitlements, resolved now.");
export type PaymentsAdminUserEntitlementsResponse = z.output<typeof PaymentsAdminUserEntitlementsResponse>;
