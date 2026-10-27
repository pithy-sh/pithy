// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { personRowsExport } from "@pithy-sh/core/src/capability/personRows";
import type { RetainingPurgeContribution } from "@pithy-sh/core/src/capability/purge";
import { PaymentsEntitlement } from "../data/entitlement";
import { PaymentsMeterCounter } from "../data/meterCounter";
import { PaymentsOverride } from "../data/override";
import { PaymentsProviderAccount } from "../data/providerAccount";
import { PaymentsPurchase } from "../data/purchase";
import {
  PAYMENTS_ENTITLEMENTS_TABLE,
  PAYMENTS_METER_COUNTERS_TABLE,
  PAYMENTS_OVERRIDES_TABLE,
  PAYMENTS_PROVIDER_ACCOUNTS_TABLE,
  PAYMENTS_PURCHASES_TABLE,
  PAYMENTS_USAGE_REPORTS_TABLE,
} from "../data/tables";
import { PaymentsUsageReport } from "../data/usageReport";

/**
 * What a person's purge means for `@pithy-sh/payments` (#814): **nothing is erased, and the export says so and why.**
 *
 * A purchase is a financial record, and the law that makes a business keep one for years — for tax, for an audit, for
 * a chargeback — does not end when the buyer's account does. So this contribution **retains**: the purge records the
 * step as retained with the basis below and erases no row of it, and the export answers for every row it keeps — the
 * purchases, the entitlements they granted, the provider accounts that link them, and the overrides, meter counters
 * and usage reports kept against the person.
 *
 * **Only a user subject's rows.** One `subjectId` column names people and organizations both; an organization's
 * purchases are the organization's, and are not this person's whoever bought them.
 *
 * **Never the provider's payload.** A purchase keeps the verified notification it was projected from, and a rail's
 * notification can carry what lets its holder act on the purchase — a Google Play purchase token among them. The
 * export carries the projection, which is the person's record, and leaves the payload out. **Nor the token where the
 * projection keeps it**: a Play row chains its renewals by the purchase token in `originalTransactionId`, and a row
 * with no order yet — a subscription never paid for, a pending one-time purchase — is keyed on the token in
 * `providerTransactionId`. The export carries neither: a Play row's family key is left out, and its transaction id
 * only when it is the order id the provider reported.
 */

/** The one sentence the purge records with this step. */
export const PAYMENTS_PURGE_SUMMARY =
  "Keeps the user's purchases, the entitlements they granted, the provider accounts that link them, and the overrides, meter counters and usage reports kept against them.";

/** Why, in the sentence the person is told. */
export const PAYMENTS_RETENTION_BASIS =
  "Kept for tax and accounting records, which the law requires a business to hold after an account is closed.";

/** A person's rows only — an organization's share the id column and are the organization's. */
const USER = { subjectType: "user" } as const;

/** The order id a Play purchase reports — `latestOrderId` on a subscription, `orderId` on a one-time purchase. */
function playOrderId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { latestOrderId, orderId } = payload as { latestOrderId?: unknown; orderId?: unknown };
  const id = latestOrderId ?? orderId;
  return typeof id === "string" && id !== "" ? id : null;
}

/** A purchase row as the export carries it: a Google Play row never with its purchase token. */
export function redactPurchase(row: Record<string, unknown>): Record<string, unknown> {
  if (row.rail !== "google") return row;
  const order = playOrderId(row.payload);
  return {
    ...row,
    providerTransactionId: order !== null && row.providerTransactionId === order ? order : null,
    originalTransactionId: null,
  };
}

/** The user contribution `payments()` declares, over the D1 binding the payments tables live in. */
export function paymentsUserPurge(database = "DB"): RetainingPurgeContribution {
  return {
    subject: "user",
    summary: PAYMENTS_PURGE_SUMMARY,
    retain: { basis: PAYMENTS_RETENTION_BASIS },
    export: personRowsExport({
      capability: "payments",
      database,
      tables: [
        {
          table: PAYMENTS_PURCHASES_TABLE,
          schema: PaymentsPurchase,
          columns: ["subjectId"],
          match: USER,
          as: "purchases",
          orderBy: "purchasedAt",
          omit: ["payload"],
          redact: redactPurchase,
        },
        {
          table: PAYMENTS_ENTITLEMENTS_TABLE,
          schema: PaymentsEntitlement,
          columns: ["subjectId"],
          match: USER,
          as: "entitlements",
          orderBy: "createdAt",
        },
        {
          table: PAYMENTS_PROVIDER_ACCOUNTS_TABLE,
          schema: PaymentsProviderAccount,
          columns: ["subjectId"],
          match: USER,
          as: "providerAccounts",
          orderBy: "createdAt",
        },
        {
          table: PAYMENTS_OVERRIDES_TABLE,
          schema: PaymentsOverride,
          columns: ["subjectId"],
          match: USER,
          as: "overrides",
          orderBy: "createdAt",
        },
        {
          table: PAYMENTS_METER_COUNTERS_TABLE,
          schema: PaymentsMeterCounter,
          columns: ["subjectId"],
          match: USER,
          as: "meterCounters",
          orderBy: "periodStart",
        },
        {
          table: PAYMENTS_USAGE_REPORTS_TABLE,
          schema: PaymentsUsageReport,
          columns: ["subjectId"],
          match: USER,
          as: "usageReports",
          orderBy: "createdAt",
        },
      ],
    }),
  };
}
