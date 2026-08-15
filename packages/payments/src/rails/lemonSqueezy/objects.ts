// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { pauseResumesAt } from "../../data/pause";
import type { PurchaseEnvironment } from "../../data/purchase";
import type { PurchaseStatus } from "../../data/status";
import { PaymentsVerificationFailedError } from "../../error/errors";
import type { UnboundProviderEvent } from "../contract";

/**
 * Lemon Squeezy's objects, and the mapping from what its webhooks say to what this package stores.
 *
 * ## Identifiers are namespaced, and that is not a style choice
 *
 * Lemon Squeezy numbers **each object type from one**, and renders the number as a JSON:API string. So order
 * `8801` and subscription-invoice `8801` are different objects wearing the same `data.id`. A purchase row's
 * identity is `UNIQUE (rail, providerTransactionId)`, so storing the bare id would silently fuse an order and
 * an invoice into one row — one buyer's refund landing on another buyer's subscription.
 *
 * Stripe never faced this because `pi_`, `in_` and `sub_` are globally distinct, so the Stripe rail stores its
 * ids verbatim. Here the type has to be part of the key, and {@link namespacedId} is the only way an id is
 * allowed to reach the writer. The prefix is stable forever: it is inside the row's identity.
 *
 * ## Two rows per subscription, and why
 *
 * Lemon Squeezy splits money from state at the source. `subscription_payment_*` delivers a **subscription
 * invoice**: an amount, a currency, and nothing about whether the subscription is still live.
 * `subscription_*` delivers a **subscription**: a status and a renewal date, and no charge. Neither names the
 * other's key — an LS subscription has no latest-invoice pointer — so there is no honest way to collapse them
 * onto one row.
 *
 * Collapsing them anyway would mean stamping two different clocks into one monotonic `providerEventAt`: the
 * invoice's `updated_at` lives in the invoice domain and moves when a refund is issued months later, while the
 * subscription's moves on every renewal. That is the defect the CMS learned expensively — an invoice timestamp
 * written into a subscription's watermark drops the `subscription_updated` that follows a renewal.
 *
 * So: a **state row** keyed on the subscription, and a **money row** per invoice, distinguished by
 * `PurchaseRole`. Each row is monotonic on exactly one provider clock, and an invoice event physically cannot
 * address the state row because the keys differ. That is a property of the schema rather than of careful code.
 * Only the money rows fulfill a `grants` clause, which is what makes N renewals credit exactly N times.
 *
 * ## The environment fence
 *
 * A Lemon Squeezy store is **one namespace across every environment** — test mode is a flag on an object, not
 * a separate store — so a `dev` deployment and a `staging` deployment pointed at one store both hear
 * everything the other's buyers do. `createCheckoutSession` stamps this deployment's `ENVIRONMENT` into
 * `checkout_data.custom`, the store echoes it back as `meta.custom_data`, and an event stamped for somebody
 * else projects nothing: no row, no entitlement, no audit warning, and a 200.
 *
 * An event carrying **no** stamp is not fenced. An order placed in the Lemon Squeezy storefront rather than
 * through our checkout carries no `custom_data` at all, and fencing on absence would silently drop real sales.
 *
 * `test_mode` is a separate axis and drives `environment`, which the projection writer refuses across.
 *
 * ## Custom data is snake_case, in both directions
 *
 * Lemon Squeezy normalizes custom keys to snake_case before echoing them back. What checkout sends and what
 * this module reads must therefore both be snake_case, even though the rest of this codebase is camelCase.
 * Sending `pithyEnv` and reading `pithy_env` silently never matches, and the binding never happens — so the
 * two constants below are the single source for both sides and the round-trip is pinned by a test.
 */

/** The `checkout_data.custom` key carrying the authenticated purchaser. snake_case, because LS normalizes to it. */
export const LEMON_SQUEEZY_CUSTOM_ACCOUNT = "pithy_account_reference";

/** The `checkout_data.custom` key carrying this deployment's environment. snake_case, for the same reason. */
export const LEMON_SQUEEZY_CUSTOM_ENV = "pithy_env";

/**
 * The `checkout_data.custom` key carrying the proof that **this deployment's server** wrote the two above.
 *
 * Without it the other two prove nothing. Lemon Squeezy's public storefront buy links accept
 * `checkout[custom][...]` parameters and the webhook echoes them exactly as an API-created checkout's would,
 * so anyone can set `pithy_account_reference`. The environment stamp does not save it: these key names are
 * exported constants in an open-source package and the value is one of three (`dev`, `staging`, `prod`), so
 * requiring it asks an attacker to guess nothing at all.
 *
 * A MAC is the only thing that distinguishes the two, because it is the only thing a stranger cannot
 * produce. See {@link accountReferenceProof}.
 */
export const LEMON_SQUEEZY_CUSTOM_PROOF = "pithy_ref_proof";

/**
 * One identifier, prefixed by the object type it came from.
 *
 * The prefix is part of the row's identity forever, so it is never derived from anything that could change
 * spelling. Three values, and they are the only three.
 */
export function namespacedId(type: "subscription" | "subscription_invoice" | "order", id: string): string {
  return `${type}:${id}`;
}

/** A JSON:API envelope, narrowed to what any of this rail's objects need. `.loose()` — LS adds fields. */
const LemonSqueezyObject = z
  .object({
    id: z.string().describe("The object's own id — an integer as a string, unique only within its type."),
    attributes: z.record(z.string(), z.unknown()).describe("The object's fields, whose shape depends on its type."),
  })
  .loose();

/** The webhook envelope every delivery arrives in. */
export const LemonSqueezyWebhook = z
  .object({
    meta: z
      .object({
        event_name: z.string().describe("Which event this is — `order_created`, `subscription_updated`, and so on."),
        test_mode: z
          .boolean()
          .optional()
          .describe("Whether the object belongs to the store's test mode. Drives `environment`, never the fence."),
        custom_data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "What this deployment's own server attached when it created the checkout, echoed back with keys normalized to snake_case. Absent for a storefront purchase.",
          ),
      })
      .loose()
      .describe("The delivery's metadata — what happened, and what we asked to have echoed back."),
    data: LemonSqueezyObject.describe("The object the event is about: an order, a subscription, or an invoice."),
  })
  .loose()
  .describe("One Lemon Squeezy webhook delivery, as received.");
export type LemonSqueezyWebhook = z.infer<typeof LemonSqueezyWebhook>;

/** A subscription's fields, as a `subscription_*` webhook and the API both present them. */
export const LemonSqueezySubscription = z
  .object({
    store_id: z.number().optional().describe("The store the subscription belongs to."),
    customer_id: z.number().optional().describe("The Lemon Squeezy customer — this rail's `providerAccountId`."),
    variant_id: z.number().optional().describe("The variant sold, which is this rail's SKU."),
    status: z.string().describe("Lemon Squeezy's own status vocabulary, normalized by `subscriptionStatus`."),
    renews_at: z.string().nullish().describe("When the current period renews, if it is going to."),
    ends_at: z.string().nullish().describe("When access ends for a cancelled subscription, if it is ending."),
    pause: z
      .object({
        mode: z.string().nullish().describe("`void` or `free` — what the subscriber keeps while paused. Recorded."),
        resumes_at: z
          .string()
          .nullish()
          .describe("When the pause ends, as Lemon Squeezy states it. Null for an open-ended pause."),
      })
      .loose()
      .nullish()
      .describe("The pause in force, when one is. Null while the subscription is not paused."),
    created_at: z.string().describe("When the subscription began."),
    updated_at: z.string().describe("The subscription's own clock — the state row's `providerEventAt`."),
    test_mode: z.boolean().optional().describe("Whether this is a test-mode subscription."),
  })
  .loose()
  .describe("A Lemon Squeezy subscription — the standing of a recurring purchase, carrying no charge.");
export type LemonSqueezySubscription = z.infer<typeof LemonSqueezySubscription>;

/** A subscription invoice's fields — one billing period's money. */
export const LemonSqueezySubscriptionInvoice = z
  .object({
    store_id: z.number().optional().describe("The store the invoice belongs to."),
    subscription_id: z.number().describe("The subscription this invoice bills — the family key."),
    customer_id: z.number().optional().describe("The Lemon Squeezy customer charged."),
    status: z.string().describe("The invoice's own status — `paid`, `pending`, `void`, `refunded`."),
    refunded: z.boolean().optional().describe("Whether this invoice was refunded, in whole or in part."),
    refunded_at: z.string().nullish().describe("When it was refunded, if it was."),
    currency: z.string().optional().describe("The ISO currency the total is in."),
    total: z.number().optional().describe("The amount charged, in the currency's minor unit."),
    created_at: z.string().describe("When the invoice was raised — the money row's `purchasedAt`."),
    updated_at: z.string().describe("The invoice's own clock — the money row's `providerEventAt`."),
    test_mode: z.boolean().optional().describe("Whether this is a test-mode invoice."),
  })
  .loose()
  .describe("A Lemon Squeezy subscription invoice — one billing period's charge, carrying no subscription state.");
export type LemonSqueezySubscriptionInvoice = z.infer<typeof LemonSqueezySubscriptionInvoice>;

/** An order's fields — a one-off purchase. */
export const LemonSqueezyOrder = z
  .object({
    store_id: z.number().optional().describe("The store the order belongs to."),
    customer_id: z.number().optional().describe("The Lemon Squeezy customer who bought."),
    status: z.string().describe("The order's status — `paid`, `refunded`, `pending`, `failed`."),
    refunded: z.boolean().optional().describe("Whether the order was refunded."),
    refunded_at: z.string().nullish().describe("When it was refunded, if it was."),
    currency: z.string().optional().describe("The ISO currency the total is in."),
    total: z.number().optional().describe("The amount charged, in the currency's minor unit."),
    first_order_item: z
      .object({ variant_id: z.number().optional().describe("The variant bought — this rail's SKU.") })
      .loose()
      .optional()
      .describe("The order's first line item, which is where a single-product order carries its variant."),
    created_at: z.string().describe("When the order was placed."),
    updated_at: z.string().describe("The order's own clock."),
    test_mode: z.boolean().optional().describe("Whether this is a test-mode order."),
  })
  .loose()
  .describe("A Lemon Squeezy order — a one-off purchase, where money and state are the same object.");
export type LemonSqueezyOrder = z.infer<typeof LemonSqueezyOrder>;

/**
 * Which store environment an object belongs to.
 *
 * `=== false ? "production"` and never `=== true ? "sandbox"`, so an absent flag lands on sandbox. The
 * failure directions are not symmetric: treating production as sandbox loses a purchase that reconciliation
 * repairs, while treating sandbox as production hands out real entitlements for test transactions.
 */
function environment(testMode: boolean | undefined): PurchaseEnvironment {
  return testMode === false ? "production" : "sandbox";
}

/** A Lemon Squeezy timestamp, or a refusal. Its API emits ISO-8601 throughout. */
function at(value: string, what: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new PaymentsVerificationFailedError({
      detail: `Lemon Squeezy: ${what} is not a readable timestamp.`,
    });
  }
  return parsed;
}

/**
 * A subscription's status, normalized.
 *
 * `on_trial` grants: a trial is access the store is currently giving, and refusing it would lock a user out
 * of the thing they signed up for. `unpaid` is `on_hold` rather than `expired` — Lemon Squeezy has exhausted
 * its dunning and the money never arrived, so nothing was paid and nothing may be credited. An unknown
 * status refuses rather than guessing, which is the Stripe rail's rule too: a status this package has never
 * seen is a shape change worth failing loudly on.
 */
export function subscriptionStatus(status: string): PurchaseStatus {
  switch (status) {
    case "on_trial":
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "past_due":
      return "in_grace";
    case "unpaid":
      return "on_hold";
    case "cancelled":
      return "canceled";
    case "expired":
      return "expired";
    default:
      throw new PaymentsVerificationFailedError({
        detail: `Lemon Squeezy: subscription status "${status}" is not one this build maps.`,
      });
  }
}

/**
 * A subscription invoice's status, normalized — the money's own story, not the subscription's.
 *
 * A paid invoice is `expired` rather than `active`, and that is deliberate: it records a billing period that
 * was paid for and has closed, and `expired` is the status that credits a `grants` clause without granting
 * access. Access comes from the state row. A `void` or `failed` invoice is `never_paid`, which credits
 * nothing and is never clawed back, because no money ever moved.
 */
export function invoiceStatus(invoice: LemonSqueezySubscriptionInvoice): PurchaseStatus {
  if (invoice.refunded === true || invoice.status === "refunded") return "refunded";
  switch (invoice.status) {
    case "paid":
      return "expired";
    case "pending":
      // An invoice raised and not yet settled. Neither status grants on a money row, but `on_hold` is what
      // "the payment is outstanding" means, and the two must not drift apart across the pair.
      return "on_hold";
    case "void":
    case "failed":
      return "never_paid";
    default:
      throw new PaymentsVerificationFailedError({
        detail: `Lemon Squeezy: subscription invoice status "${invoice.status}" is not one this build maps.`,
      });
  }
}

/** An order's status, normalized. An order is money and state at once, so a paid one grants. */
export function orderStatus(order: LemonSqueezyOrder): PurchaseStatus {
  if (order.refunded === true || order.status === "refunded") return "refunded";
  switch (order.status) {
    case "paid":
      return "active";
    case "pending":
      // `on_hold`, not `in_grace`. Grace means a *paid* subscriber whose renewal is retrying, and it grants
      // by policy — on an order, which carries no expiry, that would be permanent free access for money
      // that never arrived. `on_hold` is the status for a payment outstanding, and it never grants.
      return "on_hold";
    case "failed":
      return "never_paid";
    default:
      throw new PaymentsVerificationFailedError({
        detail: `Lemon Squeezy: order status "${order.status}" is not one this build maps.`,
      });
  }
}

/** The state row a subscription object implies. Carries no amount — a subscription is not a charge. */
export function subscriptionEvent(id: string, subscription: LemonSqueezySubscription): UnboundProviderEvent {
  const status = subscriptionStatus(subscription.status);
  const ends = subscription.ends_at ?? subscription.renews_at ?? null;
  return {
    rail: "lemonSqueezy",
    providerTransactionId: namespacedId("subscription", id),
    // Uniform with the money rows, which name this same subscription as their family. A state row is its own
    // family's head, so both columns carry the same value and the owner lookup matches on either.
    originalTransactionId: namespacedId("subscription", id),
    providerProductId: String(subscription.variant_id ?? ""),
    role: "state",
    status,
    environment: environment(subscription.test_mode),
    purchasedAt: at(subscription.created_at, "a subscription's created_at"),
    expiresAt: ends === null ? null : at(ends, "a subscription's ends_at"),
    revokedAt: null,
    // Lemon Squeezy's own answer to "when does this come back". Null on the pause object is an open-ended
    // pause, which `pauseResumesAt` keeps distinct from a subscription that is not paused at all.
    resumesAt: pauseResumesAt({ rail: "lemonSqueezy", status, reported: subscription.pause?.resumes_at }),
    amountMinor: null,
    currency: null,
    providerEventAt: at(subscription.updated_at, "a subscription's updated_at"),
    payload: { ...subscription },
  };
}

/** The money row a subscription invoice implies, given the variant its subscription is for. */
export function invoiceEvent(
  id: string,
  invoice: LemonSqueezySubscriptionInvoice,
  variantId: string,
): UnboundProviderEvent {
  const status = invoiceStatus(invoice);
  const raised = at(invoice.created_at, "an invoice's created_at");
  return {
    rail: "lemonSqueezy",
    providerTransactionId: namespacedId("subscription_invoice", id),
    originalTransactionId: namespacedId("subscription", String(invoice.subscription_id)),
    providerProductId: variantId,
    role: "charge",
    status,
    environment: environment(invoice.test_mode),
    purchasedAt: raised,
    // An already-closed window rather than null. A money row must never be the reason access is granted —
    // that is the state row's job — and `expired` with a past expiry says exactly what this row is.
    expiresAt: raised,
    revokedAt: status === "refunded" ? at(invoice.refunded_at ?? invoice.updated_at, "an invoice's refunded_at") : null,
    amountMinor: invoice.total ?? null,
    currency: invoice.currency ?? null,
    providerEventAt: at(invoice.updated_at, "an invoice's updated_at"),
    payload: { ...invoice },
  };
}

/** The row a one-off order implies. Money and state at once, so one row does both jobs. */
export function orderEvent(id: string, order: LemonSqueezyOrder): UnboundProviderEvent {
  const status = orderStatus(order);
  return {
    rail: "lemonSqueezy",
    providerTransactionId: namespacedId("order", id),
    originalTransactionId: null,
    providerProductId: String(order.first_order_item?.variant_id ?? ""),
    role: "charge",
    status,
    environment: environment(order.test_mode),
    purchasedAt: at(order.created_at, "an order's created_at"),
    expiresAt: null,
    revokedAt: status === "refunded" ? at(order.refunded_at ?? order.updated_at, "an order's refunded_at") : null,
    amountMinor: order.total ?? null,
    currency: order.currency ?? null,
    providerEventAt: at(order.updated_at, "an order's updated_at"),
    payload: { ...order },
  };
}

/**
 * The account reference this deployment stamped into the checkout, or null.
 *
 * **Honoured only when this deployment's own environment stamp is beside it**, and that condition is the
 * whole security of the field. `accountReference`'s contract says it is "a value this deployment's own
 * server wrote and the store returned unchanged" — the route writes the provider-account link from it, and
 * `linkProviderAccount` never rebinds, so the first pairing is permanent.
 *
 * Lemon Squeezy's public storefront buy links accept `checkout[custom][...]` query parameters, and the
 * resulting webhook echoes them in `meta.custom_data` exactly as an API-created checkout's would. So
 * `custom_data` on its own is **not** evidence our server wrote anything: an unauthenticated stranger can
 * put any string in it and permanently bind their store customer to an account they chose. The env stamp is
 * the discriminator, because it is written only by {@link createLemonSqueezyCheckoutSession}, and a checkout
 * a stranger built through the storefront carries either no stamp or another deployment's.
 *
 * A deployment that does not know its own `ENVIRONMENT` trusts no reference at all. That is the safe
 * direction: the cost is a purchase that lands unbound and is repairable from the trail, where the other way
 * round is an unauthenticated write into the account map that nothing ever undoes.
 */
export async function accountReferenceOf(
  webhook: LemonSqueezyWebhook,
  deployment: string | undefined,
  secret: string,
): Promise<string | null> {
  if (deployment === undefined) return null;

  const custom = webhook.meta.custom_data;
  const reference = custom?.[LEMON_SQUEEZY_CUSTOM_ACCOUNT];
  const stampedEnv = custom?.[LEMON_SQUEEZY_CUSTOM_ENV];
  const proof = custom?.[LEMON_SQUEEZY_CUSTOM_PROOF];
  if (typeof reference !== "string" || reference === "") return null;
  if (typeof stampedEnv !== "string" || typeof proof !== "string") return null;

  // The environment is checked as part of the MAC's message rather than beside it, so a proof minted for
  // staging cannot be replayed against production by editing one field.
  if (stampedEnv !== deployment) return null;
  return (await accountReferenceProofMatches(reference, deployment, secret, proof)) ? reference : null;
}

/**
 * The proof this deployment stamps beside an account reference, and the only reason the reference is worth
 * anything.
 *
 * An HMAC over the environment and the user id, keyed with a secret a stranger does not have. The message is
 * domain-separated by a fixed prefix so this MAC can never be confused with the webhook-body signature that
 * shares its key: the two answer different questions, and a value that satisfied both would be a
 * cross-protocol attack waiting to be found.
 *
 * The key is the webhook signing secret because it is already per-environment, already rotated with the
 * rail, and already known only to this deployment and to Lemon Squeezy — and Lemon Squeezy is not the
 * attacker here. The attacker is anyone who can open a storefront buy link, which is everyone.
 */
export async function accountReferenceProof(reference: string, deployment: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = `${ACCOUNT_REFERENCE_DOMAIN}${deployment}:${reference}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Domain separation, so this MAC and the webhook body signature can never be mistaken for one another. */
const ACCOUNT_REFERENCE_DOMAIN = "pithy:lemonSqueezy:account-reference:v1:";

/** Whether a stamped proof matches, compared in constant time by the runtime rather than by `===`. */
async function accountReferenceProofMatches(
  reference: string,
  deployment: string,
  secret: string,
  candidate: string,
): Promise<boolean> {
  const expected = await accountReferenceProof(reference, deployment, secret);
  if (candidate.length !== expected.length) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = hexToBytes(candidate);
  if (bytes === undefined) return false;
  return await crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    new TextEncoder().encode(`${ACCOUNT_REFERENCE_DOMAIN}${deployment}:${reference}`),
  );
}

/** Decode hex, or undefined when it is not hex. */
function hexToBytes(value: string): Uint8Array | undefined {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) return undefined;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Whether this delivery belongs to another deployment sharing the same store.
 *
 * True only when both sides named an environment and they differ. An unstamped delivery is ours to consider
 * — a storefront order has no `custom_data` — and a deployment that does not know its own environment
 * fences nothing, which is precisely how the other three rails behave.
 */
export function fencedOut(webhook: LemonSqueezyWebhook, deployment: string | undefined): boolean {
  const stamped = webhook.meta.custom_data?.[LEMON_SQUEEZY_CUSTOM_ENV];
  if (typeof stamped !== "string" || stamped === "" || deployment === undefined) return false;
  return stamped !== deployment;
}
