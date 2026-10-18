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
import { PAYMENTS_OVERRIDES_TABLE, PAYMENTS_USAGE_REPORTS_TABLE, paymentsDatabase } from "../data/tables";
import { PaymentsUsageReport } from "../data/usageReport";
import { payments_0001_purchases } from "../migrations/0001_purchases";
import { payments_0002_allowances } from "../migrations/0002_allowances";
import { lastReports, unrestrictedSubjects } from "./read";

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
