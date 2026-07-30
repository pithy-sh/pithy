import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import { PaymentsPurchase, type PaymentsPurchaseRow } from "../data/purchase";
import { grantEntitlement } from "../entitlement/manual";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import type { ProviderEventInput } from "./event";
import { projectPurchase, upsertPurchaseStatement } from "./writer";

/**
 * The projection writer, against real D1 through Miniflare. These are the tests the stage exists for.
 *
 * "One writer, three triggers" is the claim the whole capability rests on, and it is a claim about what a
 * database does under repetition, reordering, and concurrency — so it cannot be proved against a mock. Each
 * test's name states the property it proves, because a failure here is a revenue defect, not a style one.
 */

const SECOND = 1000;
const DAY = 86_400 * SECOND;
const T0 = 1_700_000_000_000;

const CONFIG = PaymentsConfig.parse({
  rails: { apple: true, google: true, stripe: true },
  stripe: {
    successUrl: "https://acme.example/thanks",
    cancelUrl: "https://acme.example/pricing",
    portalReturnUrl: "https://acme.example/account",
  },
  products: {
    // Two products, one entitlement — the load-bearing distinction, and what makes the read model a
    // derivation rather than a copy.
    pro_monthly: {
      type: "subscription",
      name: "Pro monthly",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.monthly" },
      stripe: { priceId: "price_pro_monthly" },
    },
    pro_annual: {
      type: "subscription",
      name: "Pro annual",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.annual" },
    },
    remove_ads: {
      type: "non_consumable",
      name: "Remove ads",
      entitlements: ["ads_removed"],
      apple: { productId: "com.acme.removeads" },
    },
    coins_100: {
      type: "consumable",
      name: "100 coins",
      grants: { ledger: { currency: "coins", amount: 100 } },
      apple: { productId: "com.acme.coins100" },
    },
  },
});

/** Grace off, so the `in_grace` branch of the derivation can be exercised against the same tables. */
const NO_GRACE = PaymentsConfig.parse({ ...CONFIG, graceGrantsAccess: false });

/**
 * A catalog where `count` products all grant `pro` — grandfathered prices, promos, regional SKUs. Wide
 * catalogs are what the derivation's SQL has to survive: every granting product is a candidate.
 */
function wideCatalog(count: number): PaymentsConfig {
  const products: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    products[`pro_${i}`] = {
      type: "subscription",
      name: `Pro ${i}`,
      entitlements: ["pro"],
      apple: { productId: `com.acme.pro.${i}` },
    };
  }
  return PaymentsConfig.parse({ rails: { apple: true }, products });
}

function event(overrides: Partial<ProviderEventInput> = {}): ProviderEventInput {
  return {
    rail: "apple",
    providerTransactionId: "txn-1",
    providerProductId: "com.acme.pro.monthly",
    userId: "ada",
    status: "active",
    environment: "production",
    purchasedAt: new Date(T0),
    expiresAt: new Date(T0 + 30 * DAY),
    providerEventAt: new Date(T0),
    payload: { transactionId: "txn-1" },
    ...overrides,
  };
}

const project = (
  input: ProviderEventInput,
  options: { config?: PaymentsConfig; environment?: "production" | "sandbox"; now?: Date } = {},
) =>
  projectPurchase(env.DB, input, {
    config: options.config ?? CONFIG,
    environment: options.environment ?? "production",
    now: options.now ?? new Date(T0 + SECOND),
  });

async function purchaseRows(): Promise<{ user_id: string; status: string; provider_event_at: number }[]> {
  const { results } = await env.DB.prepare(
    "SELECT user_id, status, provider_event_at FROM pithy_payments_purchases ORDER BY provider_transaction_id",
  ).all<{ user_id: string; status: string; provider_event_at: number }>();
  return results;
}

async function entitlementRows(): Promise<{ user_id: string; entitlement: string; active: number }[]> {
  const { results } = await env.DB.prepare(
    "SELECT user_id, entitlement, active FROM pithy_payments_entitlements ORDER BY user_id, entitlement",
  ).all<{ user_id: string; entitlement: string; active: number }>();
  return results;
}

beforeEach(async () => {
  for (const table of [
    "pithy_payments_purchases",
    "pithy_payments_entitlements",
    "pithy_payments_provider_accounts",
    "pithy_payments_webhook_events",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await payments_0001_purchases.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

describe("projectPurchase — the first write", () => {
  test("projects one purchase row and derives the entitlement it grants, in one call", async () => {
    const result = await project(event());

    expect(result.outcome).toBe("created");
    expect(result.purchase.productId).toBe("pro_monthly");
    expect(result.purchase.type).toBe("subscription");
    expect(result.purchase.status).toBe("active");
    expect(await purchaseRows()).toHaveLength(1);
    expect(result.entitlements.map((e) => [e.entitlement, e.active, e.sourcePurchaseId])).toEqual([
      ["pro", true, result.purchase.id],
    ]);
  });

  test("copies the product type from the catalog, so a later config edit cannot rewrite history", async () => {
    const result = await project(event({ providerProductId: "com.acme.coins100" }));
    expect(result.purchase.type).toBe("consumable");
    expect(result.purchase.productId).toBe("coins_100");
  });

  test("a consumable that only credits a balance writes no entitlement row", async () => {
    const result = await project(event({ providerProductId: "com.acme.coins100" }));
    expect(result.entitlements).toEqual([]);
    expect(await entitlementRows()).toEqual([]);
  });

  test("a SKU no catalog product maps is refused — the catalog is config, so it is a 404", async () => {
    await expect(project(event({ providerProductId: "com.acme.unknown" }))).rejects.toThrow(/not for sale/i);
    expect(await purchaseRows()).toEqual([]);
  });

  test("a SKU belonging to another rail is refused — the lookup is scoped to the rail", async () => {
    // `price_pro_monthly` is Stripe's id for the same product. Arriving on the Apple rail it means nothing.
    await expect(project(event({ rail: "apple", providerProductId: "price_pro_monthly" }))).rejects.toThrow(
      /not for sale/i,
    );
  });
});

describe("projectPurchase — idempotency", () => {
  test("the same event applied five times leaves exactly one purchase row and one entitlement row", async () => {
    const first = await project(event());
    for (let i = 0; i < 4; i++) await project(event());

    expect(await purchaseRows()).toHaveLength(1);
    expect(await entitlementRows()).toEqual([{ user_id: "ada", entitlement: "pro", active: 1 }]);
    // The row's identity survives every replay: the id is minted once and never re-minted.
    const repeated = await project(event());
    expect(repeated.purchase.id).toBe(first.purchase.id);
  });

  test("a replay by the owner is a no-op that returns the existing purchase — a 200, not an error", async () => {
    const first = await project(event());
    const replay = await project(event());

    expect(replay.outcome).toBe("ignored");
    expect(replay.purchase).toEqual(first.purchase);
    expect(replay.entitlements.map((e) => e.entitlement)).toEqual(["pro"]);
  });

  test("a client submission, its webhook, and a reconciliation pass converge on one row in any order", async () => {
    // Three triggers, three arrival orders, one terminal state. The client submission is the purchase as the
    // device saw it; the webhook is the same transaction a moment later; reconciliation re-verifies it.
    const submission = event({ providerEventAt: new Date(T0) });
    const webhook = event({ providerEventAt: new Date(T0 + SECOND), payload: { source: "webhook" } });
    const reconcile = event({ providerEventAt: new Date(T0 + 2 * SECOND), payload: { source: "reconcile" } });

    for (const order of [
      [submission, webhook, reconcile],
      [reconcile, webhook, submission],
      [webhook, reconcile, submission],
    ]) {
      await env.DB.exec("DELETE FROM pithy_payments_purchases");
      await env.DB.exec("DELETE FROM pithy_payments_entitlements");
      for (const one of order) await project(one);

      const rows = await purchaseRows();
      expect(rows).toHaveLength(1);
      // Whatever the order, the newest provider event is the one that stands.
      expect(rows[0]?.provider_event_at).toBe(T0 + 2 * SECOND);
      expect(await entitlementRows()).toEqual([{ user_id: "ada", entitlement: "pro", active: 1 }]);
    }
  });
});

describe("projectPurchase — monotonic on the provider's event time", () => {
  test("a stale expired arriving after renewed does not revoke a paying subscriber", async () => {
    // The defect this rule exists to prevent. Providers do not guarantee delivery order, so an `expired`
    // notification can arrive after the `renewed` that superseded it — and last-write-wins would cancel a
    // subscription the user is still paying for.
    const renewed = event({
      status: "active",
      providerEventAt: new Date(T0 + 10 * SECOND),
      expiresAt: new Date(T0 + 60 * DAY),
    });
    const staleExpired = event({
      status: "expired",
      providerEventAt: new Date(T0 + 5 * SECOND),
      expiresAt: new Date(T0 + 30 * DAY),
    });

    await project(renewed);
    const result = await project(staleExpired);

    expect(result.outcome).toBe("ignored");
    expect(result.purchase.status).toBe("active");
    expect(result.purchase.expiresAt).toEqual(new Date(T0 + 60 * DAY));
    expect(await entitlementRows()).toEqual([{ user_id: "ada", entitlement: "pro", active: 1 }]);
  });

  test("an event with the same provider timestamp is stale too — the comparison is strictly newer", async () => {
    await project(event({ status: "active", providerEventAt: new Date(T0 + 10 * SECOND) }));
    const tie = await project(event({ status: "revoked", providerEventAt: new Date(T0 + 10 * SECOND) }));
    expect(tie.outcome).toBe("ignored");
    expect(tie.purchase.status).toBe("active");
  });

  test("concurrent stale and fresh events for one transaction leave the fresh one standing", async () => {
    // Both callers read the same row, so both believe they are the newer write, and whichever finishes second
    // the fresh one stands. What decides it under a genuine interleaving is the `ON CONFLICT` predicate, and
    // that is pinned separately — see `upsertPurchaseStatement`'s own tests below, which compile the statement
    // and move the row underneath it. This test states the outcome; it does not locate the guard.
    await project(event({ status: "active", providerEventAt: new Date(T0) }));
    await Promise.allSettled([
      project(event({ status: "expired", providerEventAt: new Date(T0 + SECOND) })),
      project(
        event({ status: "active", providerEventAt: new Date(T0 + 10 * SECOND), expiresAt: new Date(T0 + 60 * DAY) }),
      ),
    ]);

    const rows = await purchaseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider_event_at).toBe(T0 + 10 * SECOND);
    expect(rows[0]?.status).toBe("active");
  });

  test("a newer event is applied, and only the mutable half of the row moves", async () => {
    const created = await project(event({ providerEventAt: new Date(T0) }));
    const updated = await project(
      event({ status: "canceled", providerEventAt: new Date(T0 + SECOND), payload: { source: "webhook" } }),
    );

    expect(updated.outcome).toBe("updated");
    expect(updated.purchase.status).toBe("canceled");
    expect(updated.purchase.payload).toEqual({ source: "webhook" });
    // Identity and first-projection time are immutable; only `updatedAt` moves.
    expect(updated.purchase.id).toBe(created.purchase.id);
    expect(updated.purchase.createdAt).toEqual(created.purchase.createdAt);
  });
});

describe("projectPurchase — sandbox isolation", () => {
  test("a sandbox transaction reaching production is refused, so it can never grant a real entitlement", async () => {
    // The most common in-app-purchase security defect. Refused outright rather than recorded-and-ignored:
    // there is no state in which a sandbox transaction should exist in a production database.
    await expect(project(event({ environment: "sandbox" }), { environment: "production" })).rejects.toThrow(
      /different store environment/i,
    );
    expect(await purchaseRows()).toEqual([]);
    expect(await entitlementRows()).toEqual([]);
  });

  test("a production transaction reaching a sandbox deployment is refused too — the check is symmetric", async () => {
    await expect(project(event({ environment: "production" }), { environment: "sandbox" })).rejects.toThrow(
      /different store environment/i,
    );
    expect(await purchaseRows()).toEqual([]);
  });

  test("a sandbox transaction in a sandbox deployment projects normally, and stays marked sandbox", async () => {
    const result = await project(event({ environment: "sandbox" }), { environment: "sandbox" });
    expect(result.purchase.environment).toBe("sandbox");
    expect(result.entitlements.map((e) => e.active)).toEqual([true]);
  });
});

describe("projectPurchase — cross-user receipt replay", () => {
  test("user B submitting user A's transaction is refused, and A keeps the purchase", async () => {
    // `UNIQUE (rail, providerTransactionId)` plus this owner check is what makes a stolen receipt worthless:
    // it cannot be rebound, and it cannot be projected twice.
    const owned = await project(event({ userId: "ada" }));
    await expect(project(event({ userId: "grace" }))).rejects.toThrow(/belongs to another account/i);

    const rows = await purchaseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe("ada");
    expect(await entitlementRows()).toEqual([{ user_id: "ada", entitlement: "pro", active: 1 }]);
    expect(owned.purchase.userId).toBe("ada");
  });

  test("the refusal is a 409, so a client can tell it apart from a malformed receipt", async () => {
    await project(event({ userId: "ada" }));
    await expect(project(event({ userId: "grace" }))).rejects.toMatchObject({
      payload: { code: "payments/receipt_already_owned", status: 409 },
    });
  });

  test("two concurrent submissions of one transaction by different users leave one row, one owner", async () => {
    // Both callers read "no such transaction", then both write: one row, one owner, and the loser is told the
    // transaction is not theirs. Which check refuses it depends on how D1 serializes the two batches, so the
    // `ON CONFLICT` owner guard is pinned on its own below rather than inferred from this outcome.
    const settled = await Promise.allSettled([project(event({ userId: "ada" })), project(event({ userId: "grace" }))]);

    const rows = await purchaseRows();
    expect(rows).toHaveLength(1);
    const owner = rows[0]?.user_id;
    expect(owner === "ada" || owner === "grace").toBe(true);
    // Exactly one caller was told it succeeded, and the other was told the transaction is not theirs.
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = settled.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" && rejection.reason).toMatchObject({
      payload: { code: "payments/receipt_already_owned" },
    });
    // And the loser's entitlement was never granted.
    expect((await entitlementRows()).filter((row) => row.active === 1).map((row) => row.user_id)).toEqual([owner]);
  });

  test("two users buying the same product on separate transactions each get their own entitlement", async () => {
    await project(event({ userId: "ada", providerTransactionId: "txn-ada" }));
    await project(event({ userId: "grace", providerTransactionId: "txn-grace" }));
    expect(await entitlementRows()).toEqual([
      { user_id: "ada", entitlement: "pro", active: 1 },
      { user_id: "grace", entitlement: "pro", active: 1 },
    ]);
  });
});

describe("projectPurchase — the derived read model", () => {
  test("two products granting one entitlement resolve to one row, and the furthest expiry wins provenance", async () => {
    // `pro_monthly` and `pro_annual` are two products in the catalog and one key in the read model. The row
    // carries whichever purchase currently grants it, which is the one that expires last.
    const monthly = await project(
      event({
        providerTransactionId: "txn-m",
        providerProductId: "com.acme.pro.monthly",
        expiresAt: new Date(T0 + 30 * DAY),
      }),
    );
    const annual = await project(
      event({
        providerTransactionId: "txn-a",
        providerProductId: "com.acme.pro.annual",
        expiresAt: new Date(T0 + 365 * DAY),
      }),
    );

    expect(await entitlementRows()).toEqual([{ user_id: "ada", entitlement: "pro", active: 1 }]);
    expect(annual.entitlements[0]?.sourcePurchaseId).toBe(annual.purchase.id);
    expect(annual.entitlements[0]?.expiresAt).toEqual(new Date(T0 + 365 * DAY));
    expect(monthly.purchase.id).not.toBe(annual.purchase.id);
  });

  test("a purchase that never expires wins provenance over any dated one", async () => {
    await project(event({ providerTransactionId: "txn-m", expiresAt: new Date(T0 + 30 * DAY) }));
    const forever = await project(
      event({ providerTransactionId: "txn-f", providerProductId: "com.acme.pro.annual", expiresAt: null }),
    );
    expect(forever.entitlements[0]?.expiresAt).toBe(null);
    expect(forever.entitlements[0]?.sourcePurchaseId).toBe(forever.purchase.id);
  });

  test("canceled still grants — the paid period runs to its end", async () => {
    const canceled = await project(event({ status: "canceled", expiresAt: new Date(T0 + 30 * DAY) }));
    expect(canceled.entitlements.map((e) => e.active)).toEqual([true]);
  });

  test("expiring the subscription clears the entitlement rather than deleting the row", async () => {
    await project(event({ providerEventAt: new Date(T0) }));
    const expired = await project(
      event({ status: "expired", providerEventAt: new Date(T0 + SECOND), expiresAt: new Date(T0 + 30 * DAY) }),
    );

    // The row survives so provenance and history survive; `active` is what changes.
    expect(await entitlementRows()).toEqual([{ user_id: "ada", entitlement: "pro", active: 0 }]);
    expect(expired.entitlements[0]?.sourcePurchaseId).toBe(null);
    expect(expired.entitlements[0]?.expiresAt).toBe(null);
  });

  test("a refund revokes the entitlement in the same write that records the refund", async () => {
    await project(event({ providerEventAt: new Date(T0) }));
    const refunded = await project(
      event({
        status: "refunded",
        revokedAt: new Date(T0 + SECOND),
        providerEventAt: new Date(T0 + SECOND),
      }),
    );

    expect(refunded.purchase.revokedAt).toEqual(new Date(T0 + SECOND));
    expect(refunded.entitlements.map((e) => e.active)).toEqual([false]);
  });

  test("one lapsed purchase does not revoke an entitlement another purchase still grants", async () => {
    await project(event({ providerTransactionId: "txn-m", expiresAt: new Date(T0 + 30 * DAY) }));
    await project(
      event({
        providerTransactionId: "txn-a",
        providerProductId: "com.acme.pro.annual",
        expiresAt: new Date(T0 + 365 * DAY),
      }),
    );
    // The monthly one expires. The annual one is still live, so `pro` is still held.
    const result = await project(
      event({
        providerTransactionId: "txn-m",
        status: "expired",
        providerEventAt: new Date(T0 + SECOND),
        expiresAt: new Date(T0 + 30 * DAY),
      }),
    );
    expect(result.entitlements.map((e) => e.active)).toEqual([true]);
  });

  test("a purchase whose expiresAt has already passed does not grant, whatever its status says", async () => {
    // A subscription can lapse with no notification arriving. Write time applies the timestamp as well as
    // the flag, so a projection running after the period ended does not resurrect access.
    const result = await project(event({ status: "active", expiresAt: new Date(T0 - DAY) }), {
      now: new Date(T0 + SECOND),
    });
    expect(result.entitlements.map((e) => e.active)).toEqual([false]);
  });

  test("in_grace grants under the default policy and does not when the project turns grace off", async () => {
    const granted = await project(event({ status: "in_grace" }));
    expect(granted.entitlements.map((e) => e.active)).toEqual([true]);

    const withheld = await project(event({ status: "in_grace", providerEventAt: new Date(T0 + SECOND) }), {
      config: NO_GRACE,
    });
    expect(withheld.entitlements.map((e) => e.active)).toEqual([false]);
  });

  test("on_hold never grants, because by then the retry window is exhausted", async () => {
    const result = await project(event({ status: "on_hold" }));
    expect(result.entitlements.map((e) => e.active)).toEqual([false]);
  });

  test("only the entitlements this purchase touches are re-derived — another key is left alone", async () => {
    await project(
      event({ providerTransactionId: "txn-ads", providerProductId: "com.acme.removeads", expiresAt: null }),
    );
    const pro = await project(event({ providerTransactionId: "txn-pro" }));

    // The `pro` write reports only `pro`; `ads_removed` is untouched and still stands.
    expect(pro.entitlements.map((e) => e.entitlement)).toEqual(["pro"]);
    expect(await entitlementRows()).toEqual([
      { user_id: "ada", entitlement: "ads_removed", active: 1 },
      { user_id: "ada", entitlement: "pro", active: 1 },
    ]);
  });

  test("a catalog where fifty products grant one key still records the purchase", async () => {
    // The derivation names every granting product in its SQL, so a wide catalog is what pushes a statement
    // over D1's bound-parameter cap — and the failure is total: the batch throws, so no purchase touching
    // that key can be written at all. Fifty products granting `pro` is an ordinary shape once a project has
    // grandfathered a few prices and shipped a few regional SKUs.
    const wide = wideCatalog(50);
    const result = await project(event({ providerProductId: "com.acme.pro.7" }), { config: wide });

    expect(result.outcome).toBe("created");
    expect(result.purchase.productId).toBe("pro_7");
    expect(result.entitlements.map((e) => [e.entitlement, e.active, e.sourcePurchaseId])).toEqual([
      ["pro", true, result.purchase.id],
    ]);
  });

  test("the derivation still picks the furthest expiry across a catalog far past D1's parameter cap", async () => {
    // Not just "it runs" — the winner is still the purchase whose access runs longest, with two hundred
    // products in the candidate set. A fix that chunked the list and lost the ordering would pass the test
    // above and fail this one.
    const wide = wideCatalog(200);
    await project(event({ providerTransactionId: "txn-short", providerProductId: "com.acme.pro.1" }), {
      config: wide,
    });
    const long = await project(
      event({
        providerTransactionId: "txn-long",
        providerProductId: "com.acme.pro.199",
        expiresAt: new Date(T0 + 365 * DAY),
      }),
      { config: wide },
    );

    expect(long.entitlements[0]?.sourcePurchaseId).toBe(long.purchase.id);
    expect(long.entitlements[0]?.expiresAt).toEqual(new Date(T0 + 365 * DAY));
  });

  test("the read model and the purchases agree after an interleaved battery of every kind of event", async () => {
    // The whole point of deriving inside the purchase write's own transaction: no sequence of events can
    // leave an entitlement the purchases do not support, or withhold one they do.
    const sequence: ProviderEventInput[] = [
      event({ providerTransactionId: "txn-m", providerEventAt: new Date(T0) }),
      event({ providerTransactionId: "txn-ads", providerProductId: "com.acme.removeads", expiresAt: null }),
      event({ providerTransactionId: "txn-m", status: "in_grace", providerEventAt: new Date(T0 + SECOND) }),
      event({ providerTransactionId: "txn-m", status: "expired", providerEventAt: new Date(T0 - SECOND) }),
      event({ providerTransactionId: "txn-m", status: "active", providerEventAt: new Date(T0 + 2 * SECOND) }),
      event({ providerTransactionId: "txn-coins", providerProductId: "com.acme.coins100", expiresAt: null }),
      event({ providerTransactionId: "txn-m", status: "canceled", providerEventAt: new Date(T0 + 3 * SECOND) }),
    ];
    for (const one of sequence) await project(one);

    expect(await purchaseRows()).toHaveLength(3);
    expect(await entitlementRows()).toEqual([
      { user_id: "ada", entitlement: "ads_removed", active: 1 },
      { user_id: "ada", entitlement: "pro", active: 1 },
    ]);
    const { results } = await env.DB.prepare(
      "SELECT status FROM pithy_payments_purchases WHERE provider_transaction_id = 'txn-m'",
    ).all<{ status: string }>();
    expect(results[0]?.status).toBe("canceled");
  });
});

describe("projectPurchase — a catalog edit that stops granting a key", () => {
  /** One product, granting whatever the edit says it grants. The catalog is config, so this is a deploy. */
  const adsCatalog = (entitlements: string[]) =>
    PaymentsConfig.parse({
      rails: { apple: true },
      products: {
        remove_ads: {
          type: "non_consumable",
          name: "Remove ads",
          entitlements,
          apple: { productId: "com.acme.removeads" },
        },
      },
    });

  const ads = (overrides: Partial<ProviderEventInput> = {}) =>
    event({
      providerTransactionId: "txn-ads",
      providerProductId: "com.acme.removeads",
      expiresAt: null,
      ...overrides,
    });

  test("a key the edited catalog no longer grants is cleared by the next projection for that user", async () => {
    // Nothing else ever repairs this row. The read path only lapses a row carrying a dated expiry, and the
    // reconciliation pass re-asks about subscriptions — so a `beta` granted by a since-edited catalog would
    // stand active, forever, with no purchase behind it.
    await project(ads(), { config: adsCatalog(["ads_removed", "beta"]) });
    expect(await entitlementRows()).toEqual([
      { user_id: "ada", entitlement: "ads_removed", active: 1 },
      { user_id: "ada", entitlement: "beta", active: 1 },
    ]);

    const narrowed = adsCatalog(["ads_removed"]);
    await project(
      ads({ status: "refunded", revokedAt: new Date(T0 + SECOND), providerEventAt: new Date(T0 + SECOND) }),
      {
        config: narrowed,
      },
    );

    expect(await entitlementRows()).toEqual([
      { user_id: "ada", entitlement: "ads_removed", active: 0 },
      { user_id: "ada", entitlement: "beta", active: 0 },
    ]);
  });

  test("the orphaned key is cleared by any projection for that user, not only one about its own product", async () => {
    // The repair is per user, because the trigger is a catalog edit rather than an event: no purchase for a
    // product that no longer grants `beta` will ever arrive, so waiting for one is waiting forever.
    await project(ads(), { config: adsCatalog(["ads_removed", "beta"]) });
    const wider = PaymentsConfig.parse({
      rails: { apple: true },
      products: {
        remove_ads: {
          type: "non_consumable",
          name: "Remove ads",
          entitlements: ["ads_removed"],
          apple: { productId: "com.acme.removeads" },
        },
        pro_monthly: {
          type: "subscription",
          name: "Pro monthly",
          entitlements: ["pro"],
          apple: { productId: "com.acme.pro.monthly" },
        },
      },
    });
    await project(event({ providerTransactionId: "txn-pro" }), { config: wider });

    expect(await entitlementRows()).toEqual([
      { user_id: "ada", entitlement: "ads_removed", active: 1 },
      { user_id: "ada", entitlement: "beta", active: 0 },
      { user_id: "ada", entitlement: "pro", active: 1 },
    ]);
  });

  test("a user holding more orphaned keys than D1 will bind is still repaired, and the write still lands", async () => {
    // The repair widens the key set from "what one product grants" to "what this user holds", so it is the
    // one that can push the read-back past D1's parameter cap. A hundred and twenty keys is what years of
    // catalog edits leave on a long-lived account, and it must cost the purchase nothing.
    const keys = Array.from({ length: 120 }, (_, i) => `legacy_${i}`);
    for (const key of keys) {
      await env.DB.prepare(
        "INSERT INTO pithy_payments_entitlements (id, user_id, entitlement, active, expires_at, source_purchase_id, manual, created_at, updated_at) VALUES (?, 'ada', ?, 1, NULL, NULL, 0, ?, ?)",
      )
        .bind(`ent-${key}`, key, T0, T0)
        .run();
    }

    const result = await project(event());

    expect(result.outcome).toBe("created");
    const rows = await entitlementRows();
    expect(rows.filter((row) => row.active === 1)).toEqual([{ user_id: "ada", entitlement: "pro", active: 1 }]);
    expect(rows).toHaveLength(121);
  });

  test("a support comp of a key the catalog never sold survives the repair", async () => {
    // The hold is the whole point: `founder` has no purchase behind it and never will, and it is not the
    // projection's to clear. The repair above must not become a way to erase every manual grant.
    await grantEntitlement(env.DB, { userId: "ada", entitlement: "founder" }, { now: new Date(T0) });
    await project(event());

    expect(await entitlementRows()).toEqual([
      { user_id: "ada", entitlement: "founder", active: 1 },
      { user_id: "ada", entitlement: "pro", active: 1 },
    ]);
  });
});

describe("upsertPurchaseStatement — the guards the database applies at commit", () => {
  /**
   * The encoded row the writer would build, so a test can compile the upsert itself, let the table move
   * underneath the compiled statement, and then execute it. That interleaving is the only way to reach the
   * `ON CONFLICT` predicate: `projectPurchase` serializes its own pre-read and post-batch checks around it,
   * so a test driving the whole function cannot tell whether the predicate is there.
   */
  const row = (overrides: Partial<PaymentsPurchase> = {}): PaymentsPurchaseRow =>
    PaymentsPurchase.encode({
      id: "purchase-compiled",
      userId: "ada",
      rail: "apple",
      providerTransactionId: "txn-1",
      productId: "pro_monthly",
      providerProductId: "com.acme.pro.monthly",
      type: "subscription",
      status: "active",
      environment: "production",
      purchasedAt: new Date(T0),
      expiresAt: new Date(T0 + 30 * DAY),
      revokedAt: null,
      originalTransactionId: null,
      amountMinor: null,
      currency: null,
      providerEventAt: new Date(T0),
      payload: { transactionId: "txn-1" },
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
      ...overrides,
    });

  test("a stale write compiled before a newer row landed is refused by the predicate, not by the pre-read", async () => {
    await project(event({ status: "active", providerEventAt: new Date(T0) }));
    // Compiled while the row said T0 — this writer believes it is the newer one.
    const stale = upsertPurchaseStatement(env.DB, row({ status: "revoked", providerEventAt: new Date(T0 + SECOND) }));
    // And then the row moves on underneath it.
    await project(event({ status: "active", providerEventAt: new Date(T0 + 10 * SECOND) }));

    await stale.run();

    expect(await purchaseRows()).toEqual([{ user_id: "ada", status: "active", provider_event_at: T0 + 10 * SECOND }]);
  });

  test("a write compiled for another user cannot overwrite the owner's row, even carrying a newer event", async () => {
    await project(event({ userId: "ada", status: "active", providerEventAt: new Date(T0) }));
    // Newer than the row, so the monotonic half of the predicate lets it through. Only the owner half refuses
    // it — and `userId` is absent from the update set, so without that half the theft is silent: ada keeps
    // the row and grace's status, payload, and timestamp land on it.
    const thief = upsertPurchaseStatement(
      env.DB,
      row({ userId: "grace", status: "revoked", providerEventAt: new Date(T0 + 10 * SECOND) }),
    );

    await thief.run();

    expect(await purchaseRows()).toEqual([{ user_id: "ada", status: "active", provider_event_at: T0 }]);
  });
});
