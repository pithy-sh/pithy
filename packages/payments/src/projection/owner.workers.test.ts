// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { PaymentsPurchase } from "../data/purchase";
import type { PaymentsSubject } from "../data/subject";
import { PAYMENTS_PURCHASES_TABLE, paymentsDatabase } from "../data/tables";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { linkProviderAccount, providerAccountForSubject, resolveNotificationOwner } from "./owner";

const TABLES = [
  "pithy_payments_purchases",
  "pithy_payments_entitlements",
  "pithy_payments_provider_accounts",
  "pithy_payments_webhook_events",
  "pithy_payments_reconcile_runs",
  "pithy_payments_sync_cursors",
];

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  await payments_0001_purchases.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

const NOW = new Date("2026-01-15T00:00:00.000Z");

/**
 * The four holders these tests need, and the reason there are four.
 *
 * `ACME_ORG` and `ACME_USER` share an id and differ only in kind. Nothing in the kit makes the two id
 * namespaces disjoint — an organization id is the adopter's own, a user id is Pithy's — so this collision is
 * a state a real project can reach without doing anything wrong. Every lookup in `owner.ts` has to tell them
 * apart, and a test that only ever used distinct ids would pass against an id-only filter.
 */
const ADA: PaymentsSubject = { subjectType: "user", subjectId: "ada" };
const GRACE: PaymentsSubject = { subjectType: "user", subjectId: "grace" };
const ACME_ORG: PaymentsSubject = { subjectType: "organization", subjectId: "acme" };
const ACME_USER: PaymentsSubject = { subjectType: "user", subjectId: "acme" };

const db = () => paymentsDatabase(env.DB);

/**
 * Insert one Apple purchase, so the owner lookups have a real row to find.
 *
 * Written straight into the table rather than through `projectPurchase`, deliberately: what is under test is
 * which row a lookup reads and which columns it reads off it. Going through the writer would drag its catalog,
 * its environment check and its monotonic rule into every case here, and none of those decides who a
 * notification belongs to.
 */
async function purchase(owner: PaymentsSubject, transactionId: string, originalTransactionId: string | null = null) {
  const row = PaymentsPurchase.encode({
    id: `purchase-${transactionId}-${owner.subjectType}-${owner.subjectId}`,
    subjectType: owner.subjectType,
    subjectId: owner.subjectId,
    rail: "apple",
    providerTransactionId: transactionId,
    productId: "pro_monthly",
    providerProductId: "com.acme.pro.monthly",
    type: "subscription",
    status: "active",
    role: "charge",
    environment: "production",
    purchasedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    revokedAt: null,
    resumesAt: null,
    originalTransactionId,
    amountMinor: null,
    currency: null,
    providerEventAt: NOW,
    payload: {},
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db()
    .insertInto(PAYMENTS_PURCHASES_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: an encoded row; Kysely's insert type derives from z.input.
    .values(row as any)
    .execute();
}

/**
 * Who a webhook belongs to.
 *
 * A notification arrives carrying the store's identifiers and no Pithy identity, so somebody has to answer the
 * question before the projection can run — and the projection refuses to guess, because a webhook that could
 * name a holder could be talked into naming the wrong one.
 *
 * The answer is a **subject**: a kind and an id, always both, always read from one row. Three sources can
 * supply it, and the order they are consulted in is a trust order — the two transaction lookups are facts this
 * server established, the account link is a value a client chose.
 */
describe("linkProviderAccount", () => {
  test("links a store account to a subject, and is idempotent", async () => {
    expect(await linkProviderAccount(env.DB, "apple", "token-1", ADA, { now: NOW })).toEqual(ADA);
    // A client submits its receipt on every launch; the link must survive that without a second row.
    expect(await linkProviderAccount(env.DB, "apple", "token-1", ADA, { now: NOW })).toEqual(ADA);
    const rows = await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  test("binds an organization when that is who the project bills", async () => {
    // The kind is stored, not assumed. A link written under organization billing must come back as an
    // organization, or every renewal it resolves lands on a user that may not even exist.
    expect(await linkProviderAccount(env.DB, "apple", "token-1", ACME_ORG, { now: NOW })).toEqual(ACME_ORG);
    const rows = await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute();
    expect(rows[0]?.subjectType).toBe("organization");
    expect(rows[0]?.subjectId).toBe("acme");
  });

  test("a store account already bound to someone else stays bound to them", async () => {
    // `UNIQUE (rail, providerAccountId)` is the constraint; this is what it means in behaviour. Rebinding
    // would let a second holder capture the first one's renewal notifications.
    await linkProviderAccount(env.DB, "apple", "token-1", ADA, { now: NOW });
    expect(await linkProviderAccount(env.DB, "apple", "token-1", GRACE, { now: NOW })).toEqual(ADA);
    const rows = await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subjectId).toBe("ada");
  });

  test("a different subject kind with the same id cannot rebind either — the key is not widened", async () => {
    // The kind is no escape hatch from the unique. If `organization:acme` could take a link `user:acme`
    // already holds, an adopter who can name an organization after a user id captures that user's renewals —
    // and the reverse holds too, which is why both directions are asserted.
    await linkProviderAccount(env.DB, "apple", "token-1", ACME_USER, { now: NOW });
    expect(await linkProviderAccount(env.DB, "apple", "token-1", ACME_ORG, { now: NOW })).toEqual(ACME_USER);

    await linkProviderAccount(env.DB, "apple", "token-2", ACME_ORG, { now: NOW });
    expect(await linkProviderAccount(env.DB, "apple", "token-2", ACME_USER, { now: NOW })).toEqual(ACME_ORG);

    // Two links, one per provider identity. Never four.
    expect(await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute()).toHaveLength(2);
  });

  test("the same identifier on two rails is two links — the rails are separate namespaces", async () => {
    await linkProviderAccount(env.DB, "apple", "shared-id", ADA, { now: NOW });
    expect(await linkProviderAccount(env.DB, "stripe", "shared-id", GRACE, { now: NOW })).toEqual(GRACE);
    expect(await db().selectFrom("pithyPaymentsProviderAccounts").selectAll().execute()).toHaveLength(2);
  });
});

describe("resolveNotificationOwner", () => {
  test("finds the subject through the account link the app declared", async () => {
    await linkProviderAccount(env.DB, "apple", "token-1", ADA, { now: NOW });
    expect(await resolveNotificationOwner(db(), "apple", { providerAccountId: "token-1" })).toEqual(ADA);
  });

  test("finds the subject through a transaction already projected — a redelivery is never orphaned", async () => {
    await purchase(ADA, "txn-1");
    expect(await resolveNotificationOwner(db(), "apple", { providerTransactionId: "txn-1" })).toEqual(ADA);
  });

  test("finds the subject through the transaction that started the subscription — a renewal follows its buyer", async () => {
    // The case that makes renewals work for an app that set no account token: the first purchase was
    // submitted by its owner, and every renewal chains back to it.
    await purchase(ADA, "txn-original");
    expect(await resolveNotificationOwner(db(), "apple", { originalTransactionId: "txn-original" })).toEqual(ADA);
  });

  test("returns the kind the row carries, never a kind assumed beside the id", async () => {
    // The pair is read from one row, so an organization's purchase resolves to that organization — not to the
    // user who happens to share its id. Every source is checked, because it is the assembly of the pair that
    // is at issue and each source assembles its own.
    await purchase(ACME_ORG, "txn-org", "txn-org-original");
    await linkProviderAccount(env.DB, "apple", "token-org", ACME_ORG, { now: NOW });

    expect(await resolveNotificationOwner(db(), "apple", { providerTransactionId: "txn-org" })).toEqual(ACME_ORG);
    expect(await resolveNotificationOwner(db(), "apple", { originalTransactionId: "txn-org-original" })).toEqual(
      ACME_ORG,
    );
    expect(await resolveNotificationOwner(db(), "apple", { providerAccountId: "token-org" })).toEqual(ACME_ORG);
  });

  test("tells two holders with the same id apart, whichever source answers", async () => {
    // The collision, end to end: one id, two kinds, three sources. An id-only lookup would return whichever
    // row it reached first, which is one customer reading another's subscription.
    await purchase(ACME_USER, "txn-user");
    await purchase(ACME_ORG, "txn-org");
    await linkProviderAccount(env.DB, "apple", "token-user", ACME_USER, { now: NOW });
    await linkProviderAccount(env.DB, "apple", "token-org", ACME_ORG, { now: NOW });

    expect(await resolveNotificationOwner(db(), "apple", { providerTransactionId: "txn-user" })).toEqual(ACME_USER);
    expect(await resolveNotificationOwner(db(), "apple", { providerTransactionId: "txn-org" })).toEqual(ACME_ORG);
    expect(await resolveNotificationOwner(db(), "apple", { providerAccountId: "token-user" })).toEqual(ACME_USER);
    expect(await resolveNotificationOwner(db(), "apple", { providerAccountId: "token-org" })).toEqual(ACME_ORG);
  });

  test("prefers the projected purchase over the account link when the two disagree", async () => {
    // The order is a trust order. The row is who owned a purchase this server projected for an authenticated
    // caller; the link is a value the *app* chose, because on Apple and Google `providerAccountId` is
    // `appAccountToken`. Consulting the link first was a cross-subject hijack: an attacker who guesses a
    // victim's token makes one purchase carrying it, submits it as themselves, owns the link, and then
    // collects the victim's renewals — which carry fresh transaction ids, so the writer's owner check never
    // fires.
    await purchase(GRACE, "txn-1");
    await linkProviderAccount(env.DB, "apple", "token-1", ADA, { now: NOW });
    expect(
      await resolveNotificationOwner(db(), "apple", { providerAccountId: "token-1", providerTransactionId: "txn-1" }),
    ).toEqual(GRACE);
  });

  test("prefers the subscription family over the account link too", async () => {
    // The same rule one step out: a renewal names the transaction that started the subscription, and that
    // purchase's owner is a fact this server established. A squatted link must not outrank it.
    await purchase(GRACE, "txn-original");
    await linkProviderAccount(env.DB, "apple", "token-1", ADA, { now: NOW });
    expect(
      await resolveNotificationOwner(db(), "apple", {
        providerAccountId: "token-1",
        providerTransactionId: "txn-renewal",
        originalTransactionId: "txn-original",
      }),
    ).toEqual(GRACE);
  });

  test("a link squatted by another kind still loses to the projected purchase", async () => {
    // The hijack, attempted from the other subject namespace. The trust order is what refuses it, and it
    // refuses it without ever comparing the two holders — which is the point: the link is simply not asked.
    await purchase(ACME_USER, "txn-1");
    await linkProviderAccount(env.DB, "apple", "token-1", ACME_ORG, { now: NOW });
    expect(
      await resolveNotificationOwner(db(), "apple", { providerAccountId: "token-1", providerTransactionId: "txn-1" }),
    ).toEqual(ACME_USER);
  });

  test("falls back to the account link when nothing this server projected answers", async () => {
    // Still last, not gone: on Stripe the link is written from `client_reference_id`, which `/checkout` set
    // from the authenticated buyer, and it is the only thing that can attribute a first invoice.
    await linkProviderAccount(env.DB, "stripe", "cus_1", ADA, { now: NOW });
    expect(
      await resolveNotificationOwner(db(), "stripe", { providerAccountId: "cus_1", providerTransactionId: "in_new" }),
    ).toEqual(ADA);
  });

  test("scopes every lookup to the rail", async () => {
    await linkProviderAccount(env.DB, "stripe", "token-1", ADA, { now: NOW });
    await purchase(GRACE, "txn-1");
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
    await purchase(ADA, "txn-1");
    expect(await resolveNotificationOwner(db(), "apple", {})).toBeUndefined();
  });
});

describe("providerAccountForSubject", () => {
  test("finds the store account this subject already has on this rail", async () => {
    // What `/checkout` passes to Stripe so a returning buyer keeps one customer, and what `/portal` opens a
    // billing session against.
    await linkProviderAccount(env.DB, "stripe", "cus_PithyAda", ADA, { now: NOW });
    expect(await providerAccountForSubject(db(), "stripe", ADA)).toBe("cus_PithyAda");
  });

  test("is undefined for a subject that has never bought on that rail", async () => {
    // The `/portal` 404: there is nothing to manage until something was bought.
    await linkProviderAccount(env.DB, "stripe", "cus_PithyAda", ADA, { now: NOW });
    expect(await providerAccountForSubject(db(), "stripe", GRACE)).toBeUndefined();
    expect(await providerAccountForSubject(db(), "apple", ADA)).toBeUndefined();
  });

  test("does not hand one kind the account belonging to the other kind with the same id", async () => {
    // This is the function `/portal` mints a billing session from, so an id-only filter here is a live
    // session over somebody else's card, invoices and cancellation.
    await linkProviderAccount(env.DB, "stripe", "cus_Org", ACME_ORG, { now: NOW });
    expect(await providerAccountForSubject(db(), "stripe", ACME_USER)).toBeUndefined();

    await linkProviderAccount(env.DB, "stripe", "cus_User", ACME_USER, { now: NOW });
    expect(await providerAccountForSubject(db(), "stripe", ACME_ORG)).toBe("cus_Org");
    expect(await providerAccountForSubject(db(), "stripe", ACME_USER)).toBe("cus_User");
  });

  test("the oldest link wins when a subject somehow has two", async () => {
    // Two links take two purchases under two store accounts, since a link is never rebound. The first is the
    // one every earlier purchase is filed under.
    await linkProviderAccount(env.DB, "stripe", "cus_First", ADA, { now: NOW });
    await linkProviderAccount(env.DB, "stripe", "cus_Second", ADA, { now: new Date(NOW.getTime() + 86_400_000) });
    expect(await providerAccountForSubject(db(), "stripe", ADA)).toBe("cus_First");
  });
});
