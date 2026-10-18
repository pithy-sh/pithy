// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PaymentsReportedBilling } from "../config/config";

/**
 * What a store is told about one reported period, and the one method a rail implements to tell it.
 *
 * **Every report carries an idempotency key, and both stores honor one.** Stripe dedupes a meter event by its
 * `identifier`; Paddle dedupes a write by its `Paddle-Idempotency-Key`. The key is the period's own row id, so
 * a run that crashed after the store answered and before the row said so sends the same key again, and the
 * store records the period once. That is what lets a claimed period be retried rather than abandoned.
 *
 * **The quantity is the adopter's.** It is the number `resolveQuantity` answered, validated against the
 * product's `min` and `max`. Nothing a kit meter counted ever reaches this type.
 */
export interface UsageReportRequest {
  /** The subscription at the store — `sub_…`. */
  providerSubscriptionId: string;
  /** The store's customer for this subscription — Stripe's `cus_…` — when the rail needs one. */
  providerCustomerId: string | undefined;
  /** The count. A whole number inside the product's bounds. */
  quantity: number;
  /** Which period this is, as the row keys it. */
  period: string;
  /** The instant the report is dated — inside the period it bills. */
  at: Date;
  /** The product's reported billing — the meter it feeds, the price it charges. */
  billing: PaymentsReportedBilling;
  /** Sent to the store so a repeated report is recorded once. */
  idempotencyKey: string;
}

/** One rail's half of reporting. Throws when the store did not accept the report. */
export interface UsageReporter {
  /** Tell the store. Resolves when it accepted; throws when it did not. */
  report(request: UsageReportRequest): Promise<void>;
}
