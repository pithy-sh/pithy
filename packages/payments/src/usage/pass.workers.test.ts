// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { createLogger } from "@pithy-sh/core/src/logger/logger";
import type { LogRecord } from "@pithy-sh/core/src/logger/record";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { lastReports } from "../admin/read";
import { PaymentsConfig, type PaymentsConfigInput } from "../config/config";
import type { PaymentsSubject } from "../data/subject";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { payments_0002_allowances } from "../migrations/0002_allowances";
import { judgeQuantity, type PaymentsQuantityResolver, runUsageReport, utcDay } from "./pass";
import type { UsageReporter, UsageReportRequest } from "./reporter";

/**
 * The usage-reporting pass against real D1: who is asked, what is sent, and what is never sent twice.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ACME: PaymentsSubject = { subjectType: "organization", subjectId: "acme" };
const GLOBEX: PaymentsSubject = { subjectType: "organization", subjectId: "globex" };

/** The academy catalog: seats reported at period end, plus a coach product reported at its daily peak. */
const CATALOG: PaymentsConfigInput = {
  billingSubject: "organization",
  rails: { stripe: true, paddle: true },
  stripe: {
    successUrl: "https://academy.example/thanks",
    cancelUrl: "https://academy.example/pricing",
    portalReturnUrl: "https://academy.example/account",
  },
  paddle: { clientToken: "test_abc", environment: "sandbox", successUrl: "https://academy.example/thanks" },
  entitlements: { pro: { name: "Pro", quotas: { seats: null } } },
  products: {
    academy_seats: {
      type: "subscription",
      name: "Academy",
      entitlements: ["pro"],
      stripe: { priceId: "price_seats" },
      paddle: { priceId: "pri_seats" },
      billing: {
        kind: "reported",
        unit: "student",
        min: 1,
        max: 500,
        rails: ["stripe", "paddle"],
        stripe: { meterEventName: "academy_students" },
        paddle: { priceId: "pri_seat_unit" },
      },
    },
    coaching: {
      type: "subscription",
      name: "Coaching",
      entitlements: ["pro"],
      stripe: { priceId: "price_coaches" },
      billing: {
        kind: "reported",
        unit: "coach",
        cadence: "daily-peak",
        max: 50,
        rails: ["stripe"],
        stripe: { meterEventName: "academy_coaches" },
      },
    },
  },
};
const config = PaymentsConfig.parse(CATALOG);

/** A recording reporter. `fail` makes it refuse, the way a store that is down does. */
function recorder(options: { fail?: () => boolean } = {}): UsageReporter & { calls: UsageReportRequest[] } {
  const calls: UsageReportRequest[] = [];
  return {
    calls,
    async report(request) {
      if (options.fail?.()) throw new Error("the store is down");
      calls.push(request);
    },
  };
}

/** One billing period of one subscription, as the projection writes it. */
async function period(options: {
  subject: PaymentsSubject;
  rail: "stripe" | "paddle";
  product: string;
  subscription: string;
  start: number;
  end: number;
}) {
  await env.DB.prepare(
    "INSERT INTO pithy_payments_purchases (id, subject_type, subject_id, rail, provider_transaction_id, product_id, provider_product_id, type, status, environment, purchased_at, expires_at, revoked_at, original_transaction_id, amount_minor, currency, provider_event_at, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'sku', 'subscription', 'active', 'sandbox', ?, ?, null, ?, 999, 'usd', 0, '{}', 0, 0)",
  )
    .bind(
      crypto.randomUUID(),
      options.subject.subjectType,
      options.subject.subjectId,
      options.rail,
      `${options.subscription}_${options.start}`,
      options.product,
      options.start,
      options.end,
      options.subscription,
    )
    .run();
}

async function customer(subject: PaymentsSubject, id: string) {
  await env.DB.prepare(
    "INSERT INTO pithy_payments_provider_accounts (id, rail, provider_account_id, subject_type, subject_id, created_at) VALUES (?, 'stripe', ?, ?, ?, 0)",
  )
    .bind(crypto.randomUUID(), id, subject.subjectType, subject.subjectId)
    .run();
}

/** Run one pass at `at`, with whatever resolver and reporters a case wants. */
function pass(
  at: number,
  resolveQuantity: PaymentsQuantityResolver,
  reporters: { stripe?: UsageReporter; paddle?: UsageReporter },
  logs: LogRecord[] = [],
  catalog = config,
) {
  return runUsageReport({
    d1: env.DB,
    config: catalog,
    resolveQuantity,
    reporters,
    env: {},
    now: () => new Date(at),
    log: createLogger({ level: "debug", sink: (record) => logs.push(record) }),
  });
}

const START = Date.parse("2026-10-05T09:00:00.000Z");
const END = START + 30 * DAY;

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
  await customer(ACME, "cus_PithyAcme");
  await customer(GLOBEX, "cus_PithyGlobex");
});

describe("judgeQuantity", () => {
  test("bills a whole number inside the product's bounds, and names every other shape", () => {
    const bounds = { min: 1, max: 500 };
    expect(judgeQuantity(25, bounds)).toEqual({ ok: true, quantity: 25 });
    expect(judgeQuantity(undefined, bounds)).toEqual({ ok: false, reason: "unanswered" });
    expect(judgeQuantity(2.5, bounds)).toEqual({ ok: false, reason: "not_integer" });
    expect(judgeQuantity("25", bounds)).toEqual({ ok: false, reason: "not_integer" });
    expect(judgeQuantity(-1, bounds)).toEqual({ ok: false, reason: "negative" });
    expect(judgeQuantity(0, bounds)).toEqual({ ok: false, reason: "below_min" });
    expect(judgeQuantity(501, bounds)).toEqual({ ok: false, reason: "above_max" });
  });
});

describe("period-end", () => {
  test("exactly one report per subscription per billing period, however often the Workflow runs", async () => {
    await period({
      subject: ACME,
      rail: "stripe",
      product: "academy_seats",
      subscription: "sub_acme",
      start: START,
      end: END,
    });
    const stripe = recorder();
    let asked = 0;
    const resolve: PaymentsQuantityResolver = async () => {
      asked++;
      return 25;
    };
    // Mid-period: not due yet, nothing asked.
    await pass(START + 10 * DAY, resolve, { stripe });
    expect(stripe.calls).toEqual([]);
    // Inside the last day, three runs an hour apart.
    for (const hour of [20, 21, 22]) await pass(END - DAY + hour * 60_000, resolve, { stripe });
    expect(stripe.calls).toHaveLength(1);
    expect(asked).toBe(1);
    expect(stripe.calls[0]).toMatchObject({
      providerSubscriptionId: "sub_acme",
      providerCustomerId: "cus_PithyAcme",
      quantity: 25,
      period: new Date(END).toISOString(),
    });
    expect(stripe.calls[0]?.at.getTime()).toBeLessThan(END);
  });

  test("replaying a whole run reports nothing a second time — keyed on (rail, subscription, period)", async () => {
    await period({
      subject: ACME,
      rail: "stripe",
      product: "academy_seats",
      subscription: "sub_acme",
      start: START,
      end: END,
    });
    await period({
      subject: GLOBEX,
      rail: "paddle",
      product: "academy_seats",
      subscription: "sub_globex",
      start: START,
      end: END,
    });
    const stripe = recorder();
    const paddle = recorder();
    const at = END - HOUR;
    const first = await pass(at, async () => 25, { stripe, paddle });
    const replay = await pass(at, async () => 25, { stripe, paddle });
    expect(first.reported).toBe(2);
    expect(replay).toMatchObject({ reported: 0, alreadyReported: 2 });
    expect(stripe.calls).toHaveLength(1);
    expect(paddle.calls).toHaveLength(1);
    expect(paddle.calls[0]?.idempotencyKey).toMatch(/^usage_/);
  });

  test("a failed report stays claimed and is resent under the same key", async () => {
    await period({
      subject: ACME,
      rail: "stripe",
      product: "academy_seats",
      subscription: "sub_acme",
      start: START,
      end: END,
    });
    let down = true;
    const failing = recorder({ fail: () => down });
    const first = await pass(END - 2 * HOUR, async () => 25, { stripe: failing });
    expect(first).toMatchObject({ reported: 0, failed: 1 });
    expect(first.findings).toEqual([{ ...ACME, productId: "academy_seats", reason: "report_failed" }]);
    down = false;
    const keys: string[] = [];
    const retried = await pass(END - HOUR, async () => 99, {
      stripe: {
        async report(request) {
          keys.push(request.idempotencyKey);
          // The claimed quantity, not a fresh answer: the period's number was decided when it was claimed.
          expect(request.quantity).toBe(25);
        },
      },
    });
    expect(retried.reported).toBe(1);
    expect(keys).toHaveLength(1);
  });
});

describe("the subscription reads' last reported count", () => {
  test("is the newest accepted report for the subscription, or nothing before one", async () => {
    await period({
      subject: ACME,
      rail: "stripe",
      product: "academy_seats",
      subscription: "sub_acme",
      start: START,
      end: END,
    });
    const subscription = [{ rail: "stripe" as const, providerSubscriptionId: "sub_acme" }];
    expect((await lastReports(env.DB, subscription)).get("stripe:sub_acme")).toBeUndefined();
    await pass(END - HOUR, async () => 25, { stripe: recorder() });
    const last = (await lastReports(env.DB, subscription)).get("stripe:sub_acme");
    expect(last?.quantity).toBe(25);
    expect(last?.reportedAt.getTime()).toBe(END - HOUR);
  });
});

describe("daily-peak", () => {
  const DAY_ONE = Date.parse("2026-10-10T00:00:00.000Z");

  test("the value reported for a day is the highest the resolver answered that day", async () => {
    await period({
      subject: ACME,
      rail: "stripe",
      product: "coaching",
      subscription: "sub_coach",
      start: START,
      end: END,
    });
    const stripe = recorder();
    const answers = [5, 9, 4];
    for (const [index, hour] of [9, 13, 18].entries()) {
      const answer = answers[index];
      await pass(DAY_ONE + hour * HOUR, async () => answer, { stripe });
    }
    // Nothing is sent while the day is open — the peak is not final until it is over.
    expect(stripe.calls).toEqual([]);
    await pass(DAY_ONE + DAY + HOUR, async () => 2, { stripe });
    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0]).toMatchObject({ period: utcDay(new Date(DAY_ONE)), quantity: 9 });
    // Dated inside the day it bills.
    expect(utcDay(stripe.calls[0]?.at as Date)).toBe("2026-10-10");
  });

  test("two products with different cadences each report on their own schedule", async () => {
    await period({
      subject: ACME,
      rail: "stripe",
      product: "academy_seats",
      subscription: "sub_seats",
      start: START,
      end: END,
    });
    await period({
      subject: ACME,
      rail: "stripe",
      product: "coaching",
      subscription: "sub_coach",
      start: START,
      end: END,
    });
    const stripe = recorder();
    const resolve: PaymentsQuantityResolver = async (context) => (context.productId === "coaching" ? 3 : 25);
    // A mid-period day: the coaching product samples and later reports; the seats product waits.
    await pass(DAY_ONE + 12 * HOUR, resolve, { stripe });
    await pass(DAY_ONE + DAY + 12 * HOUR, resolve, { stripe });
    expect(stripe.calls.map((call) => call.billing.stripe?.meterEventName)).toEqual(["academy_coaches"]);
    // And the period's last day reports the seats product once.
    await pass(END - HOUR, resolve, { stripe });
    const seats = stripe.calls.filter((call) => call.billing.stripe?.meterEventName === "academy_students");
    expect(seats).toHaveLength(1);
  });
});

describe("what the pass never does", () => {
  test("a resolver answering undefined reports nothing — never 0 — and is counted as skipped", async () => {
    await period({
      subject: ACME,
      rail: "stripe",
      product: "academy_seats",
      subscription: "sub_acme",
      start: START,
      end: END,
    });
    const stripe = recorder();
    const logs: LogRecord[] = [];
    const tally = await pass(END - HOUR, async () => undefined, { stripe }, logs);
    expect(stripe.calls).toEqual([]);
    expect(tally).toMatchObject({ skipped: 1, reported: 0 });
    expect(logs.some((record) => record.msg === "usage not reported")).toBe(true);
  });

  test("an answer outside min and max, a non-integer, or a negative is skipped and named — never clamped", async () => {
    for (const [index, answer] of [0, 501, 2.5, -3].entries()) {
      await period({
        subject: { subjectType: "organization", subjectId: `org${index}` },
        rail: "stripe",
        product: "academy_seats",
        subscription: `sub_${index}`,
        start: START,
        end: END,
      });
      void answer;
    }
    const answers: Record<string, number> = { org0: 0, org1: 501, org2: 2.5, org3: -3 };
    const stripe = recorder();
    const tally = await pass(END - HOUR, async (_context, subject) => answers[subject.subjectId], { stripe });
    expect(stripe.calls).toEqual([]);
    expect(tally.invalid).toBe(4);
    expect(tally.findings.map((finding) => [finding.subjectId, finding.reason]).sort()).toEqual([
      ["org0", "below_min"],
      ["org1", "above_max"],
      ["org2", "not_integer"],
      ["org3", "negative"],
    ]);
  });

  test("a resolver that throws for one subject does not stop the sweep, and the tally names it", async () => {
    await period({
      subject: ACME,
      rail: "stripe",
      product: "academy_seats",
      subscription: "sub_acme",
      start: START,
      end: END,
    });
    await period({
      subject: GLOBEX,
      rail: "stripe",
      product: "academy_seats",
      subscription: "sub_globex",
      start: START,
      end: END,
    });
    const stripe = recorder();
    const tally = await pass(
      END - HOUR,
      async (_context, subject) => {
        if (subject.subjectId === "acme") throw new Error("the adopter's table is gone");
        return 12;
      },
      { stripe },
    );
    expect(tally).toMatchObject({ failed: 1, reported: 1 });
    expect(tally.findings).toEqual([{ ...ACME, productId: "academy_seats", reason: "resolver_failed" }]);
    expect(stripe.calls.map((call) => call.providerSubscriptionId)).toEqual(["sub_globex"]);
  });

  test("no meter's count reaches a rail — the payload derives only from resolveQuantity", async () => {
    // A counter row a careless join would pick up: the subject has sent 999 emails this period.
    await env.DB.prepare(
      "INSERT INTO pithy_payments_meter_counters (id, subject_type, subject_id, meter, period_start, used, created_at, updated_at) VALUES ('c1', 'organization', 'acme', 'emails', ?, 999, 0, 0)",
    )
      .bind(START)
      .run();
    await period({
      subject: ACME,
      rail: "stripe",
      product: "academy_seats",
      subscription: "sub_acme",
      start: START,
      end: END,
    });
    const stripe = recorder();
    await pass(END - HOUR, async () => 7, { stripe });
    expect(stripe.calls.map((call) => call.quantity)).toEqual([7]);
  });

  test("every run is recorded with its tally, including a run that reported nothing", async () => {
    const stripe = recorder();
    const tally = await pass(START, async () => 1, { stripe });
    const row = await env.DB.prepare("SELECT * FROM pithy_payments_usage_runs WHERE id = ?").bind(tally.id).first<{
      scanned: number;
      findings: string;
    }>();
    expect(row?.scanned).toBe(0);
    expect(JSON.parse(row?.findings ?? "null")).toEqual([]);
  });
});
