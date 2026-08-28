// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import { PaymentsConfig } from "../config/config";
import type { PaymentsEntitlement } from "../data/entitlement";
import {
  nextSubscriptionEvent,
  QuotedMoney,
  ScheduledSubscriptionChange,
  SubscriptionChangeQuote,
  SubscriptionStanding,
} from "../data/subscription";
import {
  PaymentsAdminCatalogProduct,
  PaymentsAdminCatalogResponse,
  PaymentsAdminEntitlementsResponse,
  PaymentsAdminEntitlementView,
  PaymentsAdminPurchasesResponse,
  PaymentsAdminPurchaseView,
  PaymentsAdminSubjectEntitlementsResponse,
  PaymentsAdminSubscriptionsResponse,
  PaymentsCheckoutHandoffResponse,
  PaymentsDeferredSubscriptionSettlement,
  PaymentsEntitlementResponse,
  PaymentsEntitlementsResponse,
  PaymentsEntitlementView,
  PaymentsPortalHandoffResponse,
  PaymentsPurchaseResponse,
  PaymentsPurchaseView,
  PaymentsQuotedMoney,
  PaymentsRefundOutcome,
  PaymentsRefundRequest,
  PaymentsRefundRequestStatus,
  PaymentsRefundResponse,
  PaymentsRestoreResponse,
  PaymentsSubscriptionNextEvent,
  PaymentsSubscriptionQuote,
  PaymentsSubscriptionQuoteResponse,
  PaymentsSubscriptionResponse,
  PaymentsSubscriptionScheduledChange,
  PaymentsSubscriptionSettlement,
  PaymentsSubscriptionStandingResponse,
  PaymentsSubscriptionView,
} from "./responses";
import { adminCatalogView, adminEntitlementView, adminPurchaseView } from "./view";

/**
 * The response schemas against the shapes the handlers build.
 *
 * **Equality, not `.parse()` alone.** A Zod object strips unknown keys, so a bare parse passes a
 * response that has grown a field the schema never heard of. Comparing the parsed value with the
 * input fails in both directions, which is what makes the two unable to drift silently.
 *
 * The live binding — that these are what the routes actually emit — is in `routes.workers.test.ts`,
 * where each response is parsed against its schema after a real request.
 */
function accepts<T>(schema: z.ZodType<T>, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
}

const PURCHASE: PaymentsPurchaseView = {
  id: "9c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a01",
  rail: "apple",
  productId: "pro_monthly",
  type: "subscription",
  status: "active",
  environment: "production",
  purchasedAt: "2026-06-01T00:00:00.000Z",
  expiresAt: "2026-07-01T00:00:00.000Z",
  resumesAt: null,
  outcome: "created",
};

const ENTITLEMENT: PaymentsEntitlementView = {
  key: "pro",
  granted: true,
  expiresAt: "2026-07-01T00:00:00.000Z",
};

describe("payments response schemas", () => {
  test("the views accept what the projections build", () => {
    accepts(PaymentsPurchaseView, PURCHASE);
    accepts(PaymentsPurchaseView, { ...PURCHASE, expiresAt: null, outcome: "ignored" });
    accepts(PaymentsEntitlementView, ENTITLEMENT);
    accepts(PaymentsEntitlementView, { ...ENTITLEMENT, granted: false, expiresAt: null });
  });

  test("no receipt is declared on the purchase view", () => {
    // The stored `payload` is the whole verified provider response and a bearer artifact. A client has
    // no use for its own receipt read back to it, and the schema must not say otherwise.
    expect(Object.keys(PaymentsPurchaseView.shape)).not.toContain("payload");
    expect(Object.keys(PaymentsPurchaseView.shape)).not.toContain("providerTransactionId");
  });

  test("a client's own views name no subject at all", () => {
    // The player-facing half of the subject rule. A client reads its own rows, and who holds them is the
    // answer the server already resolved — under organization billing from the adopter's resolver, never
    // from anything the request said. Echoing the holder back teaches a client that it is a value in the
    // protocol, and the field a response carries is the field a request grows next.
    for (const view of [PaymentsPurchaseView, PaymentsEntitlementView]) {
      const fields = Object.keys(view.shape);
      expect(fields).not.toContain("subjectId");
      expect(fields).not.toContain("subjectType");
      expect(fields).not.toContain("userId");
    }
  });

  test("the envelopes accept what the routes return", () => {
    accepts(PaymentsPurchaseResponse, { purchase: PURCHASE, entitlements: [ENTITLEMENT] });
    accepts(PaymentsEntitlementsResponse, { entitlements: [] });
    accepts(PaymentsRestoreResponse, { purchases: [PURCHASE], entitlements: [ENTITLEMENT] });
    accepts(PaymentsCheckoutHandoffResponse, { kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    accepts(PaymentsCheckoutHandoffResponse, {
      kind: "paddle",
      transactionId: "txn_01hv8wptq8987qeep44cyrewp9",
      clientToken: "test_1234567890abcdef",
      environment: "sandbox",
      displayMode: "overlay",
      successUrl: "https://acme.example/thanks",
    });
    accepts(PaymentsPortalHandoffResponse, { url: "https://sandbox-customer-portal.paddle.com/cpl_01" });
    accepts(PaymentsPortalHandoffResponse, {
      url: "https://sandbox-customer-portal.paddle.com/cpl_01",
      subscriptions: [{ subscriptionId: "sub_01", cancel: "https://…/cancel", updatePaymentMethod: "https://…/pay" }],
    });
    accepts(PaymentsEntitlementResponse, { entitlement: ENTITLEMENT });
    // A revoke returns the state it produced rather than nothing, so the false case is part of the
    // contract and not an afterthought.
    accepts(PaymentsEntitlementResponse, { entitlement: { key: "pro", granted: false, expiresAt: null } });
  });
});

describe("the management read schemas", () => {
  test("the admin views accept exactly what the projections build", () => {
    // Built by the projections rather than typed by hand, so this fails if `view.ts` and `responses.ts`
    // ever describe different objects — which is the drift the schemas exist to make impossible.
    const purchase = adminPurchaseView({
      id: "9c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a01",
      subjectType: "user",
      subjectId: "ada",
      rail: "apple",
      providerTransactionId: "2000000123",
      originalTransactionId: "2000000001",
      productId: "pro_monthly",
      type: "subscription",
      status: "active",
      environment: "production",
      amountMinor: 999,
      currency: "USD",
      purchasedAt: new Date("2026-06-01T00:00:00.000Z"),
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
      revokedAt: null,
      resumesAt: null,
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    accepts(PaymentsAdminPurchaseView, purchase);

    const row: PaymentsEntitlement = {
      id: "8c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a02",
      subjectType: "organization",
      subjectId: "acme",
      entitlement: "pro",
      active: true,
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
      sourcePurchaseId: "9c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a01",
      manual: false,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    accepts(PaymentsAdminEntitlementView, adminEntitlementView(row, new Date("2026-06-10T00:00:00.000Z")));
    // Past its expiry: the flag still says active, and the projection still says it does not grant.
    expect(adminEntitlementView(row, new Date("2026-08-01T00:00:00.000Z")).granted).toBe(false);
  });

  test("a management view carries the subject as the pair the row is keyed on", () => {
    // The other half of the subject rule, and the reason it is a test rather than a convention: an
    // organization id may equal some user's id, so a view carrying `subjectId` alone renders one holder's
    // subscription under the other's name. Both halves are projected off one row, never assembled from
    // config and a column — which is what this asserts by reading the pair back out of the projection.
    const row: PaymentsEntitlement = {
      id: "8c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a02",
      subjectType: "organization",
      subjectId: "shared-id",
      entitlement: "pro",
      active: true,
      expiresAt: null,
      sourcePurchaseId: null,
      manual: true,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    const view = adminEntitlementView(row, new Date("2026-06-10T00:00:00.000Z"));
    expect(view.subjectType).toBe("organization");
    expect(view.subjectId).toBe("shared-id");
    // A user holding the same id is a different holder, and the schema is what keeps the two apart.
    expect(PaymentsAdminEntitlementView.parse({ ...view, subjectType: "user" })).not.toEqual(view);
    // And a half-named holder does not parse at all, in either direction.
    for (const half of ["subjectType", "subjectId"]) {
      const { [half]: _dropped, ...rest } = view as Record<string, unknown>;
      expect(PaymentsAdminEntitlementView.safeParse(rest).success).toBe(false);
    }
  });

  test("no management projection carries the stored provider payload, or the row's surrogate keys", () => {
    // The one column that is a bearer artifact, and on Stripe a document carrying the buyer's email
    // address. It is not selected by the queries either — this is the schema half of that guarantee.
    const fields = Object.keys(PaymentsAdminPurchaseView.shape);
    expect(fields).not.toContain("payload");
    expect(fields).not.toContain("providerProductId");
    // `outcome` describes what a write did. A read of the log has no write to report, and a client that
    // could read one would come to depend on a field with no meaning here.
    expect(fields).not.toContain("outcome");
    // The entitlement row's own uuid is internal: an entitlement is addressed by its subject and its key.
    expect(Object.keys(PaymentsAdminEntitlementView.shape)).not.toContain("id");
  });

  test("the management envelopes accept what the handlers return", () => {
    const purchase: PaymentsAdminPurchaseView = {
      id: "9c1f9b9e-6a2a-4c9d-8f1b-2b7c7d4c1a01",
      subjectType: "user",
      subjectId: "ada",
      rail: "stripe",
      providerTransactionId: "pi_1Abc",
      originalTransactionId: null,
      productId: "coins_100",
      type: "consumable",
      status: "active",
      environment: "production",
      amountMinor: null,
      currency: null,
      purchasedAt: "2026-06-01T00:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      resumesAt: null,
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const entitlement: PaymentsAdminEntitlementView = {
      subjectType: "user",
      subjectId: "ada",
      key: "pro",
      granted: true,
      expiresAt: null,
      manual: true,
      source: null,
    };
    accepts(PaymentsAdminPurchasesResponse, { purchases: [purchase], nextCursor: null });
    accepts(PaymentsAdminPurchasesResponse, { purchases: [], nextCursor: "eyJzb3J0IjoxfQ" });
    accepts(PaymentsAdminSubscriptionsResponse, { subscriptions: [purchase], nextCursor: null });
    accepts(PaymentsAdminEntitlementsResponse, { entitlements: [entitlement], nextCursor: null });
    // No cursor on the per-subject read: `UNIQUE (subjectType, subjectId, entitlement)` bounds it, so there
    // is no page. Both halves are echoed, so what a client renders is the holder it asked about.
    accepts(PaymentsAdminSubjectEntitlementsResponse, {
      subjectType: "user",
      subjectId: "ada",
      entitlements: [entitlement],
    });
    accepts(PaymentsAdminSubjectEntitlementsResponse, {
      subjectType: "organization",
      subjectId: "acme",
      entitlements: [],
    });
    // A response naming only the id does not parse: half an address is a holder nobody asked about.
    expect(PaymentsAdminSubjectEntitlementsResponse.safeParse({ subjectId: "ada", entitlements: [] }).success).toBe(
      false,
    );
  });

  test("the catalog view is what the schema says, in both of its two states", () => {
    // Equality rather than a bare parse, as everywhere in this file: a Zod object strips unknown keys, so
    // parsing alone would pass a projection that had grown one.
    const config = PaymentsConfig.parse({
      billingSubject: "user",
      rails: { apple: true },
      manualEntitlements: ["founder"],
      products: {
        pro_monthly: {
          type: "subscription",
          name: "Pro",
          entitlements: ["pro"],
          apple: { productId: "com.acme.pro.monthly" },
        },
      },
    });
    // The empty catalog still has a `billingSubject`: what a project bills is required config, and a
    // project selling nothing yet has still decided who it would bill. It is not a catalog fact, which is
    // why nothing about it reaches the response.
    const empty = PaymentsConfig.parse({ billingSubject: "organization" });
    accepts(PaymentsAdminCatalogResponse, adminCatalogView(config));
    accepts(PaymentsAdminCatalogResponse, adminCatalogView(empty));
    expect(adminCatalogView(empty)).toEqual({ enabled: false });
  });

  test("a catalog product carries four facts, and none of them is commercial", () => {
    // The field list is locked here; the *invariant* — that no value outside these four can cross — is
    // asserted over a real response in `controlPlane.workers.test.ts`. Both, because this one names the
    // shape a client codes against and that one catches a field nobody thought to ban.
    expect(Object.keys(PaymentsAdminCatalogProduct.shape).sort()).toEqual(["entitlements", "id", "name", "type"]);
  });
});

/**
 * The subscription lifecycle responses, held against the shapes in `data/subscription.ts`.
 *
 * **Built by encoding a real `SubscriptionStanding` and a real `SubscriptionChangeQuote`, never typed by
 * hand.** Those live in `data/` and carry `JsonDate` codecs; this file describes JSON on the wire and
 * declares no codec at all, so the two are separate objects by necessity and would otherwise drift
 * silently — with the drift landing as a date a browser cannot read. `.encode()` is the bridge, and
 * comparing key sets beside it is what catches a field one side grew.
 */
describe("the subscription lifecycle responses", () => {
  const PERIOD_END = "2026-09-15T11:42:21.789Z";

  /** "Team, renews 15 Sep". */
  const RENEWING: SubscriptionStanding = {
    status: "active",
    currency: "usd",
    currentPeriodEndsAt: new Date(PERIOD_END),
    nextBilledAt: new Date(PERIOD_END),
    scheduledChange: null,
  };

  /** "Team until 15 Sep, then ends" — recorded 2026-08-28: the status is still `active`. */
  const ENDING: SubscriptionStanding = {
    ...RENEWING,
    nextBilledAt: null,
    scheduledChange: { action: "cancel", effectiveAt: new Date(PERIOD_END), resumesAt: null },
  };

  /** "$65.82 today, then $119.76 monthly from 15 Sep" — the recorded upgrade. */
  const UPGRADE: SubscriptionChangeQuote = {
    settlesToday: { outcome: "charge", amount: { amountMinor: 6582, currency: "usd", rendered: "$65.82" } },
    nextInvoice: null,
    recurring: { amount: { amountMinor: 11976, currency: "usd", rendered: "$119.76" }, startsAt: new Date(PERIOD_END) },
  };

  /** "Nothing today. $65.58 credit on your next invoice, 15 Sep. Then $6.53/month." */
  const DEFERRED_DOWNGRADE: SubscriptionChangeQuote = {
    settlesToday: { outcome: "nothing" },
    nextInvoice: {
      settlement: { outcome: "credit", amount: { amountMinor: 6558, currency: "usd", rendered: "$65.58" } },
      at: new Date(PERIOD_END),
    },
    recurring: { amount: { amountMinor: 653, currency: "usd", rendered: "$6.53" }, startsAt: new Date(PERIOD_END) },
  };

  /** What a route sends: the encoded standing, the product it is for, and the reading of what comes next. */
  function subscription(standing: SubscriptionStanding, productId: string): unknown {
    const next = nextSubscriptionEvent(standing);
    return {
      ...SubscriptionStanding.encode(standing),
      productId,
      nextEvent: { kind: next.kind, at: next.at === null ? null : next.at.toISOString() },
    };
  }

  test("the view is the standing, plus exactly the two facts the wire adds", () => {
    // A field added to `SubscriptionStanding` fails here until somebody decides whether a customer reading
    // their own subscription should see it. That decision is the point; silence is not.
    expect(Object.keys(PaymentsSubscriptionView.shape).sort()).toEqual(
      [...Object.keys(SubscriptionStanding.shape), "productId", "nextEvent"].sort(),
    );
  });

  test("the view accepts an encoded standing, renewing and ending alike", () => {
    accepts(PaymentsSubscriptionView, subscription(RENEWING, "team_monthly"));
    accepts(PaymentsSubscriptionView, subscription(ENDING, "team_monthly"));
  });

  test("the two standings differ only in the fields that say so", () => {
    const renewing = PaymentsSubscriptionView.parse(subscription(RENEWING, "team_monthly"));
    const ending = PaymentsSubscriptionView.parse(subscription(ENDING, "team_monthly"));
    // Read the status alone and a customer who canceled is told they will be billed again. Both say
    // `active`; this is the assertion that the response does not leave a screen with only that.
    expect(renewing.status).toBe("active");
    expect(ending.status).toBe("active");
    expect(renewing.nextEvent).toEqual({ kind: "renews", at: PERIOD_END });
    expect(ending.nextEvent).toEqual({ kind: "ends", at: PERIOD_END });
    // And the date the ending one is owed exists nowhere else: `nextBilledAt` is blank on it.
    expect(ending.nextBilledAt).toBeNull();
  });

  test("the four sentences are writable from parsed responses, every figure read rather than derived", () => {
    const renewing = PaymentsSubscriptionView.parse(subscription(RENEWING, "team_monthly"));
    const ending = PaymentsSubscriptionView.parse(subscription(ENDING, "team_monthly"));
    // "Team, renews 15 Sep" / "Team until 15 Sep, then ends"
    expect([renewing.productId, renewing.nextEvent.kind, renewing.nextEvent.at]).toEqual([
      "team_monthly",
      "renews",
      PERIOD_END,
    ]);
    expect([ending.productId, ending.nextEvent.kind, ending.nextEvent.at]).toEqual([
      "team_monthly",
      "ends",
      PERIOD_END,
    ]);

    // "$65.82 today, then $119.76 monthly from 15 Sep"
    const upgrade = PaymentsSubscriptionQuote.parse(SubscriptionChangeQuote.encode(UPGRADE));
    expect(upgrade.settlesToday).toEqual({
      outcome: "charge",
      amount: { amountMinor: 6582, currency: "usd", rendered: "$65.82" },
    });
    expect(upgrade.nextInvoice).toBeNull();
    expect(upgrade.recurring).toEqual({
      amount: { amountMinor: 11976, currency: "usd", rendered: "$119.76" },
      startsAt: PERIOD_END,
    });

    // "Nothing today. $65.58 credit on your next invoice, 15 Sep. Then $6.53/month."
    const downgrade = PaymentsSubscriptionQuote.parse(SubscriptionChangeQuote.encode(DEFERRED_DOWNGRADE));
    expect(downgrade.settlesToday).toEqual({ outcome: "nothing" });
    expect(downgrade.nextInvoice).toEqual({
      settlement: { outcome: "credit", amount: { amountMinor: 6558, currency: "usd", rendered: "$65.58" } },
      at: PERIOD_END,
    });
    expect(downgrade.recurring).toEqual({
      amount: { amountMinor: 653, currency: "usd", rendered: "$6.53" },
      startsAt: PERIOD_END,
    });
  });

  test("a next event is never a date without an event, or an event without a date", () => {
    accepts(PaymentsSubscriptionNextEvent, { kind: "renews", at: PERIOD_END });
    accepts(PaymentsSubscriptionNextEvent, { kind: "unknown", at: null });
    // `unknown` is the answer for a subscription with nothing scheduled and nothing due. A date on it is
    // a day a screen would print, and nobody said anything happens then.
    expect(PaymentsSubscriptionNextEvent.safeParse({ kind: "unknown", at: PERIOD_END }).success).toBe(false);
    expect(PaymentsSubscriptionNextEvent.safeParse({ kind: "ends", at: null }).success).toBe(false);
  });

  test("the read may find no subscription; a write always acted on one", () => {
    const view = subscription(RENEWING, "team_monthly");
    accepts(PaymentsSubscriptionResponse, { subscription: null });
    accepts(PaymentsSubscriptionResponse, { subscription: view });
    accepts(PaymentsSubscriptionStandingResponse, { subscription: view });
    // A change, a cancellation and a withdrawal each resolved a subscription before they ran, so null
    // there is a case every screen would have to branch on and none could ever reach.
    expect(PaymentsSubscriptionStandingResponse.safeParse({ subscription: null }).success).toBe(false);
    accepts(PaymentsSubscriptionQuoteResponse, { quote: SubscriptionChangeQuote.encode(UPGRADE) });
  });

  test("no store identifier and no subject crosses to the customer", () => {
    // `sub_…`, `ctm_…` and `txn_…` are the store's vocabulary and a browser has no use for any of them;
    // the subject rule is the same one every client-facing view in this file is held to.
    const fields = Object.keys(PaymentsSubscriptionView.shape);
    for (const banned of [
      "subscriptionId",
      "providerSubscriptionId",
      "providerTransactionId",
      "customerId",
      "providerAccountId",
      "priceId",
      "providerProductId",
      "subjectId",
      "subjectType",
      "userId",
      "payload",
    ]) {
      expect(fields).not.toContain(banned);
    }
  });

  test("dates cross as ISO strings, never as a Date or an epoch", () => {
    const view = subscription(RENEWING, "team_monthly") as Record<string, unknown>;
    expect(PaymentsSubscriptionView.safeParse({ ...view, nextBilledAt: new Date(PERIOD_END) }).success).toBe(false);
    expect(PaymentsSubscriptionView.safeParse({ ...view, nextBilledAt: 1789000000000 }).success).toBe(false);
  });

  test("the quote is the three parts the data module models, and no fourth", () => {
    expect(Object.keys(PaymentsSubscriptionQuote.shape).sort()).toEqual(
      Object.keys(SubscriptionChangeQuote.shape).sort(),
    );
    expect(Object.keys(PaymentsSubscriptionScheduledChange.shape).sort()).toEqual(
      Object.keys(ScheduledSubscriptionChange.shape).sort(),
    );
    expect(Object.keys(PaymentsQuotedMoney.shape).sort()).toEqual(Object.keys(QuotedMoney.shape).sort());
  });

  test("an amount cannot be rendered without its direction", () => {
    accepts(PaymentsSubscriptionSettlement, {
      outcome: "charge",
      amount: { amountMinor: 6582, currency: "usd", rendered: "$65.82" },
    });
    accepts(PaymentsSubscriptionSettlement, { outcome: "nothing" });
    // `nothing` carries no amount, and one smuggled in does not survive the parse — "nothing to pay
    // today" and "a charge of zero" are different sentences and only one of them is ever true.
    expect(
      PaymentsSubscriptionSettlement.parse({ outcome: "nothing", amount: { amountMinor: 1, currency: "usd" } }),
    ).toEqual({ outcome: "nothing" });
    expect(PaymentsSubscriptionSettlement.safeParse({ outcome: "charge" }).success).toBe(false);
  });

  test("a deferred settlement is never `nothing`", () => {
    // The block holding it is nullable, and null already says nothing lands later. Two spellings of one
    // fact is how a screen renders "$— credit on 15 Sep" — a row about no money, dated.
    expect(PaymentsDeferredSubscriptionSettlement.safeParse({ outcome: "nothing" }).success).toBe(false);
    expect(
      PaymentsSubscriptionQuote.safeParse({
        ...SubscriptionChangeQuote.encode(DEFERRED_DOWNGRADE),
        nextInvoice: { settlement: { outcome: "nothing" }, at: PERIOD_END },
      }).success,
    ).toBe(false);
  });

  test("money is a signed integer of minor units", () => {
    // Signed, because Paddle's own credit amounts are — `.nonnegative()` here refuses every real
    // downgrade. Never a float: 6582 is $65.82, and 65.82 is somebody reading the rendered figure back in.
    accepts(PaymentsQuotedMoney, { amountMinor: -6961, currency: "usd", rendered: "-$69.61" });
    expect(PaymentsQuotedMoney.safeParse({ amountMinor: 65.82, currency: "usd", rendered: "$65.82" }).success).toBe(
      false,
    );
    expect(PaymentsQuotedMoney.safeParse({ amountMinor: "6582", currency: "usd", rendered: "$65.82" }).success).toBe(
      false,
    );
  });

  test("money crosses rendered as well as counted, and a blank rendering is not a rendering", () => {
    // #465: minor units alone cross as bare digits, and a client cannot scale them without carrying the
    // currency exponents this Worker already has. Both fields, always — one to show, one to compare.
    const money = PaymentsQuotedMoney.parse({ amountMinor: 6582, currency: "usd", rendered: "$65.82" });
    expect(money).toEqual({ amountMinor: 6582, currency: "usd", rendered: "$65.82" });
    expect(PaymentsQuotedMoney.safeParse({ amountMinor: 6582, currency: "usd" }).success).toBe(false);
    expect(PaymentsQuotedMoney.safeParse({ amountMinor: 6582, currency: "usd", rendered: "" }).success).toBe(false);
  });

  test("a currency the wire did not expect does not take the pane down", () => {
    // `data/subscription.ts` refuses anything but lowercase, and that is where a rail that stopped
    // lowering fails. Re-refusing it here would mean a customer's whole subscription pane failing to
    // parse over a casing difference, which is #450's rule read the wrong way round.
    accepts(PaymentsQuotedMoney, { amountMinor: 6582, currency: "USD", rendered: "$65.82" });
  });
});

/**
 * The refund report on the wire — the response whose whole job is to not say something that is not true.
 *
 * A refund is a request. Paddle holds most live ones awaiting a person, so this shape has to be
 * unrenderable as a payout: no amount, no store status spelled in the store's own words, and a
 * discriminant a screen cannot reach the state through without reading.
 */
describe("the refund report", () => {
  test("carries no amount and no identifier — nothing a request could grow a field from", () => {
    // Both halves of the module rule, together: a store identifier never crosses a bearer response, and
    // an amount here would be read as what the customer is getting back, which nobody has decided yet.
    const report = PaymentsRefundRequest.parse({
      outcomes: [
        { outcome: "requested", status: "awaiting_review" },
        { outcome: "already_requested", status: "approved" },
        { outcome: "failed" },
      ],
    });
    const wire = JSON.stringify(report);
    for (const banned of ["amountMinor", "adjustmentId", "purchaseId", "transactionId", "reason", "currency"]) {
      expect(wire, `the wire carries ${banned}`).not.toContain(banned);
    }
  });

  test("strips a store id, an amount and a reason smuggled into an outcome", () => {
    // Not a rule read off its own subject: the fields are offered and the parse is what refuses them.
    const parsed = PaymentsRefundOutcome.parse({
      outcome: "requested",
      status: "approved",
      adjustmentId: "adj_01m02kntv7bhw3sxdy5kyj93a1",
      amountMinor: 6582,
    });
    expect(Object.keys(parsed).sort()).toEqual(["outcome", "status"]);

    const failed = PaymentsRefundOutcome.parse({ outcome: "failed", reason: "Paddle said no, on txn_01…" });
    expect(Object.keys(failed)).toEqual(["outcome"]);
  });

  test("no wire value says the customer has been paid", () => {
    for (const value of PaymentsRefundRequestStatus.options) {
      expect(value, `${value} reads as money having arrived`).not.toMatch(/refunded|paid|complete|settled/);
    }
    // And the store's own spelling does not pass through as itself: the rail translates or it fails.
    expect(PaymentsRefundRequestStatus.safeParse("pending_approval").success).toBe(false);
  });

  test("a report holds a mixed set, because that is what a partial looks like", () => {
    // One raised, one already standing, one refused. A shape that could only hold a uniform answer would
    // force the route to pick one of the three to report and drop the rest.
    const report = PaymentsRefundResponse.parse({
      refund: {
        outcomes: [
          { outcome: "requested", status: "awaiting_review" },
          { outcome: "already_requested", status: "approved" },
          { outcome: "failed" },
        ],
      },
    });
    expect(report.refund.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "requested",
      "already_requested",
      "failed",
    ]);
  });

  test("a state the rail cannot produce does not parse", () => {
    // The enum comes from `data/subscription.ts` rather than being respelled here, so the wire cannot
    // hold a status no rail can answer with.
    expect(PaymentsRefundOutcome.safeParse({ outcome: "requested", status: "refunded" }).success).toBe(false);
    expect(PaymentsRefundOutcome.safeParse({ outcome: "cancelled" }).success).toBe(false);
  });
});
