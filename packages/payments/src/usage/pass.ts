// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { messageOf } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { sql } from "kysely";
import { type PaymentsConfig, type PaymentsReportedBilling, reportedProducts } from "../config/config";
import { knownPeriodStart } from "../data/period";
import { PaymentsPurchase } from "../data/purchase";
import { grantingStatuses } from "../data/status";
import { encodeSubjectReference, type PaymentsSubject } from "../data/subject";
import {
  PAYMENTS_PURCHASES_TABLE,
  PAYMENTS_USAGE_REPORTS_TABLE,
  PAYMENTS_USAGE_RUNS_TABLE,
  type PaymentsDatabase,
  paymentsDatabase,
} from "../data/tables";
import { PaymentsUsageReport } from "../data/usageReport";
import { MAX_USAGE_FINDINGS, PaymentsUsageRun, type UsageFinding, type UsageFindingReason } from "../data/usageRun";
import { providerAccountForSubject } from "../projection/owner";
import type { UsageReporter } from "./reporter";

/**
 * The usage-reporting pass: ask the adopter how many, and tell the store.
 *
 * **Configuration decides what is billable and how often; a function decides the number.** The same split
 * as `billingSubject` / `resolveSubject`, for the same reason — `PaymentsConfig` round-trips through JSON, so
 * a function cannot live in it. `resolveQuantity` rides on the `payments(...)` options and reaches this pass
 * through the composed capability, never through config.
 *
 * **Pulled, not pushed.** A cron walks the subscribed subjects and reports, the shape the reconcile pass
 * already has. No proration, no mid-cycle rewrite of a subscription's items, and a missed report bills last
 * period's number rather than the wrong number indefinitely.
 *
 * ## What it never does
 *
 * - **Report a guess.** A resolver answering `undefined` reports nothing for that subject, and is counted as
 *   skipped — never `0`, because a zeroed meter is a bill of nothing for a customer who owes something. A
 *   non-integer, a negative, or a count outside the product's `min`/`max` is skipped and named — never
 *   clamped, because a clamped value is a wrong number billed silently.
 * - **Stop for one subject.** A resolver that throws is a failure in the tally, and the sweep goes on.
 * - **Report a period twice.** One row per `(rail, subscription, period)`, claimed before the store is
 *   called, and the row id sent as the store's idempotency key.
 * - **Read a meter.** The kit does not sell overage. What a kit meter counted is never a billable number,
 *   and nothing here imports one.
 *
 * ## The two cadences
 *
 * - `period-end` — one report per subscription per billing period, keyed on the period's end and sent on
 *   the first run inside its last {@link PERIOD_END_WINDOW_MS}, dated at that run. Every later run in the
 *   period finds the row.
 * - `daily-peak` — every run asks, and the day's row keeps the highest answer; a lower later answer never
 *   lowers it. **A day is never sent on its own.** The period's report is the highest of its days, sent once,
 *   in the period's last {@link PERIOD_END_WINDOW_MS} — keyed and dated exactly as a `period-end` report.
 *   Both stores add up what they are sent: Stripe's meter sums its events, and every Paddle charge is a line
 *   on the bill. A report per day would bill the sum of thirty daily peaks, not the period's peak. The day
 *   rows stay behind, and they are the audit: the number billed is the largest of them up to the report.
 *
 * A `daily-peak` report goes out when the last day opens, as a `period-end` one does, so a peak reached in
 * the period's final hours after it was sent is not billed. Under-billing an hour is the right way round.
 */

/** How close to a period's end a `period-end` report goes out. A day, so an hourly or daily cron lands inside it. */
export const PERIOD_END_WINDOW_MS = 86_400_000;

/** How long after a period's end its subscription is still reported — a run that missed the window by a little. */
const LATE_WINDOW_MS = 86_400_000;

/** What `resolveQuantity` is told besides who: the env, the product, and when. */
export interface PaymentsQuantityContext {
  /** The worker env — the adopter's bindings, for counting their own rows. */
  env: Record<string, unknown>;
  /** The quantity-billed product being reported. */
  productId: string;
  /** What one unit is, from the product's `billing.unit`. */
  unit: string;
  /** The run's clock. */
  now: Date;
}

/**
 * The adopter's count for one subject — students, coaches, seats. `undefined` reports nothing this period.
 *
 * Called with no request: the pass runs on a schedule. So it is handed the env, not a Hono context, and counts
 * from the adopter's own rows. Payments never counts members.
 */
export type PaymentsQuantityResolver = (
  context: PaymentsQuantityContext,
  subject: PaymentsSubject,
) => Promise<number | undefined>;

/** What one pass needs. */
export interface UsagePassDeps {
  /** The app database. */
  d1: D1Database;
  /** The resolved config. */
  config: PaymentsConfig;
  /** The adopter's resolver. */
  resolveQuantity: PaymentsQuantityResolver;
  /** One reporter per rail this pass may report on. A rail with none is counted as a failure per period. */
  reporters: Partial<Record<"stripe" | "paddle", UsageReporter>>;
  /** The env handed to the resolver. */
  env: Record<string, unknown>;
  /** The clock. */
  now: () => Date;
  /** Where every skip and failure is logged. */
  log: Logger;
  /** The id minter. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

/** The tally one pass records. */
export interface UsagePassTally {
  /** The run's id. */
  id: string;
  /** Subscriptions examined. */
  scanned: number;
  /** Periods a store accepted. */
  reported: number;
  /** Daily-peak samples taken. */
  sampled: number;
  /** Periods found already reported, so nothing was sent. */
  alreadyReported: number;
  /** Subjects whose resolver answered nothing. */
  skipped: number;
  /** Subjects whose resolver answered a number that may not be billed. */
  invalid: number;
  /** Subjects whose resolver threw, or whose report a store refused. */
  failed: number;
  /** The subjects not reported, and why, up to {@link MAX_USAGE_FINDINGS}. */
  findings: UsageFinding[];
}

/** One subscription's current period, as the purchases table holds it. */
interface CurrentPeriod {
  purchase: PaymentsPurchase;
  providerSubscriptionId: string;
  periodEnd: Date;
}

/** Whether a resolver's answer may be billed, and if not, why. */
export function judgeQuantity(
  answer: unknown,
  billing: Pick<PaymentsReportedBilling, "min" | "max">,
): { ok: true; quantity: number } | { ok: false; reason: UsageFindingReason } {
  if (answer === undefined) return { ok: false, reason: "unanswered" };
  if (typeof answer !== "number" || !Number.isInteger(answer)) return { ok: false, reason: "not_integer" };
  if (answer < 0) return { ok: false, reason: "negative" };
  if (answer < billing.min) return { ok: false, reason: "below_min" };
  if (answer > billing.max) return { ok: false, reason: "above_max" };
  return { ok: true, quantity: answer };
}

/** The UTC day `at` falls in, as `YYYY-MM-DD`. A `daily-peak` period's key. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Every subscription of one product on one rail whose current period is live, or ended within the late
 * window — newest period per subscription, because each billing period is its own purchase row.
 */
async function currentPeriods(
  db: PaymentsDatabase,
  config: PaymentsConfig,
  productId: string,
  rail: "stripe" | "paddle",
  now: Date,
): Promise<CurrentPeriod[]> {
  const at = now.getTime();
  const rows = await db
    .selectFrom(PAYMENTS_PURCHASES_TABLE)
    .selectAll()
    .where("productId", "=", productId)
    .where("rail", "=", rail)
    .where("type", "=", "subscription")
    .where("status", "in", grantingStatuses(config.graceGrantsAccess))
    // biome-ignore lint/suspicious/noExplicitAny: ms-epoch numbers against the encoded columns.
    .where("purchasedAt", "<=", at as any)
    // biome-ignore lint/suspicious/noExplicitAny: as above.
    .where("expiresAt", ">", (at - LATE_WINDOW_MS) as any)
    .orderBy("purchasedAt", "desc")
    .execute();
  const newest = new Map<string, CurrentPeriod>();
  for (const row of rows) {
    const purchase = PaymentsPurchase.parse(row);
    const subscription = purchase.originalTransactionId;
    if (subscription === null || purchase.expiresAt === null || newest.has(subscription)) continue;
    newest.set(subscription, {
      purchase,
      providerSubscriptionId: subscription,
      periodEnd: purchase.expiresAt,
    });
  }
  return [...newest.values()];
}

/** One period's row, if there is one. */
async function readReport(
  db: PaymentsDatabase,
  rail: string,
  subscription: string,
  period: string,
): Promise<PaymentsUsageReport | undefined> {
  const row = await db
    .selectFrom(PAYMENTS_USAGE_REPORTS_TABLE)
    .selectAll()
    .where("rail", "=", rail as "stripe")
    .where("providerSubscriptionId", "=", subscription)
    .where("period", "=", period)
    .executeTakeFirst();
  return row === undefined ? undefined : PaymentsUsageReport.parse(row);
}

/** Run one pass, record its tally, and return it. */
export async function runUsageReport(deps: UsagePassDeps): Promise<UsagePassTally> {
  const db = paymentsDatabase(deps.d1);
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const startedAt = deps.now();
  const tally: UsagePassTally = {
    id: newId(),
    scanned: 0,
    reported: 0,
    sampled: 0,
    alreadyReported: 0,
    skipped: 0,
    invalid: 0,
    failed: 0,
    findings: [],
  };

  const note = (subject: PaymentsSubject, productId: string, reason: UsageFindingReason): void => {
    if (reason === "unanswered") tally.skipped++;
    else if (reason === "resolver_failed" || reason === "report_failed") tally.failed++;
    else tally.invalid++;
    if (tally.findings.length < MAX_USAGE_FINDINGS) tally.findings.push({ ...subject, productId, reason });
    deps.log.warn("usage not reported", { subject: encodeSubjectReference(subject), productId, reason });
  };

  /** Ask the resolver, and judge the answer. Undefined when nothing may be billed — already noted. */
  const ask = async (period: CurrentPeriod, productId: string, billing: PaymentsReportedBilling, now: Date) => {
    const subject: PaymentsSubject = { subjectType: period.purchase.subjectType, subjectId: period.purchase.subjectId };
    let answer: unknown;
    try {
      answer = await deps.resolveQuantity({ env: deps.env, productId, unit: billing.unit, now }, subject);
    } catch (error) {
      deps.log.error("usage resolver failed", {
        subject: encodeSubjectReference(subject),
        productId,
        cause: messageOf(error),
      });
      note(subject, productId, "resolver_failed");
      return undefined;
    }
    const judged = judgeQuantity(answer, billing);
    if (!judged.ok) {
      note(subject, productId, judged.reason);
      return undefined;
    }
    return judged.quantity;
  };

  /** Send one claimed row to its store, and settle the row either way. */
  const send = async (
    period: CurrentPeriod,
    productId: string,
    billing: PaymentsReportedBilling,
    report: PaymentsUsageReport,
    at: Date,
  ): Promise<void> => {
    const rail = period.purchase.rail as "stripe" | "paddle";
    const subject: PaymentsSubject = { subjectType: period.purchase.subjectType, subjectId: period.purchase.subjectId };
    const reporter = deps.reporters[rail];
    try {
      if (reporter === undefined) throw new Error(`no ${rail} reporter is configured for this pass`);
      await reporter.report({
        providerSubscriptionId: period.providerSubscriptionId,
        providerCustomerId: rail === "stripe" ? await providerAccountForSubject(db, "stripe", subject) : undefined,
        quantity: report.quantity,
        period: report.period,
        at,
        billing,
        idempotencyKey: `usage_${report.id}`,
      });
    } catch (error) {
      deps.log.error("usage report failed", {
        subject: encodeSubjectReference(subject),
        productId,
        rail,
        period: report.period,
        cause: messageOf(error),
      });
      // Left claimed, so the next run sends it again under the same key. The failure may have been the
      // answer going missing rather than the call, and the store records one key once.
      note(subject, productId, "report_failed");
      return;
    }
    const now = deps.now().getTime();
    await withD1Retry(() =>
      db
        .updateTable(PAYMENTS_USAGE_REPORTS_TABLE)
        // biome-ignore lint/suspicious/noExplicitAny: the SQLite row shape.
        .set({ status: "reported", reportedAt: now, updatedAt: now } as any)
        .where("id", "=", report.id)
        .execute(),
    );
    tally.reported++;
  };

  for (const { id: productId, billing } of reportedProducts(deps.config)) {
    for (const rail of billing.rails) {
      if (rail !== "stripe" && rail !== "paddle") continue;
      const now = deps.now();
      for (const period of await currentPeriods(db, deps.config, productId, rail, now)) {
        tally.scanned++;
        if (billing.cadence === "period-end") {
          await periodEnd(period, productId, billing, now);
        } else {
          await dailyPeak(period, productId, billing, now);
        }
      }
    }
  }

  /** `period-end`: inside the window, once per period. */
  async function periodEnd(
    period: CurrentPeriod,
    productId: string,
    billing: PaymentsReportedBilling,
    now: Date,
  ): Promise<void> {
    if (now.getTime() < period.periodEnd.getTime() - PERIOD_END_WINDOW_MS) return;
    // Keyed on the period's end, which every rail's row states and every renewal moves — where the start is
    // a column only some rails keep current (`data/period.ts`).
    const key = period.periodEnd.toISOString();
    const existing = await readReport(db, period.purchase.rail, period.providerSubscriptionId, key);
    if (existing?.status === "reported") {
      tally.alreadyReported++;
      return;
    }
    // A claim left by a run that died between the store's answer and ours: send it again, under its own key.
    if (existing?.status === "claimed") {
      await send(period, productId, billing, existing, reportDate(period, now));
      return;
    }
    const quantity = await ask(period, productId, billing, now);
    if (quantity === undefined) return;
    const claimed = await claim(period, productId, billing, key, quantity, now, "claimed");
    if (claimed === undefined) {
      tally.alreadyReported++;
      return;
    }
    await send(period, productId, billing, claimed, reportDate(period, now));
  }

  /**
   * `daily-peak`: sample today, and in the period's last day report the highest day the period sampled.
   * Once per period, keyed on its end — the same row, key and date a `period-end` report has.
   */
  async function dailyPeak(
    period: CurrentPeriod,
    productId: string,
    billing: PaymentsReportedBilling,
    now: Date,
  ): Promise<void> {
    if (now.getTime() < period.periodEnd.getTime()) {
      const quantity = await ask(period, productId, billing, now);
      if (quantity !== undefined) {
        await sample(period, productId, billing, utcDay(now), quantity, now);
        tally.sampled++;
      }
    }
    if (now.getTime() < period.periodEnd.getTime() - PERIOD_END_WINDOW_MS) return;
    const key = period.periodEnd.toISOString();
    const existing = await readReport(db, period.purchase.rail, period.providerSubscriptionId, key);
    if (existing?.status === "reported") {
      tally.alreadyReported++;
      return;
    }
    if (existing?.status === "claimed") {
      await send(period, productId, billing, existing, reportDate(period, now));
      return;
    }
    // No day answered: the resolver's refusals were each noted when it was asked, and nothing is a guess.
    const peak = await periodPeak(period, key);
    if (peak === undefined) return;
    const claimed = await claim(period, productId, billing, key, peak, now, "claimed");
    if (claimed === undefined) {
      tally.alreadyReported++;
      return;
    }
    await send(period, productId, billing, claimed, reportDate(period, now));
  }

  /**
   * The highest day one period sampled, or undefined when it sampled none.
   *
   * **A period's days are the ones after the previous period's.** The lower bound is the later of the
   * period's start, where the row states one (`data/period.ts`), and the day the subscription's previous
   * report was keyed on — so a high day last period is never billed again this one, on a rail whose start
   * is not stored too. The day a renewal falls on belongs to both: its peak was reached in one of them.
   */
  async function periodPeak(period: CurrentPeriod, key: string): Promise<number | undefined> {
    const rail = period.purchase.rail as "stripe";
    const previous = await db
      .selectFrom(PAYMENTS_USAGE_REPORTS_TABLE)
      .select("period")
      .where("rail", "=", rail)
      .where("providerSubscriptionId", "=", period.providerSubscriptionId)
      // A period's report is the only row that is ever claimed or reported; a day only ever samples.
      .where("status", "in", ["claimed", "reported"])
      .where("period", "<", key)
      .orderBy("period", "desc")
      .limit(1)
      .executeTakeFirst();
    const bounds = [knownPeriodStart(period.purchase), previous && new Date(previous.period)]
      .filter((at): at is Date => at instanceof Date && !Number.isNaN(at.getTime()))
      .map(utcDay);
    let days = db
      .selectFrom(PAYMENTS_USAGE_REPORTS_TABLE)
      .select((eb) => eb.fn.max<number | null>("quantity").as("peak"))
      .where("rail", "=", rail)
      .where("providerSubscriptionId", "=", period.providerSubscriptionId)
      .where("status", "=", "sampling")
      .where("period", "<=", utcDay(period.periodEnd));
    const from = bounds.sort().at(-1);
    if (from !== undefined) days = days.where("period", ">=", from);
    const row = await days.executeTakeFirst();
    return row?.peak ?? undefined;
  }

  /** Write a period's row as claimed or sampling, or nothing when a row for it exists. */
  async function claim(
    period: CurrentPeriod,
    productId: string,
    billing: PaymentsReportedBilling,
    key: string,
    quantity: number,
    now: Date,
    status: "claimed" | "sampling",
  ): Promise<PaymentsUsageReport | undefined> {
    const record = PaymentsUsageReport.encode({
      id: newId(),
      rail: period.purchase.rail,
      providerSubscriptionId: period.providerSubscriptionId,
      purchaseId: period.purchase.id,
      productId,
      subjectType: period.purchase.subjectType,
      subjectId: period.purchase.subjectId,
      cadence: billing.cadence,
      period: key,
      quantity,
      status,
      sampledAt: now,
      reportedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const inserted = await db
      .insertInto(PAYMENTS_USAGE_REPORTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: the SQLite row shape.
      .values(record as any)
      .onConflict((oc) => oc.columns(["rail", "providerSubscriptionId", "period"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted === undefined) return undefined;
    return PaymentsUsageReport.parse(record);
  }

  /** Record a day's sample: the first of the day inserts, every later one keeps the higher. */
  async function sample(
    period: CurrentPeriod,
    productId: string,
    billing: PaymentsReportedBilling,
    day: string,
    quantity: number,
    now: Date,
  ): Promise<void> {
    const created = await claim(period, productId, billing, day, quantity, now, "sampling");
    if (created !== undefined) return;
    // The higher of the stored peak and this answer, inside the statement — two samples racing cannot lower it.
    const peak = {
      quantity: sql`max(${sql.ref("quantity")}, ${quantity})`,
      sampledAt: now.getTime(),
      updatedAt: now.getTime(),
    };
    await db
      .updateTable(PAYMENTS_USAGE_REPORTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: an expression and two encoded timestamps.
      .set(peak as any)
      .where("rail", "=", period.purchase.rail as "stripe")
      .where("providerSubscriptionId", "=", period.providerSubscriptionId)
      .where("period", "=", day)
      .where("status", "=", "sampling")
      .execute();
  }

  const finishedAt = deps.now();
  const run = PaymentsUsageRun.encode({
    id: tally.id,
    startedAt,
    finishedAt,
    scanned: tally.scanned,
    reported: tally.reported,
    sampled: tally.sampled,
    alreadyReported: tally.alreadyReported,
    skipped: tally.skipped,
    invalid: tally.invalid,
    failed: tally.failed,
    findings: tally.findings,
    createdAt: finishedAt,
  });
  await withD1Retry(() =>
    db
      .insertInto(PAYMENTS_USAGE_RUNS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side; Kysely's insert type derives from it.
      .values(run as any)
      .execute(),
  );
  deps.log.info("usage report finished", {
    run: tally.id,
    scanned: tally.scanned,
    reported: tally.reported,
    sampled: tally.sampled,
    alreadyReported: tally.alreadyReported,
    skipped: tally.skipped,
    invalid: tally.invalid,
    failed: tally.failed,
  });
  return tally;
}

/** A `period-end` report's date: the run's own, but never past the period's end — it bills that period. */
function reportDate(period: CurrentPeriod, now: Date): Date {
  return now.getTime() < period.periodEnd.getTime() ? now : new Date(period.periodEnd.getTime() - 1000);
}
