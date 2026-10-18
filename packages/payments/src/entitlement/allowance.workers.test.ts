// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { noopEmit } from "@pithy-sh/core/src/audit/recorder";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { feature, meterLimit, quota } from "@pithy-sh/core/src/entitlement/allowance";
import { noEntitlementProvider } from "@pithy-sh/core/src/entitlement/entitlement";
import { requireEntitlement } from "@pithy-sh/core/src/entitlement/require";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { createLogger, noopLogger } from "@pithy-sh/core/src/logger/logger";
import type { LogRecord } from "@pithy-sh/core/src/logger/record";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { PaymentsConfig } from "../config/config";
import type { PaymentsSubject } from "../data/subject";
import { paymentsDatabase } from "../data/tables";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { payments_0002_allowances } from "../migrations/0002_allowances";
import { grantEntitlement } from "./manual";
import {
  calendarMonthStart,
  chargeMeter,
  meterPeriodStart,
  type PaymentsAllowances,
  paymentsUsageMeter,
} from "./meter";
import { setOverride, setUnrestricted } from "./override";
import { installEntitlementResolver } from "./resolver";
import type { PaymentsSubjectSeam } from "./subjectSeam";

/**
 * The allowance readers and the kit's own meters, against real D1 — what `quota(c, name)` answers a route,
 * and what an enforced meter does at its limit.
 */

const DAY = 86_400_000;
const ACME: PaymentsSubject = { subjectType: "organization", subjectId: "acme" };

/** The issue's own catalog: start / growth / scale sold, enterprise comp-only, a free floor, emails enforced. */
const config = PaymentsConfig.parse({
  billingSubject: "organization",
  rails: { stripe: true },
  stripe: {
    successUrl: "https://acme.example/thanks",
    cancelUrl: "https://acme.example/pricing",
    portalReturnUrl: "https://acme.example/account",
  },
  entitlements: {
    start: {
      name: "Start",
      quotas: { emails: 500, projects: 3, seats: 2 },
      features: { sso: false, auditExport: false },
    },
    growth: {
      name: "Growth",
      quotas: { emails: 5000, projects: 10, seats: 10 },
      features: { sso: true, auditExport: false },
      overrideMax: { emails: 100_000 },
    },
    scale: {
      name: "Scale",
      quotas: { emails: null, projects: null, seats: 50 },
      features: { sso: true, auditExport: true },
    },
    enterprise: {
      name: "Enterprise",
      quotas: { emails: null, projects: null, seats: null },
      features: { sso: true, auditExport: true },
    },
  },
  defaults: {
    quotas: { emails: 2, projects: 1, seats: 1, storageBytes: 1024 },
    features: { sso: false, auditExport: false },
  },
  meters: { emails: { enforce: true }, storageBytes: { enforce: true } },
  products: {
    start_monthly: { type: "subscription", name: "Start", entitlements: ["start"], stripe: { priceId: "price_start" } },
    growth_monthly: {
      type: "subscription",
      name: "Growth",
      entitlements: ["growth"],
      stripe: { priceId: "price_growth" },
    },
    scale_monthly: { type: "subscription", name: "Scale", entitlements: ["scale"], stripe: { priceId: "price_scale" } },
  },
});

const allowances: PaymentsAllowances = { declarations: config, meters: config.meters };

/** Organization billing, answering from a header the way an adopter answers from a session. */
const SEAM: PaymentsSubjectSeam = {
  billingSubject: "organization",
  resolveSubject: async (c) => {
    const acting = c.req.header("x-org");
    return acting ? { subjectType: "organization", subjectId: acting } : undefined;
  },
};

/** An entitlement row, as the projection would derive one. */
async function hold(subject: PaymentsSubject, entitlement: string, expiresAt: number | null = Date.now() + 30 * DAY) {
  await env.DB.prepare(
    "INSERT INTO pithy_payments_entitlements (id, subject_type, subject_id, entitlement, active, expires_at, source_purchase_id, manual, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, 'p1', 0, 0, 0) ON CONFLICT (subject_type, subject_id, entitlement) DO UPDATE SET active = 1, expires_at = excluded.expires_at",
  )
    .bind(crypto.randomUUID(), subject.subjectType, subject.subjectId, entitlement, expiresAt)
    .run();
}

/** End one entitlement — what a projection does when a subscription is replaced. */
async function lapse(subject: PaymentsSubject, entitlement: string) {
  await env.DB.prepare(
    "UPDATE pithy_payments_entitlements SET active = 0 WHERE subject_type = ? AND subject_id = ? AND entitlement = ?",
  )
    .bind(subject.subjectType, subject.subjectId, entitlement)
    .run();
}

/** A subscription purchase row for one billing period. */
async function subscriptionPeriod(subject: PaymentsSubject, start: number, end: number) {
  await env.DB.prepare(
    "INSERT INTO pithy_payments_purchases (id, subject_type, subject_id, rail, provider_transaction_id, product_id, provider_product_id, type, status, environment, purchased_at, expires_at, revoked_at, original_transaction_id, amount_minor, currency, provider_event_at, payload, created_at, updated_at) VALUES (?, ?, ?, 'stripe', ?, 'growth_monthly', 'price_growth', 'subscription', 'active', 'sandbox', ?, ?, null, 'sub_1', 999, 'usd', 0, '{}', 0, 0)",
  )
    .bind(crypto.randomUUID(), subject.subjectType, subject.subjectId, `in_${start}`, start, end)
    .run();
}

function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    c.set("entitlements", noEntitlementProvider);
    c.set("emit", noopEmit);
    c.set("log", noopLogger);
    c.set("db", { app: paymentsDatabase(env.DB) });
    c.set("auth", { userId: "ada", sessionId: "s1", scopes: [] });
    await next();
  });
  installEntitlementResolver("app", SEAM, allowances)(app);
  app.get("/quota/:name", async (c) => {
    try {
      return c.json({ value: await quota(c, c.req.path.split("/").at(-1) ?? "") });
    } catch (error) {
      return c.json(
        { code: error instanceof PithyError ? error.payload.code : "?", detail: (error as PithyError).payload?.detail },
        500,
      );
    }
  });
  app.get("/feature/:name", async (c) => c.json({ value: await feature(c, c.req.path.split("/").at(-1) ?? "") }));
  app.get("/meter/:name", async (c) => c.json(await meterLimit(c, c.req.path.split("/").at(-1) ?? "")));
  app.get("/paid", requireEntitlement("growth"), (c) => c.json({ ok: true }));
  return app;
}

async function read(path: string, org: string | undefined = "acme") {
  const response = await makeApp().request(`http://x${path}`, { headers: org ? { "x-org": org } : {} }, env);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  for (const table of [
    "pithy_payments_purchases",
    "pithy_payments_entitlements",
    "pithy_payments_provider_accounts",
    "pithy_payments_webhook_events",
    "pithy_payments_reconcile_runs",
    "pithy_payments_sync_cursors",
    "pithy_payments_overrides",
    "pithy_payments_meter_counters",
    "pithy_payments_usage_reports",
    "pithy_payments_usage_runs",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await payments_0001_purchases.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  await payments_0002_allowances.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

describe("quota(c, name) and feature(c, name)", () => {
  test("take no key and resolve across every key the subject holds — the higher wins", async () => {
    await hold(ACME, "start");
    await hold(ACME, "growth");
    expect((await read("/quota/seats")).body.value).toBe(10);
    expect((await read("/feature/sso")).body.value).toBe(true);
  });

  test("a subject holding nothing reads the free floor, and a name the floor omits is 0 — never unlimited", async () => {
    expect((await read("/quota/emails")).body.value).toBe(2);
    expect((await read("/quota/projects", undefined)).body.value).toBe(1);
  });

  test("a name no declaration mentions throws core/internal naming it — a typo never reads as unlimited", async () => {
    const response = await read("/quota/emals");
    expect(response.status).toBe(500);
    expect(response.body.code).toBe("core/internal");
    expect(response.body.detail).toContain("emails");
  });

  test("a quota that changes on renewal is reflected after the next projection, with no manual step", async () => {
    await hold(ACME, "start");
    expect((await read("/quota/emails")).body.value).toBe(500);
    // The renewal that moved the subject a band up: the projection lapses one key and grants the next.
    await lapse(ACME, "start");
    await hold(ACME, "growth");
    expect((await read("/quota/emails")).body.value).toBe(5000);
  });

  test("requireEntitlement still gates on the key alone — a quota and a false feature never deny", async () => {
    await hold(ACME, "growth");
    expect((await read("/feature/auditExport")).body.value).toBe(false);
    const response = await makeApp().request("http://x/paid", { headers: { "x-org": "acme" } }, env);
    expect(response.status).toBe(200);
  });
});

describe("the override, read through the gate's resolver", () => {
  test("an override grants no key — a subject holding nothing with one is still unentitled at every gate", async () => {
    await setUnrestricted(env.DB, { subject: ACME, version: 0, reason: "contract", unrestricted: true });
    expect((await read("/quota/seats")).body.value).toBeNull();
    const response = await makeApp().request("http://x/paid", { headers: { "x-org": "acme" } }, env);
    expect(response.status).toBe(403);
  });

  test("an override and a manual grant compose: a comped key with a pinned quota resolves to both", async () => {
    await grantEntitlement(env.DB, config, { ...ACME, entitlement: "enterprise" });
    await setOverride(env.DB, config, { subject: ACME, version: 0, reason: "contract", quotas: { emails: 20_000 } });
    expect((await read("/quota/emails")).body.value).toBe(20_000);
    expect((await read("/quota/seats")).body.value).toBeNull();
    expect((await read("/feature/auditExport")).body.value).toBe(true);
  });
});

describe("the emails meter", () => {
  const db = () => paymentsDatabase(env.DB);
  const now = new Date("2026-10-18T12:00:00.000Z");

  async function used(): Promise<number[]> {
    const { results } = await env.DB.prepare(
      "SELECT used FROM pithy_payments_meter_counters ORDER BY period_start",
    ).all<{
      used: number;
    }>();
    return results.map((row) => row.used);
  }

  test("charges within the quota, then refuses at it with payments/quota_exceeded at 402", async () => {
    await chargeMeter(db(), allowances, { subject: ACME, meter: "emails", amount: 1, now });
    await chargeMeter(db(), allowances, { subject: ACME, meter: "emails", amount: 1, now });
    const third = chargeMeter(db(), allowances, { subject: ACME, meter: "emails", amount: 1, now });
    await expect(third).rejects.toMatchObject({ payload: { code: "payments/quota_exceeded", status: 402 } });
    expect(await used()).toEqual([2]);
  });

  test("an advisory meter counts nothing and refuses nothing — an adopter already over it is unaffected", async () => {
    const advisory: PaymentsAllowances = { declarations: config, meters: {} };
    for (let i = 0; i < 5; i++) {
      await chargeMeter(db(), advisory, { subject: ACME, meter: "emails", amount: 1, now });
    }
    expect(await used()).toEqual([]);
  });

  test("an unrestricted subject is never refused by the emails meter", async () => {
    await setUnrestricted(env.DB, { subject: ACME, version: 0, reason: "ourselves", unrestricted: true });
    for (let i = 0; i < 10; i++) {
      await chargeMeter(db(), allowances, { subject: ACME, meter: "emails", amount: 1, now });
    }
    expect(await used()).toEqual([10]);
  });

  test("concurrent sends cannot race past the limit", async () => {
    await hold(ACME, "start");
    const limited: PaymentsAllowances = {
      declarations: {
        entitlements: { start: { name: "Start", quotas: { emails: 5 }, features: {} } },
      },
      meters: config.meters,
    };
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => chargeMeter(db(), limited, { subject: ACME, meter: "emails", amount: 1, now })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(await used()).toEqual([5]);
  });

  test("the period is the subscription's billing period where payments knows one", async () => {
    const start = Date.parse("2026-10-05T09:00:00.000Z");
    await subscriptionPeriod(ACME, start, start + 30 * DAY);
    expect((await meterPeriodStart(db(), ACME, now)).toISOString()).toBe("2026-10-05T09:00:00.000Z");
  });

  test("and the calendar month (UTC) where it does not", async () => {
    expect((await meterPeriodStart(db(), ACME, now)).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(calendarMonthStart(new Date("2026-12-31T23:59:59.000Z")).toISOString()).toBe("2026-12-01T00:00:00.000Z");
  });

  test("a new period starts at zero with no cron, sweep or reset job", async () => {
    await chargeMeter(db(), allowances, { subject: ACME, meter: "emails", amount: 2, now });
    await expect(chargeMeter(db(), allowances, { subject: ACME, meter: "emails", amount: 1, now })).rejects.toThrow();
    // Crossing into November: a new period is a new row, so the first charge of it lands.
    const november = new Date("2026-11-01T00:00:01.000Z");
    await chargeMeter(db(), allowances, { subject: ACME, meter: "emails", amount: 1, now: november });
    expect(await used()).toEqual([2, 1]);
  });

  test("a counter read that throws refuses and logs, through the meter email charges", async () => {
    // The tables are gone: every read throws. The meter must refuse — never let the send through unbounded.
    await env.DB.exec("DROP TABLE pithy_payments_meter_counters");
    const logs: LogRecord[] = [];
    const meter = paymentsUsageMeter(allowances);
    const charge = meter.charge(env as unknown as Record<string, unknown>, {
      subject: ACME,
      meter: "emails",
      amount: 1,
      now,
      log: createLogger({ level: "debug", sink: (record) => logs.push(record) }),
    });
    await expect(charge).rejects.toMatchObject({ payload: { code: "core/internal" } });
    expect(logs.some((record) => record.msg === "usage meter charge failed")).toBe(true);
  });
});

describe("meterLimit for a level the capability counts itself", () => {
  test("an enforced storageBytes meter answers the subject's effective quota, and the organization it covers", async () => {
    expect((await read("/meter/storageBytes")).body).toEqual({ enforced: true, limit: 1024, tenant: "acme" });
  });

  test("an unrestricted subject is unlimited on every enforced meter", async () => {
    await setUnrestricted(env.DB, { subject: ACME, version: 0, reason: "ourselves", unrestricted: true });
    expect((await read("/meter/storageBytes")).body).toEqual({ enforced: true, limit: null, tenant: "acme" });
  });

  test("an advisory meter is unenforced, so the capability keeps its own ceiling", async () => {
    expect((await read("/meter/mediaItems")).body).toEqual({ enforced: false });
  });
});
