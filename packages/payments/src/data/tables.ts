// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import type { z } from "zod";
import { PaymentsEntitlement } from "./entitlement";
import { PaymentsMeterCounter } from "./meterCounter";
import { PaymentsOverride } from "./override";
import { PaymentsProviderAccount } from "./providerAccount";
import { PaymentsPurchase } from "./purchase";
import { PaymentsReconcileRun } from "./reconcileRun";
import { PaymentsSyncCursor } from "./syncCursor";
import { PaymentsUsageReport } from "./usageReport";
import { PaymentsUsageRun } from "./usageRun";
import { PaymentsWebhookEvent } from "./webhookEvent";

/** The projection of provider truth. `CamelCasePlugin` snake-cases it to `pithy_payments_purchases`. */
export const PAYMENTS_PURCHASES_TABLE = "pithyPaymentsPurchases";
/** The materialized read model `requireEntitlement()` hits. → `pithy_payments_entitlements`. */
export const PAYMENTS_ENTITLEMENTS_TABLE = "pithyPaymentsEntitlements";
/** Provider identity → the subject that holds it. → `pithy_payments_provider_accounts`. */
export const PAYMENTS_PROVIDER_ACCOUNTS_TABLE = "pithyPaymentsProviderAccounts";
/** Raw received notifications, the replay source. → `pithy_payments_webhook_events`. */
export const PAYMENTS_WEBHOOK_EVENTS_TABLE = "pithyPaymentsWebhookEvents";
/** One row per reconciliation pass — the tally, kept. → `pithy_payments_reconcile_runs`. */
export const PAYMENTS_RECONCILE_RUNS_TABLE = "pithyPaymentsReconcileRuns";
/** Where a resumable sweep of a provider's stream left off. → `pithy_payments_sync_cursors`. */
export const PAYMENTS_SYNC_CURSORS_TABLE = "pithyPaymentsSyncCursors";
/** One subject's allowance override. → `pithy_payments_overrides`. */
export const PAYMENTS_OVERRIDES_TABLE = "pithyPaymentsOverrides";
/** One subject's use of one kit meter in one period. → `pithy_payments_meter_counters`. */
export const PAYMENTS_METER_COUNTERS_TABLE = "pithyPaymentsMeterCounters";
/** One reported period of one quantity-billed subscription. → `pithy_payments_usage_reports`. */
export const PAYMENTS_USAGE_REPORTS_TABLE = "pithyPaymentsUsageReports";
/** One usage-reporting pass — the tally, kept. → `pithy_payments_usage_runs`. */
export const PAYMENTS_USAGE_RUNS_TABLE = "pithyPaymentsUsageRuns";

/** The payments tables map. All ten are always present — none is behind a config flag. */
export function paymentsTables(): Record<string, z.ZodObject> {
  return {
    [PAYMENTS_PURCHASES_TABLE]: PaymentsPurchase,
    [PAYMENTS_ENTITLEMENTS_TABLE]: PaymentsEntitlement,
    [PAYMENTS_PROVIDER_ACCOUNTS_TABLE]: PaymentsProviderAccount,
    [PAYMENTS_WEBHOOK_EVENTS_TABLE]: PaymentsWebhookEvent,
    [PAYMENTS_RECONCILE_RUNS_TABLE]: PaymentsReconcileRun,
    [PAYMENTS_SYNC_CURSORS_TABLE]: PaymentsSyncCursor,
    [PAYMENTS_OVERRIDES_TABLE]: PaymentsOverride,
    [PAYMENTS_METER_COUNTERS_TABLE]: PaymentsMeterCounter,
    [PAYMENTS_USAGE_REPORTS_TABLE]: PaymentsUsageReport,
    [PAYMENTS_USAGE_RUNS_TABLE]: PaymentsUsageRun,
  };
}

/** The typed Kysely database over the payments tables. */
export type PaymentsTables = {
  [PAYMENTS_PURCHASES_TABLE]: typeof PaymentsPurchase;
  [PAYMENTS_ENTITLEMENTS_TABLE]: typeof PaymentsEntitlement;
  [PAYMENTS_PROVIDER_ACCOUNTS_TABLE]: typeof PaymentsProviderAccount;
  [PAYMENTS_WEBHOOK_EVENTS_TABLE]: typeof PaymentsWebhookEvent;
  [PAYMENTS_RECONCILE_RUNS_TABLE]: typeof PaymentsReconcileRun;
  [PAYMENTS_SYNC_CURSORS_TABLE]: typeof PaymentsSyncCursor;
  [PAYMENTS_OVERRIDES_TABLE]: typeof PaymentsOverride;
  [PAYMENTS_METER_COUNTERS_TABLE]: typeof PaymentsMeterCounter;
  [PAYMENTS_USAGE_REPORTS_TABLE]: typeof PaymentsUsageReport;
  [PAYMENTS_USAGE_RUNS_TABLE]: typeof PaymentsUsageRun;
};
export type PaymentsDatabase = Kysely<DatabaseSchema<PaymentsTables>>;

/** Build the payments database from the `DB` binding (CamelCasePlugin installed). */
export function paymentsDatabase(d1: D1Database): PaymentsDatabase {
  return createDatabase(d1, {
    [PAYMENTS_PURCHASES_TABLE]: PaymentsPurchase,
    [PAYMENTS_ENTITLEMENTS_TABLE]: PaymentsEntitlement,
    [PAYMENTS_PROVIDER_ACCOUNTS_TABLE]: PaymentsProviderAccount,
    [PAYMENTS_WEBHOOK_EVENTS_TABLE]: PaymentsWebhookEvent,
    [PAYMENTS_RECONCILE_RUNS_TABLE]: PaymentsReconcileRun,
    [PAYMENTS_SYNC_CURSORS_TABLE]: PaymentsSyncCursor,
    [PAYMENTS_OVERRIDES_TABLE]: PaymentsOverride,
    [PAYMENTS_METER_COUNTERS_TABLE]: PaymentsMeterCounter,
    [PAYMENTS_USAGE_REPORTS_TABLE]: PaymentsUsageReport,
    [PAYMENTS_USAGE_RUNS_TABLE]: PaymentsUsageRun,
  }) as unknown as PaymentsDatabase;
}
