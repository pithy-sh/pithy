// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { PurchaseEnvironment } from "../../data/purchase";
import type { PurchaseStatus } from "../../data/status";
import { PaymentsVerificationFailedError } from "../../error/errors";
import type { UnboundProviderEvent } from "../contract";

/**
 * Paddle's objects, and the mapping from what its events say to what this package stores.
 *
 * ## Two rows per subscription, exactly as Lemon Squeezy has
 *
 * Paddle splits money from state at the source. A `transaction.*` event carries a **transaction**: one
 * billing period's charge, its totals, its status. A `subscription.*` event carries a **subscription**: a
 * status, a billing period, a scheduled change, and no money. So there is a **state row** keyed on
 * `sub_…` and a **money row** per `txn_…`, distinguished by `PurchaseRole`, and each is monotonic on
 * exactly one provider clock.
 *
 * Paddle's ids are globally prefixed and distinct — `txn_`, `sub_`, `adj_`, `ctm_` — so unlike Lemon
 * Squeezy nothing needs namespacing before it can be a row's identity.
 *
 * **A subscription transaction is born `expired`, not `active`, and this is a departure from the issue's
 * event table stated out loud.** The issue maps `transaction.completed` to `active`. On a one-off that is
 * right and this module does it. On a subscription it would be a row with no expiry saying "paid and
 * current" forever — and a never-expiring `active` row outranks the subscription's own state row, so a
 * cancelled subscriber would keep their entitlement for good. The paid period is real and it has closed:
 * `expired` grants nothing and still credits a `grants` clause, which is what makes two renewals credit
 * twice. This is the trap `lemonSqueezy/objects.ts` documents at length; Paddle has it identically.
 *
 * ## The environment is the account, not a field on the payload
 *
 * The issue says `data.mode` is `sandbox` or `live`. It is not. Verified against a live sandbox: `mode`
 * appears on a **discount**, where its values are `standard` and `custom`, and it is absent from customers
 * and transactions entirely. Paddle Billing partitions sandbox from live by *account* — a separate host,
 * a separate API key, a separate set of notification destinations — so the environment a purchase belongs
 * to is the environment this deployment's credentials point at, and nothing in a payload can contradict
 * it. That is the same arrangement Stripe has, and the opposite of Lemon Squeezy's single namespace.
 *
 * ## The environment fence, and why `custom_data` alone cannot be one
 *
 * `dev` is not publicly routable, so a dev checkout's webhooks land at `staging` — both point at one
 * Paddle sandbox, and a sandbox has one set of notification destinations. So a delivery stamped for
 * another environment is the normal case here, not an anomaly, and it projects nothing and returns 200.
 *
 * The issue argues the stamp needs no proof, because "`Paddle.Checkout.open` refuses `customData`
 * alongside `transactionId`, and the server always creates the transaction." That constraint is real and
 * it applies only to the `transactionId` form. Paddle's own documentation shows
 * `Paddle.Checkout.open({ items: [{ priceId, quantity }], customData: {…} })` as a first-class call
 * needing nothing but the publishable client token — the token this rail itself ships to every browser
 * that loads a paywall. So `custom_data.pithy_user` is a string a browser can write, and binding
 * ownership on it would let anyone attach a purchase to any account, permanently, because
 * `linkProviderAccount` never rebinds and the first pairing wins.
 *
 * The Lemon Squeezy rail met the same problem and answered it with a MAC. So does this one: see
 * {@link accountReferenceProof}. Without the proof the two stamped values are worth nothing, and with it
 * they are worth exactly what a value only this deployment's server could have produced is worth.
 */

/** The `custom_data` key carrying the authenticated purchaser. Literal snake_case, as the issue specifies. */
export const PADDLE_CUSTOM_ACCOUNT = "pithy_user";

/** The `custom_data` key carrying this deployment's environment — the shared-sandbox fence. */
export const PADDLE_CUSTOM_ENV = "pithy_env";

/**
 * The `custom_data` key carrying the proof that **this deployment's server** wrote the two above.
 *
 * Without it the other two prove nothing: `Paddle.Checkout.open` accepts `customData` beside an `items[]`
 * array with only the publishable client token, both key names are exported constants in an open-source
 * package, and the environment value is one of three. Requiring them asks an attacker to guess nothing.
 *
 * A MAC is the only part a stranger cannot produce.
 */
export const PADDLE_CUSTOM_PROOF = "pithy_ref_proof";

/**
 * Paddle stores `custom_data` verbatim — it does not normalize keys the way Lemon Squeezy snake_cases
 * them. The `pithy_` prefix is still load-bearing: this object is shared with whatever an adopter puts in
 * it, and a prefix is what stops a collision being silent rather than being a wrong owner.
 */
const CustomData = z
  .record(z.string(), z.unknown())
  .describe("Arbitrary key/value data stored verbatim by Paddle, shared with whatever the adopter puts there.");

/** The envelope every webhook delivery and every swept event arrives in. */
export const PaddleEvent = z
  .object({
    event_id: z
      .string()
      .min(1)
      .describe(
        "Paddle's own id for this event — `evt_…`. The dedup key, and the one the webhook path and the events sweep share, because the stream carries no notification_id.",
      ),
    event_type: z.string().min(1).describe("Which event this is — `transaction.completed`, `subscription.canceled`."),
    occurred_at: z
      .string()
      .min(1)
      .describe(
        "When the event happened, from the envelope. This is `providerEventAt`, never the entity's `updated_at`: a transaction's clock lives in the transaction's domain, and stamping it onto a subscription's watermark discards the `subscription.activated` that follows.",
      ),
    data: z.record(z.string(), z.unknown()).describe("The entity the event is about."),
  })
  .loose()
  .describe("One Paddle event, as a webhook delivers it and as the events stream returns it.");
export type PaddleEvent = z.infer<typeof PaddleEvent>;

/** One transaction line item, narrowed to the price it names. */
const PaddleTransactionItem = z
  .object({
    price: z
      .object({ id: z.string().optional().describe("The price sold — this rail's SKU.") })
      .loose()
      .optional()
      .describe("The price object, which is where a transaction carries its SKU."),
    price_id: z.string().optional().describe("The price id, on the shapes that carry it flat."),
  })
  .loose()
  .describe("One line of a transaction. Single-product checkouts have exactly one.");

/** An adjustment's fields — a refund, a credit, or a chargeback, which on this rail can arrive unsolicited. */
export const PaddleAdjustment = z
  .object({
    id: z.string().min(1).describe("The adjustment — `adj_…`."),
    action: z
      .string()
      .min(1)
      .describe(
        "What it does — `refund`, `credit`, `chargeback`, `chargeback_reverse`, `chargeback_warning`, `chargeback_warning_reverse`, `credit_reverse`.",
      ),
    status: z.string().nullish().describe("`pending_approval`, `approved`, `rejected`, or `reversed`."),
    transaction_id: z.string().min(1).describe("The transaction adjusted. The only key that names a row of ours."),
    subscription_id: z.string().nullish().describe("The subscription behind it, when there is one."),
    customer_id: z.string().nullish().describe("The customer adjusted."),
    currency_code: z.string().nullish().describe("The currency the totals are in."),
    totals: z
      .object({
        total: z.string().nullish().describe("How much was adjusted, in the currency's lowest denomination."),
      })
      .loose()
      .nullish()
      .describe(
        "What the adjustment came to. Summed with every other approved adjustment against the transaction, and that sum is what tells a full refund from a partial one.",
      ),
    created_at: z.string().nullish().describe("When Paddle raised the adjustment."),
    updated_at: z.string().nullish().describe("The adjustment's own clock. Deliberately not used as a watermark."),
  })
  .loose()
  .describe("A Paddle adjustment. As merchant of record Paddle issues these on its own, with no local write first.");
export type PaddleAdjustment = z.infer<typeof PaddleAdjustment>;

/** A transaction's fields, as an event and the API both present them. */
export const PaddleTransaction = z
  .object({
    id: z.string().min(1).describe("The transaction — `txn_…`. This row's identity forever."),
    status: z.string().min(1).describe("Paddle's own status vocabulary, normalized by `transactionStatus`."),
    customer_id: z.string().nullish().describe("The Paddle customer charged — this rail's `providerAccountId`."),
    subscription_id: z
      .string()
      .nullish()
      .describe("The subscription this transaction bills, or null for a one-off. The family key."),
    discount_id: z.string().nullish().describe("The discount applied, when one was."),
    origin: z
      .string()
      .nullish()
      .describe(
        "How the transaction came to exist — `web`, `subscription_recurring`, `api`. Recorded rather than acted on: it is undocumented enough that a fence on it would be a guess.",
      ),
    items: z.array(PaddleTransactionItem).optional().describe("The lines sold. The first carries this rail's SKU."),
    details: z
      .object({
        totals: z
          .object({
            grand_total: z
              .string()
              .optional()
              .describe("What was charged, in the currency's lowest denomination, as a string."),
            currency_code: z.string().optional().describe("The currency, uppercase ISO 4217."),
          })
          .loose()
          .optional(),
      })
      .loose()
      .optional()
      .describe("The computed totals. Paddle is the authority on every figure here; nothing recomputes one."),
    billing_period: z
      .object({
        starts_at: z.string().nullish().describe("When the period this transaction bills began."),
        ends_at: z.string().nullish().describe("When it ends."),
      })
      .loose()
      .nullish()
      .describe("The billing period a subscription transaction covers. Absent on a one-off."),
    currency_code: z.string().nullish().describe("The transaction's currency, when it carries one flat."),
    custom_data: CustomData.nullish().describe("What this deployment's server stamped at checkout, echoed back."),
    checkout: z
      .object({ url: z.string().nullish().describe("The hosted checkout page, when the account has a payment link.") })
      .loose()
      .nullish()
      .describe("Where a hosted checkout lives. Null unless the account has a default payment link set."),
    adjustments: z
      .array(PaddleAdjustment)
      .optional()
      .describe(
        "Every adjustment raised against this transaction, returned when the read asks `include=adjustments`. The whole reason it is asked for: a full refund delivered as two partial adjustments is only full when they are summed.",
      ),
    created_at: z.string().min(1).describe("When Paddle recorded the transaction."),
    updated_at: z.string().nullish().describe("The transaction's own clock. Deliberately not used as a watermark."),
  })
  .loose()
  .describe("A Paddle transaction — one billing period's charge, or a one-off purchase.");
export type PaddleTransaction = z.infer<typeof PaddleTransaction>;

/** A subscription's fields, as an event and the API both present them. */
export const PaddleSubscription = z
  .object({
    id: z.string().min(1).describe("The subscription — `sub_…`. The state row's identity, and the family key."),
    status: z.string().min(1).describe("Paddle's own status vocabulary, normalized by `subscriptionStatus`."),
    customer_id: z.string().nullish().describe("The Paddle customer — this rail's `providerAccountId`."),
    items: z
      .array(
        z
          .object({
            price: z.object({ id: z.string().optional() }).loose().optional(),
            status: z.string().optional(),
          })
          .loose(),
      )
      .optional()
      .describe("The priced items. The first carries this rail's SKU."),
    current_billing_period: z
      .object({
        starts_at: z.string().nullish().describe("When the current period began."),
        ends_at: z.string().nullish().describe("When it ends — what a cancellation's `expiresAt` becomes."),
      })
      .loose()
      .nullish()
      .describe("The period currently paid for. Null while a subscription is trialing or paused."),
    scheduled_change: z
      .object({
        action: z.string().optional().describe("`cancel`, `pause`, or `resume`."),
        effective_at: z.string().nullish().describe("When it takes effect."),
      })
      .loose()
      .nullish()
      .describe(
        "A change Paddle will apply later. A subscription with a scheduled cancel is still `active` today — the distinction between `canceled` and a scheduled change is the whole difference between access now and access until the period ends.",
      ),
    trial_dates: z
      .object({
        starts_at: z.string().nullish(),
        ends_at: z.string().nullish().describe("When the trial ends — a trialing subscription's `expiresAt`."),
      })
      .loose()
      .nullish()
      .describe("The trial window, when this subscription has one. Its end is a trialing subscription's expiry."),
    next_billed_at: z.string().nullish().describe("When the next charge falls due, when one is going to."),
    canceled_at: z.string().nullish().describe("When it was cancelled, if it was."),
    paused_at: z.string().nullish().describe("When it was paused, if it was."),
    discount: z
      .object({
        id: z.string().optional().describe("The discount in force."),
        starts_at: z.string().nullish(),
        ends_at: z.string().nullish().describe("When the discount stops applying, or null for one that runs forever."),
      })
      .loose()
      .nullish()
      .describe(
        "The discount in force, when one is. Carries an id and no code, so a screen names the date rather than the code.",
      ),
    custom_data: CustomData.nullish().describe(
      "What Paddle copied from the transaction that created this subscription. The stamp, on every later event.",
    ),
    created_at: z.string().min(1).describe("When the subscription began."),
    updated_at: z.string().nullish().describe("The subscription's own clock. Deliberately not used as a watermark."),
  })
  .loose()
  .describe("A Paddle subscription — the standing of a recurring purchase, carrying no charge.");
export type PaddleSubscription = z.infer<typeof PaddleSubscription>;

/** A Paddle timestamp, or a refusal. Its API emits RFC-3339 throughout. */
export function at(value: string, what: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new PaymentsVerificationFailedError({ detail: `Paddle: ${what} is not a readable timestamp.` });
  }
  return parsed;
}

/** The same, tolerating an absent value. */
function maybeAt(value: string | null | undefined, what: string): Date | null {
  return value === null || value === undefined || value === "" ? null : at(value, what);
}

/**
 * A subscription's status, normalized.
 *
 * `trialing` grants, with `expiresAt` at the trial's end. That hands an entitlement to somebody who has
 * paid nothing, which is what a trial *is* — and it is bounded, because the trial's end date is on the
 * row. The issue asked for this to be an explicit decision rather than a table row, so: it is deliberate,
 * and the bound is what makes it safe.
 *
 * An unknown status refuses rather than guessing, which is every other rail's rule too: a status this
 * package has never seen is a shape change worth failing loudly on.
 */
export function subscriptionStatus(status: string): PurchaseStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "in_grace";
    case "paused":
      return "paused";
    case "canceled":
      return "canceled";
    default:
      throw new PaymentsVerificationFailedError({
        detail: `Paddle: subscription status "${status}" is not one this build maps.`,
      });
  }
}

/**
 * A transaction's status, normalized — and it depends on whether the transaction bills a subscription.
 *
 * **A one-off is money and state at once**, so a completed one is `active` with no expiry: that is a
 * non-consumable bought and owned.
 *
 * **A subscription transaction is one closed billing period**, so a completed one is `expired`. It
 * credits a `grants` clause — which is what makes N renewals credit exactly N times — and grants no
 * access, because access is the state row's job. See the module doc for why `active` here would outlive
 * a cancellation.
 */
export function transactionStatus(status: string, subscription: boolean): PurchaseStatus {
  switch (status) {
    case "paid":
    case "completed":
      return subscription ? "expired" : "active";
    case "past_due":
      return "in_grace";
    case "canceled":
      // Terminated before anything cleared, so it credits nothing and no clawback follows one.
      return "never_paid";
    case "billed":
      // An invoice raised under manual collection, which this rail does not sell through. The money is
      // outstanding, so it neither grants nor credits.
      return "on_hold";
    case "draft":
    case "ready":
      return "on_hold";
    default:
      throw new PaymentsVerificationFailedError({
        detail: `Paddle: transaction status "${status}" is not one this build maps.`,
      });
  }
}

/** The price id a transaction sold. Paddle carries it under `items[].price.id`; some shapes flatten it. */
export function transactionPriceId(transaction: PaddleTransaction): string {
  const first = transaction.items?.[0];
  return first?.price?.id ?? first?.price_id ?? "";
}

/** The price id a subscription is for. */
export function subscriptionPriceId(subscription: PaddleSubscription): string {
  return subscription.items?.[0]?.price?.id ?? "";
}

/**
 * An amount Paddle reported, as an integer in the currency's lowest denomination.
 *
 * Paddle sends amounts as **strings** and always in the lowest denomination, including for the
 * zero-decimal currencies — ¥725 arrives as `"725"`, not `"72500"`, confirmed live. So this parses and
 * never scales: a multiplication here would be this package computing money, which it does not do.
 *
 * Anything that is not a plain integer string is `null` rather than a guess. `Number.parseInt` on
 * `"0.105"` answers `0`, which is a wrong amount rather than a missing one.
 */
export function minorAmount(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** A currency as this package stores it. Paddle sends uppercase; every other rail here is lowercase. */
export function currencyOf(value: string | null | undefined): string | null {
  return typeof value === "string" && value !== "" ? value.toLowerCase() : null;
}

/**
 * The money row a transaction implies.
 *
 * `providerEventAt` comes from the caller — the **envelope's** `occurred_at`, never `updated_at` — for
 * the reason the envelope schema states at the field.
 */
export function transactionEvent(
  transaction: PaddleTransaction,
  occurredAt: Date,
  environment: PurchaseEnvironment,
): UnboundProviderEvent {
  const subscriptionId = transaction.subscription_id ?? null;
  const status = transactionStatus(transaction.status, subscriptionId !== null);
  const purchased = at(transaction.created_at, "a transaction's created_at");
  return {
    rail: "paddle",
    providerTransactionId: transaction.id,
    // The subscription is the family. Two renewals are two transactions chaining back to one `sub_…`,
    // which is what makes a `grants` clause credit twice.
    originalTransactionId: subscriptionId,
    providerProductId: transactionPriceId(transaction),
    role: "charge",
    status,
    environment,
    purchasedAt: purchased,
    // A subscription's money row is an already-closed window rather than null: a money row must never be
    // the reason access is granted — that is the state row's job — and a past expiry says exactly that.
    // A one-off has no expiry, because owning it is the entitlement.
    expiresAt: subscriptionId === null ? null : purchased,
    revokedAt: null,
    amountMinor: minorAmount(transaction.details?.totals?.grand_total),
    currency: currencyOf(transaction.details?.totals?.currency_code ?? transaction.currency_code),
    providerEventAt: occurredAt,
    payload: { ...transaction },
  };
}

/**
 * The state row a subscription implies. Carries no amount — a subscription is not a charge.
 *
 * `expiresAt` is the end of what has been paid for, and which field that is depends on the standing: a
 * trial ends at its own date, everything else at the current billing period's end. A cancellation keeps
 * the period already bought rather than taking it away, which is what `canceled` means in this package's
 * status set.
 */
export function subscriptionEvent(
  subscription: PaddleSubscription,
  occurredAt: Date,
  environment: PurchaseEnvironment,
): UnboundProviderEvent {
  const status = subscriptionStatus(subscription.status);
  const ends =
    subscription.status === "trialing"
      ? (subscription.trial_dates?.ends_at ?? subscription.current_billing_period?.ends_at ?? null)
      : (subscription.current_billing_period?.ends_at ?? subscription.next_billed_at ?? null);
  return {
    rail: "paddle",
    providerTransactionId: subscription.id,
    // Uniform with the money rows, which name this same subscription as their family. A state row is its
    // own family's head, so both columns carry the same value and the owner lookup matches on either.
    originalTransactionId: subscription.id,
    providerProductId: subscriptionPriceId(subscription),
    role: "state",
    status,
    environment,
    purchasedAt: at(subscription.created_at, "a subscription's created_at"),
    expiresAt: maybeAt(ends, "a subscription's period end"),
    revokedAt: null,
    amountMinor: null,
    currency: null,
    providerEventAt: occurredAt,
    payload: { ...subscription },
  };
}

/**
 * Whether this delivery belongs to another deployment sharing the same Paddle sandbox.
 *
 * True only when both sides named an environment and they differ. An unstamped delivery is not fenced —
 * a transaction created in the Paddle dashboard carries no `custom_data`, and fencing on absence would
 * silently drop real sales — and a deployment that does not know its own `ENVIRONMENT` fences nothing,
 * which is precisely how the other rails behave.
 *
 * **This is a fence, not an authorization.** It is read off unauthenticated `custom_data` on purpose: its
 * job is to stop this deployment acting on another deployment's traffic, and the direction it can be
 * abused in is a forger declining to be projected — which they achieve by not sending anything. Deciding
 * *who owns* a purchase is {@link accountReferenceOf}'s job, and that one demands a MAC.
 */
export function fencedOut(custom: Record<string, unknown> | null | undefined, deployment: string | undefined): boolean {
  const stamped = custom?.[PADDLE_CUSTOM_ENV];
  if (typeof stamped !== "string" || stamped === "" || deployment === undefined) return false;
  return stamped !== deployment;
}

/**
 * The account reference this deployment stamped into the checkout, or null.
 *
 * **Honoured only when a MAC this deployment could have produced is beside it**, and that condition is the
 * whole security of the field. `accountReference`'s contract says it is "a value this deployment's own
 * server wrote and the store returned unchanged" — the route writes the provider-account link from it, and
 * `linkProviderAccount` never rebinds, so the first pairing is permanent.
 *
 * `Paddle.Checkout.open` accepts `customData` beside an `items[]` array of price ids with nothing but the
 * publishable client token, so `custom_data` on its own is **not** evidence our server wrote anything: a
 * stranger can put any string in it and permanently bind their Paddle customer to an account they chose.
 * The env stamp does not save it either — the key names are exported constants in an open-source package
 * and the value is one of three.
 *
 * A deployment that does not know its own `ENVIRONMENT` trusts no reference at all. That is the safe
 * direction: the cost is a purchase that lands unbound and is repairable from the trail, where the other
 * way round is an unauthenticated write into the account map that nothing ever undoes.
 */
export async function accountReferenceOf(
  custom: Record<string, unknown> | null | undefined,
  deployment: string | undefined,
  secret: string,
): Promise<string | null> {
  if (deployment === undefined) return null;

  const reference = custom?.[PADDLE_CUSTOM_ACCOUNT];
  const stampedEnv = custom?.[PADDLE_CUSTOM_ENV];
  const proof = custom?.[PADDLE_CUSTOM_PROOF];
  if (typeof reference !== "string" || reference === "") return null;
  if (typeof stampedEnv !== "string" || typeof proof !== "string") return null;

  // The environment is checked as part of the MAC's message rather than beside it, so a proof minted for
  // staging cannot be replayed against production by editing one field.
  if (stampedEnv !== deployment) return null;
  return (await proofMatches(reference, deployment, secret, proof)) ? reference : null;
}

/**
 * The proof this deployment stamps beside an account reference, and the only reason the reference is
 * worth anything.
 *
 * An HMAC over the environment and the user id, keyed with a secret a stranger does not have. The message
 * is domain-separated by a fixed prefix so this MAC can never be confused with the webhook-body signature
 * that shares its key: the two answer different questions, and a value satisfying both would be a
 * cross-protocol attack waiting to be found.
 *
 * The key is the notification destination's signing secret because it is already per-environment, already
 * rotated with the rail, and already known only to this deployment and to Paddle — and Paddle is not the
 * attacker here. The attacker is anyone who can load the paywall, which is everyone.
 */
export async function accountReferenceProof(reference: string, deployment: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message(reference, deployment)));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Domain separation, so this MAC and the webhook body signature can never be mistaken for one another. */
const ACCOUNT_REFERENCE_DOMAIN = "pithy:paddle:account-reference:v1:";

/** What the MAC covers: the domain, the environment, and the user — in that order, and never one of them. */
function message(reference: string, deployment: string): string {
  return `${ACCOUNT_REFERENCE_DOMAIN}${deployment}:${reference}`;
}

/** Whether a stamped proof matches, compared in constant time by the runtime rather than by `===`. */
async function proofMatches(
  reference: string,
  deployment: string,
  secret: string,
  candidate: string,
): Promise<boolean> {
  const bytes = hexToBytes(candidate);
  if (bytes === undefined) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(message(reference, deployment)));
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
