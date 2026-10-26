// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { MAX_BOUND_PARAMETERS, recordBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { MAX_PAGE_SIZE } from "@pithy-sh/core/src/data/cursor";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { PaymentsOverride } from "../data/override";
import type { PaymentsSubject } from "../data/subject";
import {
  PAYMENTS_OVERRIDES_TABLE,
  PAYMENTS_USAGE_REPORTS_TABLE,
  PAYMENTS_WEBHOOK_EVENTS_TABLE,
  paymentsDatabase,
} from "../data/tables";
import { PaymentsUsageReport } from "../data/usageReport";
import { PaymentsWebhookEvent, type PaymentsWebhookEventTargets, webhookEventReadState } from "../data/webhookEvent";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { payments_0002_allowances } from "../migrations/0002_allowances";
import { payments_0003_webhook_targets } from "../migrations/0003_webhook_targets";
import { lastReports, listWebhookEvents, unrestrictedSubjects } from "./read";

/**
 * The two per-page reads the admin listings make beside a page: which of its subjects are unrestricted, and
 * each subscription's last reported count. A page is up to `MAX_PAGE_SIZE` rows, and each read binds one id
 * per row plus a fixed filter — so a full page is exactly the case that crosses D1's cap of 100.
 */

const AT = new Date("2026-10-05T09:00:00.000Z");

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
  await payments_0003_webhook_targets.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

const subjects: PaymentsSubject[] = Array.from({ length: MAX_PAGE_SIZE }, (_, index) => ({
  subjectType: "organization",
  subjectId: `org-${String(index).padStart(3, "0")}`,
}));

describe("unrestrictedSubjects", () => {
  test("a full page of subjects stays under D1's cap and loses no subject across the chunks", async () => {
    // Every other subject is unrestricted, so a dropped chunk would show as a missing one.
    const db = paymentsDatabase(env.DB);
    for (const [index, subject] of subjects.entries()) {
      await db
        .insertInto(PAYMENTS_OVERRIDES_TABLE)
        .values(
          PaymentsOverride.encode({
            id: crypto.randomUUID(),
            ...subject,
            unrestricted: index % 2 === 0,
            quotas: index % 2 === 0 ? {} : { emails: 10 },
            features: {},
            version: 1,
            reason: "A contract.",
            createdAt: AT,
            updatedAt: AT,
          }),
        )
        .execute();
    }

    let found = new Set<string>();
    const recording = await recordBoundParameters(env.DB, async (d1) => {
      found = await unrestrictedSubjects(d1, subjects);
    });
    if (recording.error) throw recording.error;

    for (const count of recording.counts) expect(count).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
    expect(found.size).toBe(MAX_PAGE_SIZE / 2);
    expect(found.has("organization:org-000")).toBe(true);
    expect(found.has("organization:org-098")).toBe(true);
    expect(found.has("organization:org-099")).toBe(false);
  });
});

describe("lastReports", () => {
  test("a full page of subscriptions stays under D1's cap and finds every one's newest report", async () => {
    const db = paymentsDatabase(env.DB);
    const subscriptions = subjects.map((_, index) => ({
      rail: "stripe" as const,
      providerSubscriptionId: `sub_${String(index).padStart(3, "0")}`,
    }));
    for (const [index, subject] of subjects.entries()) {
      for (const [offset, quantity] of [
        [0, index],
        [60_000, index + 1000],
      ] as const) {
        const reportedAt = new Date(AT.getTime() + offset);
        await db
          .insertInto(PAYMENTS_USAGE_REPORTS_TABLE)
          .values(
            PaymentsUsageReport.encode({
              id: crypto.randomUUID(),
              rail: "stripe",
              providerSubscriptionId: `sub_${String(index).padStart(3, "0")}`,
              purchaseId: `purchase-${index}-${offset}`,
              productId: "academy_seats",
              ...subject,
              cadence: "period-end",
              period: reportedAt.toISOString(),
              quantity,
              status: "reported",
              sampledAt: reportedAt,
              reportedAt,
              createdAt: reportedAt,
              updatedAt: reportedAt,
            }),
          )
          .execute();
      }
    }

    let latest = new Map<string, { quantity: number; reportedAt: Date }>();
    const recording = await recordBoundParameters(env.DB, async (d1) => {
      latest = await lastReports(d1, subscriptions);
    });
    if (recording.error) throw recording.error;

    for (const count of recording.counts) expect(count).toBeLessThanOrEqual(MAX_BOUND_PARAMETERS);
    expect(latest.size).toBe(MAX_PAGE_SIZE);
    expect(latest.get("stripe:sub_000")?.quantity).toBe(1000);
    expect(latest.get("stripe:sub_099")?.quantity).toBe(1099);
  });
});

/**
 * The webhook-event read (#830): every notification a store sent, newest received first, with the state it is
 * in and the type the store gave it — and never the payload it was read from.
 */
describe("listWebhookEvents", () => {
  /** One recorded delivery. Timestamps are minutes after `AT`, so the order a case asserts is the one it wrote. */
  async function event(options: {
    id: string;
    rail?: "apple" | "google" | "stripe" | "lemonSqueezy" | "paddle";
    minute: number;
    payload?: Record<string, unknown>;
    processed?: boolean;
    abandoned?: boolean;
    error?: string | null;
    attempts?: number;
    targets?: PaymentsWebhookEventTargets | null;
  }): Promise<void> {
    const at = new Date(AT.getTime() + options.minute * 60_000);
    await paymentsDatabase(env.DB)
      .insertInto(PAYMENTS_WEBHOOK_EVENTS_TABLE)
      .values(
        PaymentsWebhookEvent.encode({
          id: options.id,
          rail: options.rail ?? "stripe",
          providerEventId: `evt_${options.id}`,
          payload: options.payload ?? { type: "invoice.paid", customer_email: "ada@example.com" },
          receivedAt: at,
          processedAt: options.processed ? at : null,
          abandonedAt: options.abandoned ? at : null,
          error: options.error ?? null,
          attempts: options.attempts ?? 0,
          projectedTargets: options.targets ?? null,
          createdAt: at,
        }),
      )
      .execute();
  }

  test("newest received first, keyset-paged on the id, every page whole", async () => {
    for (let minute = 0; minute < 5; minute += 1) await event({ id: `e${minute}`, minute, processed: true });
    const first = await listWebhookEvents(env.DB, { limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual(["e4", "e3"]);
    const second = await listWebhookEvents(env.DB, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((row) => row.id)).toEqual(["e2", "e1"]);
    const last = await listWebhookEvents(env.DB, { limit: 2, cursor: second.nextCursor ?? undefined });
    expect(last.items.map((row) => row.id)).toEqual(["e0"]);
    expect(last.nextCursor).toBeNull();
  });

  test("filters by rail, by state, and by a received window — inclusive start, exclusive end", async () => {
    await event({ id: "projected", minute: 0, processed: true });
    await event({ id: "pending", minute: 1 });
    await event({ id: "failed", minute: 2, error: "payments/product_not_found: no product", attempts: 2 });
    await event({ id: "abandoned", minute: 3, abandoned: true, error: "quarantined: after 3 attempts" });
    await event({ id: "apple", rail: "apple", minute: 4, payload: { notificationType: "DID_RENEW" } });

    expect((await listWebhookEvents(env.DB, { rail: "apple" })).items.map((row) => row.id)).toEqual(["apple"]);
    expect((await listWebhookEvents(env.DB, { state: "projected" })).items.map((row) => row.id)).toEqual(["projected"]);
    // Pending is every event not finished and not given up on: never tried, and tried and failed alike.
    expect((await listWebhookEvents(env.DB, { state: "pending" })).items.map((row) => row.id)).toEqual([
      "apple",
      "failed",
      "pending",
    ]);
    expect((await listWebhookEvents(env.DB, { state: "abandoned" })).items.map((row) => row.id)).toEqual(["abandoned"]);
    const window = await listWebhookEvents(env.DB, {
      since: new Date(AT.getTime() + 60_000),
      until: new Date(AT.getTime() + 3 * 60_000),
    });
    expect(window.items.map((row) => row.id)).toEqual(["failed", "pending"]);
  });

  test("the SQL state filter and the row's own classification agree on every row", async () => {
    // Two spellings of one question — a `where` the page can afford and the derivation the view renders — so
    // they are held to each other over every shape a row takes, including a finish after an abandonment.
    await event({ id: "a", minute: 0 });
    await event({ id: "b", minute: 1, error: "projection failed", attempts: 1 });
    await event({ id: "c", minute: 2, abandoned: true, error: "orphaned: nobody" });
    await event({ id: "d", minute: 3, processed: true });
    await event({ id: "e", minute: 4, processed: true, abandoned: true });
    const listed: string[] = [];
    const byState: Record<string, string[]> = {};
    for (const state of ["projected", "pending", "abandoned"] as const) {
      const page = await listWebhookEvents(env.DB, { state });
      // One direction: every row a filter returns classifies as that filter's state.
      for (const row of page.items) expect(webhookEventReadState(row), row.id).toBe(state);
      byState[state] = page.items.map((row) => row.id);
      listed.push(...byState[state]);
    }
    // The other: every row comes back under exactly one filter — none dropped from all three, none in two.
    expect([...listed].sort()).toEqual(["a", "b", "c", "d", "e"]);
    // The case this test exists for: finished after an abandonment is projected, and listed there.
    expect(byState.projected).toContain("e");
  });

  test("names each store's event type, read out of the payload by the database", async () => {
    await event({ id: "stripe", rail: "stripe", minute: 0, payload: { type: "customer.subscription.updated" } });
    await event({ id: "paddle", rail: "paddle", minute: 1, payload: { event_type: "subscription.activated" } });
    await event({
      id: "lemon",
      rail: "lemonSqueezy",
      minute: 2,
      payload: { meta: { event_name: "subscription_payment_refunded" } },
    });
    await event({
      id: "apple",
      rail: "apple",
      minute: 3,
      payload: { notificationType: "DID_FAIL_TO_RENEW", subtype: "GRACE_PERIOD" },
    });
    await event({ id: "apple-bare", rail: "apple", minute: 4, payload: { notificationType: "DID_RENEW" } });
    await event({
      id: "google",
      rail: "google",
      minute: 5,
      payload: { notification: { subscriptionNotification: { notificationType: 2 } } },
    });
    await event({
      id: "google-voided",
      rail: "google",
      minute: 6,
      payload: { notification: { voidedPurchaseNotification: { orderId: "GPA.1" } } },
    });
    await event({ id: "google-test", rail: "google", minute: 7, payload: { notification: { testNotification: {} } } });
    await event({ id: "nothing", rail: "stripe", minute: 8, payload: { id: "evt_1" } });

    const types = Object.fromEntries((await listWebhookEvents(env.DB, {})).items.map((row) => [row.id, row.eventType]));
    expect(types).toEqual({
      stripe: "customer.subscription.updated",
      paddle: "subscription.activated",
      lemon: "subscription_payment_refunded",
      apple: "DID_FAIL_TO_RENEW.GRACE_PERIOD",
      "apple-bare": "DID_RENEW",
      google: "subscription.2",
      "google-voided": "voidedPurchase",
      "google-test": "test",
      nothing: null,
    });
  });

  test("an event type that is not a vocabulary word is not passed through", async () => {
    // The type is the store's, signed, but it is still text from outside — and the one string this read lifts
    // out of a payload. Anything that is not the shape of an event name is withheld rather than echoed.
    await event({ id: "long", minute: 0, payload: { type: "x".repeat(200) } });
    await event({ id: "spaced", minute: 1, payload: { type: "ada@example.com wrote this" } });
    await event({ id: "number", minute: 2, payload: { type: 42 } });
    const types = (await listWebhookEvents(env.DB, {})).items.map((row) => row.eventType);
    expect(types).toEqual([null, null, null]);
  });

  test("never loads the payload, and carries the recorded targets as they were written", async () => {
    const targets = { purchaseIds: ["p1"], subscriptionIds: ["s1"] };
    await event({ id: "with", minute: 0, processed: true, targets });
    await event({ id: "older", minute: 1, processed: true });
    const rows = (await listWebhookEvents(env.DB, {})).items;
    for (const row of rows) expect(row).not.toHaveProperty("payload");
    expect(rows.find((row) => row.id === "with")?.projectedTargets).toEqual(targets);
    expect(rows.find((row) => row.id === "older")?.projectedTargets).toBeNull();
  });
});
