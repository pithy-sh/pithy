// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Entitlement } from "@pithy-sh/core/src/entitlement/entitlement";
import { PaymentsEntitlement } from "../data/entitlement";
import { PAYMENTS_ENTITLEMENTS_TABLE, type PaymentsDatabase } from "../data/tables";

/**
 * The read path: every entitlement a user holds, as the core seam's shape.
 *
 * **A read never writes.** Repairing a stale row is the reconciliation Workflow's job, which is what keeps
 * this the hot path it needs to be — one indexed lookup per request, no KV cache, no token claim, so a
 * revocation is immediate and the truth has one home (issue #79 decision 5).
 *
 * The recheck is why the read exists as its own function rather than a `selectAll`. A subscription can lapse
 * with **no notification arriving at all** — the store simply stops renewing, and nothing tells us. So the
 * stored `active` flag is an optimization and `expiresAt` is the truth, and the read applies the timestamp
 * itself rather than trusting the flag. A row that says `active = 1` with an expiry in the past does not
 * grant, and it does not need a write to stop granting.
 *
 * Lapsed rows are returned rather than filtered out, with `active` false. A paywall wants to say "your Pro
 * ended on the 4th", and it can only do that if the row and its date survive the read.
 */
export async function resolveEntitlements(
  db: PaymentsDatabase,
  userId: string,
  now: Date,
): Promise<readonly Entitlement[]> {
  const rows = await db
    .selectFrom(PAYMENTS_ENTITLEMENTS_TABLE)
    .selectAll()
    .where("userId", "=", userId)
    .orderBy("entitlement")
    .execute();

  return rows.map((row) => {
    const entitlement = PaymentsEntitlement.parse(row);
    const lapsed = entitlement.expiresAt !== null && entitlement.expiresAt.getTime() <= now.getTime();
    return {
      key: entitlement.entitlement,
      active: entitlement.active && !lapsed,
      expiresAt: entitlement.expiresAt,
      source: entitlement.sourcePurchaseId,
    };
  });
}
