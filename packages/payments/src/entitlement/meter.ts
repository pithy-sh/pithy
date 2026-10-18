// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { grantedEntitlementKeys, type MeterLimit } from "@pithy-sh/core/src/entitlement/entitlement";
import type { MeterCharge, UsageMeter } from "@pithy-sh/core/src/entitlement/meter";
import { InternalError, messageOf, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import { sql } from "kysely";
import type { AllowanceDeclarations } from "../config/allowances";
import type { KitMeter, PaymentsMeters } from "../config/config";
import { PaymentsMeterCounter } from "../data/meterCounter";
import { knownPeriodStart } from "../data/period";
import { PaymentsPurchase } from "../data/purchase";
import { grantingStatuses } from "../data/status";
import { encodeSubjectReference, PaymentsSubject } from "../data/subject";
import {
  PAYMENTS_METER_COUNTERS_TABLE,
  PAYMENTS_PURCHASES_TABLE,
  type PaymentsDatabase,
  paymentsDatabase,
} from "../data/tables";
import { PaymentsQuotaExceededError } from "../error/errors";
import { resolveEntitlements } from "../projection/resolve";
import { type AllowanceInput, resolveQuota } from "./allowance";
import { allowanceOverride, readOverride } from "./override";

/**
 * The kit's own meters — what the kit counts because it writes the rows.
 *
 * | meter          | counted from          | enforced by                                 |
 * |----------------|-----------------------|---------------------------------------------|
 * | `emails`       | this table, per period | `@pithy-sh/email`, at enqueue, through {@link paymentsUsageMeter} |
 * | `storageBytes` | `pithy_storage_objects` | `@pithy-sh/storage`, through `meterLimit`  |
 * | `mediaItems`   | `pithy_media_*`       | `@pithy-sh/media`, through `meterLimit`      |
 *
 * The two that are levels — bytes held, items held — are counted by the capability that holds them, in the
 * statement that writes the row, which is the only place a concurrent burst cannot walk past. Payments only
 * says what the ceiling is. The one that is a flow — emails sent this period — is counted here, in
 * `pithy_payments_meter_counters`, because no row anybody keeps answers "how many this period" once the
 * email capability has pruned its jobs.
 *
 * **Enforcement is opt-in per meter.** Declaring `quotas: { emails: 500 }` makes 500 readable; turning the
 * `emails` meter on makes it binding. A cap that arrives by surprise breaks an adopter already over it.
 *
 * **A counter read that fails refuses, and logs.** Storage already says which way round to err: over-counting
 * briefly and reclaiming is the right way round, and under-counting has no recovery. The cost is stated
 * rather than discovered: a bug of ours becomes a refused send for a paying customer, and a password reset is
 * a bad place to invent a failure. Opt-in enforcement bounds it — an adopter who would rather over-deliver
 * than drop leaves the meter advisory and keeps the check in their own route. Whoever reverses this should
 * have to argue with that paragraph first.
 *
 * **A meter refuses; it never bills.** Nothing here reports a count to a store, and the usage-reporting pass
 * never reads this table: the kit does not sell overage.
 */

/** What every allowance read and every meter needs from the config. */
export interface PaymentsAllowances {
  /** The declarations. */
  declarations: AllowanceDeclarations;
  /** Which kit meters enforce. */
  meters: PaymentsMeters;
}

/** Whether a kit meter is enforced in this config. Anything not a kit meter is not. */
export function meterEnforced(meters: PaymentsMeters, meter: string): meter is KitMeter {
  return (meters as Record<string, { enforce?: boolean } | undefined>)[meter]?.enforce === true;
}

/**
 * Everything resolution needs for one subject, read now: the keys granting access and the override row. A
 * caller acting for nobody holds nothing and has no override, and resolves to the floor.
 */
export async function allowanceInputFor(
  db: PaymentsDatabase | undefined,
  declarations: AllowanceDeclarations,
  subject: PaymentsSubject | undefined,
  now: Date,
): Promise<AllowanceInput> {
  if (subject === undefined || db === undefined) return { declarations, held: new Set(), override: null };
  const [entitlements, override] = await Promise.all([
    resolveEntitlements(db, subject, now),
    readOverride(db, subject),
  ]);
  return { declarations, held: grantedEntitlementKeys(entitlements, now), override: allowanceOverride(override) };
}

/** The first instant of `now`'s calendar month, in UTC. The period of a subject payments knows no billing period for. */
export function calendarMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * When the subject's current period began: the start of its current billing period where payments knows one,
 * the calendar month where it does not — a free-floor account still has a month.
 *
 * The current period is a granting subscription row whose window holds `now`; `data/period.ts` says which
 * rails' rows state where that period began. Two at once — an upgrade overlapping an old subscription's tail —
 * is answered by the newest, which is the one the customer is now paying for.
 */
export async function meterPeriodStart(db: PaymentsDatabase, subject: PaymentsSubject, now: Date): Promise<Date> {
  const at = now.getTime();
  const row = await db
    .selectFrom(PAYMENTS_PURCHASES_TABLE)
    .select(["rail", "purchasedAt", "payload"])
    .where("subjectType", "=", subject.subjectType)
    .where("subjectId", "=", subject.subjectId)
    .where("type", "=", "subscription")
    .where("status", "in", grantingStatuses(true))
    // biome-ignore lint/suspicious/noExplicitAny: ms-epoch numbers against the encoded columns.
    .where("purchasedAt", "<=", at as any)
    // biome-ignore lint/suspicious/noExplicitAny: as above.
    .where("expiresAt", ">", at as any)
    .orderBy("purchasedAt", "desc")
    .limit(1)
    .executeTakeFirst();
  if (row === undefined) return calendarMonthStart(now);
  const purchase = PaymentsPurchase.pick({ rail: true, purchasedAt: true, payload: true }).parse(row);
  return knownPeriodStart(purchase) ?? calendarMonthStart(now);
}

/**
 * Charge `amount` of `meter` against `subject` — or refuse, and write nothing.
 *
 * **The check and the write are one statement.** An upsert on `(subject, meter, periodStart)` whose update
 * is conditioned on `used + amount <= limit`, with `RETURNING` to read back whether it landed. SQLite
 * evaluates the condition under its write lock, so a burst of concurrent sends is serialized by the database
 * and the first that would pass the limit changes nothing — the guarantee `@pithy-sh/storage`'s conditional
 * insert makes, for the same reason: D1 has no interactive transaction to make two statements one.
 *
 * An unlimited subject — `null`, from a plan or from `unrestricted` — is counted and never refused.
 */
export async function chargeMeter(
  db: PaymentsDatabase,
  allowances: PaymentsAllowances,
  charge: { subject: PaymentsSubject; meter: string; amount: number; now: Date },
): Promise<void> {
  if (!meterEnforced(allowances.meters, charge.meter)) return;
  const input = await allowanceInputFor(db, allowances.declarations, charge.subject, charge.now);
  const limit = resolveQuota(input, charge.meter).effective.value;
  const periodStart = await meterPeriodStart(db, charge.subject, charge.now);
  const refused = () =>
    new PaymentsQuotaExceededError({
      params: { meter: charge.meter, limit: limit ?? 0 },
      detail: `${encodeSubjectReference(charge.subject)} is at its ${charge.meter} quota of ${limit} for the period from ${periodStart.toISOString()}.`,
    });
  if (limit !== null && charge.amount > limit) throw refused();

  const at = charge.now.getTime();
  const record = PaymentsMeterCounter.encode({
    id: crypto.randomUUID(),
    subjectType: charge.subject.subjectType,
    subjectId: charge.subject.subjectId,
    meter: charge.meter,
    periodStart,
    used: charge.amount,
    createdAt: charge.now,
    updatedAt: charge.now,
  });
  const landed = await db
    .insertInto(PAYMENTS_METER_COUNTERS_TABLE)
    // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side; Kysely's insert type derives from it.
    .values(record as any)
    .onConflict((oc) => {
      const update = oc.columns(["subjectType", "subjectId", "meter", "periodStart"]).doUpdateSet({
        // biome-ignore lint/suspicious/noExplicitAny: an expression, not a value.
        used: sql`${sql.ref(`${PAYMENTS_METER_COUNTERS_TABLE}.used`)} + excluded.used` as any,
        // biome-ignore lint/suspicious/noExplicitAny: as above.
        updatedAt: at as any,
      });
      return limit === null
        ? update
        : update.where(sql<boolean>`${sql.ref(`${PAYMENTS_METER_COUNTERS_TABLE}.used`)} + excluded.used <= ${limit}`);
    })
    .returning("used")
    .executeTakeFirst();
  if (landed === undefined) throw refused();
}

/**
 * The ceiling a capability enforces on a level it counts itself — `storageBytes`, `mediaItems` — for a
 * subject, or `{ enforced: false }` where the meter is advisory and the capability keeps its own.
 *
 * **The ceiling names the organization it covers.** An organization's plan is the organization's, so the
 * capability must sum every member's rows against it, not the caller's alone — `tenant` says so, the same
 * value the holder's `tenant` carries. A user subject, or nobody, is `null`: the caller's own rows.
 */
export async function meterLimitFor(
  db: PaymentsDatabase,
  allowances: PaymentsAllowances,
  subject: PaymentsSubject | undefined,
  meter: string,
  now: Date,
): Promise<MeterLimit> {
  if (!meterEnforced(allowances.meters, meter)) return { enforced: false };
  const input = await allowanceInputFor(db, allowances.declarations, subject, now);
  return {
    enforced: true,
    limit: resolveQuota(input, meter).effective.value,
    tenant: subject?.subjectType === "organization" ? subject.subjectId : null,
  };
}

/**
 * The meter `@pithy-sh/email` finds among the composed capabilities and charges at enqueue — the env-side
 * half of the seam, for the callers with no request. See `@pithy-sh/core/src/entitlement/meter.ts`.
 *
 * A refusal is the provider's own `payments/quota_exceeded`. Anything else that goes wrong — a malformed
 * holder, a D1 read that throws — is logged and refused as `core/internal`, never let through: see this
 * module's note on which way round to err.
 */
export function paymentsUsageMeter(allowances: PaymentsAllowances, database = "DB"): UsageMeter {
  return {
    provider: "payments",
    async charge(env: Record<string, unknown>, charge: MeterCharge): Promise<void> {
      if (!meterEnforced(allowances.meters, charge.meter)) return;
      const log: Logger = charge.log ?? createWorkerLogger({ name: "payments" });
      const subject = PaymentsSubject.safeParse(charge.subject);
      if (!subject.success || !Number.isInteger(charge.amount) || charge.amount < 1) {
        throw new ValidationError({
          message: "That usage charge names no valid holder or amount.",
          action: "Charge a whole amount from 1 against a subject the payments subject schema accepts.",
          detail: `meter ${charge.meter}, amount ${charge.amount}`,
        });
      }
      try {
        const d1 = env[database] as D1Database | undefined;
        if (!d1) {
          throw new InternalError({
            detail: `No \`${database}\` binding on env; the ${charge.meter} meter cannot count.`,
          });
        }
        await chargeMeter(paymentsDatabase(d1), allowances, {
          subject: subject.data,
          meter: charge.meter,
          amount: charge.amount,
          now: charge.now ?? new Date(),
        });
      } catch (error) {
        if (error instanceof PaymentsQuotaExceededError) throw error;
        log.error("usage meter charge failed", { meter: charge.meter, cause: messageOf(error) });
        if (error instanceof PithyError && error.payload.code !== "core/internal") throw error;
        throw new InternalError({
          message: "Usage could not be checked, so nothing was written.",
          action: "Read the preceding log line for why the meter read failed.",
          detail: `the ${charge.meter} meter could not be charged; refusing rather than serving unbounded.`,
        });
      }
    },
  };
}
