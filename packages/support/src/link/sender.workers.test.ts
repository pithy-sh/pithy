// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { authPeer } from "@pithy-sh/auth/src/peer";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { PaymentsConfig } from "@pithy-sh/payments/src/config/config";
import { payments_0001_purchases } from "@pithy-sh/payments/src/migrations/0001_purchases";
import { paymentsPeer } from "@pithy-sh/payments/src/peer";
import { projectPurchase } from "@pithy-sh/payments/src/projection/writer";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { resolveSenderContext, resolveSenderUserId, type SenderPeers } from "./sender";

/**
 * **The link still links, with auth and payments handed over rather than imported** (#645).
 *
 * `sender.test.ts` pins what happens when neither sibling is composed. This is the other half: with the real
 * `authPeer` and `paymentsPeer` — the surfaces `auth()` and `payments()` carry, which `support()`'s `compose`
 * hook finds — a proven sender resolves to their account, what they bought, and what they hold, against real
 * tables in D1.
 */

const NOW = new Date("2026-07-01T00:00:00.000Z");
const PEERS: SenderPeers = { auth: authPeer, payments: paymentsPeer };

const CONFIG = PaymentsConfig.parse({
  billingSubject: "user",
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

beforeEach(async () => {
  // Every table either sibling owns, by prefix, so the migration below starts from nothing whatever it creates.
  const { results } = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and (name like 'pithy_auth_%' or name like 'pithy_payments_%')",
  ).all<{ name: string }>();
  for (const { name } of results) await env.DB.exec(`DROP TABLE IF EXISTS ${name}`);
  // Better Auth's user table, as `@pithy-sh/auth` names it — the columns the link reads, inline.
  await env.DB.prepare(
    `create table pithy_auth_users (
      id text primary key,
      name text,
      email text unique,
      email_verified integer,
      image text,
      created_at text,
      updated_at text,
      locale text
    )`,
  ).run();
  await env.DB.prepare(
    `insert into pithy_auth_users (id, name, email, email_verified, image, created_at, updated_at)
     values ('u-ada', 'Ada', 'ada@example.com', 1, null, ?, ?)`,
  )
    .bind(NOW.toISOString(), NOW.toISOString())
    .run();
  await payments_0001_purchases.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  await projectPurchase(
    env.DB,
    {
      rail: "apple",
      providerTransactionId: "txn-1",
      providerProductId: "com.acme.pro.monthly",
      subjectType: "user",
      subjectId: "u-ada",
      status: "active",
      environment: "production",
      purchasedAt: new Date(NOW.getTime() - 86_400_000),
      expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
      originalTransactionId: "orig-1",
      providerEventAt: new Date(NOW.getTime() - 86_400_000),
      payload: {},
    },
    { config: CONFIG, environment: "production", now: new Date(NOW.getTime() - 86_400_000) },
  );
});

describe("the sender link, composed beside auth and payments", () => {
  test("an address resolves to the account behind it", async () => {
    expect(await resolveSenderUserId(env.DB, "ada@example.com", PEERS)).toBe("u-ada");
  });

  test("a proven sender carries the account, what it bought, and what it holds", async () => {
    const context = await resolveSenderContext(env.DB, "ada@example.com", NOW, { authenticated: true }, PEERS);
    expect(context.userId).toBe("u-ada");
    expect(context.name).toBe("Ada");
    expect(context.purchases.map((purchase) => purchase.productId)).toEqual(["pro_monthly"]);
    expect(context.entitlements.map((entitlement) => entitlement.key)).toContain("pro");
  });

  test("the same database, with neither sibling composed, links nobody", async () => {
    expect(await resolveSenderUserId(env.DB, "ada@example.com", {})).toBeNull();
  });
});
