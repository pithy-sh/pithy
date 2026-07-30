// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import { paymentsDatabase } from "../data/tables";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { linkProviderAccount, providerAccountForUser, resolveNotificationOwner } from "./owner";
import { projectPurchase } from "./writer";

const TABLES = [
  "pithy_payments_purchases",
  "pithy_payments_entitlements",
  "pithy_payments_provider_accounts",
  "pithy_payments_webhook_events",
];

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await payments_0001_purchases.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

const CONFIG = PaymentsConfig.parse({
  rails: { apple: true },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.monthly" },
    },
  },
});

const NOW = new Date("2026-01-15T00:00:00.000Z");

/** Project one Apple transaction, so the owner lookups have something real to find. */
async function project(overrides: { transactionId: string; originalTransactionId?: string; userId: string }) {
  return projectPurchase(
    env.DB,
    {
      rail: "apple",
      providerTransactionId: overrides.transactionId,
      providerProductId: "com.acme.pro.monthly",
      userId: overrides.userId,
      status: "active",
      environment: "production",
      purchasedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      originalTransactionId: overrides.originalTransactionId ?? null,
      providerEventAt: NOW,
      payload: {},
    },
    { config: CONFIG, environment: "production", now: NOW },
  );
}

const db = () => paymentsDatabase(env.DB);

/**
 * Who a webhook belongs to.
 *
 * A notification arrives carrying the store's identifiers and no Pithy user id, so somebody has to answer the
 * question before the projection can run — and the projection refuses to guess, because a webhook that could
 * name a user could be talked into naming the wrong one.
 *
 * Three sources, in decreasing order of how directly they were stated. The account link is the app's own
 * declaration at purchase time. The transaction row is the same transaction, already owned. The original
 * transaction is a renewal of a subscription somebody bought. All three are sound; the order is which to
 * believe when more than one answers.
 */
describe("linkProviderAccount", () => {
  test("links a store account to a user, and is idempotent", async () => {
    expect(await linkProviderAccount(env.DB, "apple", "token-1", "ada", { now: NOW })).toBe("ada");
    // A client submits its receipt on every launch; the link must survive that without a second row.
    expect(await linkProviderAccount(env.DB, "apple", "token-1", "ada", { now: NOW })).toBe("ada");
    const rows = await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  test("a store account already bound to someone else stays bound to them", async () => {
    // `UNIQUE (rail, providerAccountId)` is the constraint; this is what it means in behaviour. Rebinding
    // would let a second Pithy account capture the first one's renewal notifications.
    await linkProviderAccount(env.DB, "apple", "token-1", "ada", { now: NOW });
    expect(await linkProviderAccount(env.DB, "apple", "token-1", "grace", { now: NOW })).toBe("ada");
    const rows = await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe("ada");
  });

  test("the same identifier on two rails is two links — the rails are separate namespaces", async () => {
    await linkProviderAccount(env.DB, "apple", "shared-id", "ada", { now: NOW });
    expect(await linkProviderAccount(env.DB, "stripe", "shared-id", "grace", { now: NOW })).toBe("grace");
    expect(await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute()).toHaveLength(2);
  });
});

describe("resolveNotificationOwner", () => {
  test("finds the user through the account link the app declared", async () => {
    await linkProviderAccount(env.DB, "apple", "token-1", "ada", { now: NOW });
    expect(await resolveNotificationOwner(db(), "apple", { providerAccountId: "token-1" })).toBe("ada");
  });

  test("finds the user through a transaction already projected — a redelivery is never orphaned", async () => {
    await project({ transactionId: "txn-1", userId: "ada" });
    expect(await resolveNotificationOwner(db(), "apple", { providerTransactionId: "txn-1" })).toBe("ada");
  });

  test("finds the user through the transaction that started the subscription — a renewal follows its buyer", async () => {
    // The case that makes renewals work for an app that set no account token: the first purchase was
    // submitted by its owner, and every renewal chains back to it.
    await project({ transactionId: "txn-original", userId: "ada" });
    expect(await resolveNotificationOwner(db(), "apple", { originalTransactionId: "txn-original" })).toBe("ada");
  });

  test("prefers the projected purchase over the account link when the two disagree", async () => {
    // The order is a trust order. The row is who owned a purchase this server projected for an authenticated
    // caller; the link is a value the *app* chose, because on Apple and Google `providerAccountId` is
    // `appAccountToken`. Consulting the link first was a cross-user hijack: an attacker who guesses a victim's
    // token makes one purchase carrying it, submits it as themselves, owns the link, and then collects the
    // victim's renewals — which carry fresh transaction ids, so the writer's owner check never fires.
    await project({ transactionId: "txn-1", userId: "grace" });
    await linkProviderAccount(env.DB, "apple", "token-1", "ada", { now: NOW });
    expect(
      await resolveNotificationOwner(db(), "apple", { providerAccountId: "token-1", providerTransactionId: "txn-1" }),
    ).toBe("grace");
  });

  test("prefers the subscription family over the account link too", async () => {
    // The same rule one step out: a renewal names the transaction that started the subscription, and that
    // purchase's owner is a fact this server established. A squatted link must not outrank it.
    await project({ transactionId: "txn-original", userId: "grace" });
    await linkProviderAccount(env.DB, "apple", "token-1", "ada", { now: NOW });
    expect(
      await resolveNotificationOwner(db(), "apple", {
        providerAccountId: "token-1",
        providerTransactionId: "txn-renewal",
        originalTransactionId: "txn-original",
      }),
    ).toBe("grace");
  });

  test("falls back to the account link when nothing this server projected answers", async () => {
    // Still last, not gone: on Stripe the link is written from `client_reference_id`, which `/checkout` set
    // from the authenticated buyer, and it is the only thing that can attribute a first invoice.
    await linkProviderAccount(env.DB, "stripe", "cus_1", "ada", { now: NOW });
    expect(
      await resolveNotificationOwner(db(), "stripe", { providerAccountId: "cus_1", providerTransactionId: "in_new" }),
    ).toBe("ada");
  });

  test("scopes every lookup to the rail", async () => {
    await linkProviderAccount(env.DB, "stripe", "token-1", "ada", { now: NOW });
    await project({ transactionId: "txn-1", userId: "grace" });
    expect(await resolveNotificationOwner(db(), "apple", { providerAccountId: "token-1" })).toBeUndefined();
    expect(await resolveNotificationOwner(db(), "google", { providerTransactionId: "txn-1" })).toBeUndefined();
  });

  test("returns undefined when nothing identifies the owner — an orphan, not a guess", async () => {
    expect(
      await resolveNotificationOwner(db(), "apple", {
        providerAccountId: "unknown",
        providerTransactionId: "unknown",
        originalTransactionId: "unknown",
      }),
    ).toBeUndefined();
  });

  test("returns undefined for a notification carrying no identifiers at all", async () => {
    // A hint object of undefineds must not turn into a query that matches any row.
    await project({ transactionId: "txn-1", userId: "ada" });
    expect(await resolveNotificationOwner(db(), "apple", {})).toBeUndefined();
  });
});

describe("providerAccountForUser", () => {
  test("finds the store account this user already has on this rail", async () => {
    // What `/checkout` passes to Stripe so a returning buyer keeps one customer, and what `/portal` opens a
    // billing session against.
    await linkProviderAccount(env.DB, "stripe", "cus_PithyAda", "ada", { now: NOW });
    expect(await providerAccountForUser(db(), "stripe", "ada")).toBe("cus_PithyAda");
  });

  test("is undefined for a user who has never bought on that rail", async () => {
    // The `/portal` 404: there is nothing to manage until something was bought.
    await linkProviderAccount(env.DB, "stripe", "cus_PithyAda", "ada", { now: NOW });
    expect(await providerAccountForUser(db(), "stripe", "grace")).toBeUndefined();
    expect(await providerAccountForUser(db(), "apple", "ada")).toBeUndefined();
  });

  test("the oldest link wins when a user somehow has two", async () => {
    // Two links take two purchases under two store accounts, since a link is never rebound. The first is the
    // one every earlier purchase is filed under.
    await linkProviderAccount(env.DB, "stripe", "cus_First", "ada", { now: NOW });
    await linkProviderAccount(env.DB, "stripe", "cus_Second", "ada", { now: new Date(NOW.getTime() + 86_400_000) });
    expect(await providerAccountForUser(db(), "stripe", "ada")).toBe("cus_First");
  });
});
