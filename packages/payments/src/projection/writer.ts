// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { type CompiledQuery, type SqlBool, sql } from "kysely";
import {
  entitlementsForProduct,
  type PaymentsConfig,
  type PaymentsProduct,
  productForProviderSku,
} from "../config/config";
import { PaymentsEntitlement } from "../data/entitlement";
import { PaymentsPurchase, type PaymentsPurchaseRow, type PurchaseEnvironment } from "../data/purchase";
import { grantingStatuses } from "../data/status";
import {
  PAYMENTS_ENTITLEMENTS_TABLE,
  PAYMENTS_PURCHASES_TABLE,
  type PaymentsDatabase,
  paymentsDatabase,
} from "../data/tables";
import {
  PaymentsEnvironmentMismatchError,
  PaymentsProductNotFoundError,
  PaymentsReceiptAlreadyOwnedError,
} from "../error/errors";
import { ProviderEvent, type ProviderEventInput } from "./event";

/**
 * The projection writer — the one place a purchase is ever written, and the heart of the package.
 *
 * Three triggers converge here: the buying user's app submitting its receipt, the provider's webhook, and
 * the reconciliation Workflow re-verifying what the webhook missed. All three produce the identical row,
 * which is what makes a dropped client call cost nothing and a replayed webhook change nothing — and it is
 * why refunds, renewals, and revocations need no handler of their own. They are states, and this projects
 * a state.
 *
 * Four properties hold, and each is enforced by the database rather than by careful code:
 *
 * - **Idempotent.** `UNIQUE (rail, providerTransactionId)` means one provider transaction is one row
 *   forever. A repeat routes into the upsert's `ON CONFLICT` branch instead of inserting a second row.
 * - **Monotonic on the provider's event time.** Providers do not guarantee delivery order, so an `expired`
 *   notification can arrive after the `renewed` that superseded it, and last-write-wins would silently
 *   revoke a paying subscriber. An event no newer than the row it would update is ignored entirely — the
 *   comparison is a SQL predicate on the `ON CONFLICT` branch as well as a pre-read, so two concurrent
 *   writers cannot order themselves wrongly.
 * - **Never rebound.** A transaction already projected against another user raises
 *   `payments/receipt_already_owned` (409) rather than moving. Together with the UNIQUE constraint that is
 *   what makes a stolen receipt worthless. The `ON CONFLICT` branch carries the owner check too, so the
 *   refusal survives a race the pre-read cannot see.
 * - **Environment-isolated.** The deployment's own store environment is an input, and a mismatch is refused
 *   outright. A sandbox StoreKit transaction granting a real entitlement is the most common
 *   in-app-purchase security defect there is; the safe design is for such a row never to exist.
 *
 * The affected entitlement rows are re-derived **in the same `DB.batch` as the purchase write**, from the
 * purchases table itself rather than from a value this function computed. D1 runs a batch as one
 * transaction, so the read model cannot disagree with the purchases that produced it: there is no window
 * in which a purchase is stored and its entitlement is not. An entitlement is granted when some purchase
 * granting it sits in an access-granting status and has not expired, and the row carries the winning
 * purchase — the one whose access runs longest — as provenance.
 *
 * Which rows those are is a question about the catalog as well as the event, so a write also clears the keys
 * this user holds that the catalog has stopped granting — see {@link keysToDerive}. A catalog edit produces
 * no event of its own, and nothing else in the package would ever repair such a row.
 *
 * The ledger credit a `grants` clause asks for is deliberately **not** here. This function stays pure D1,
 * so its tests need no optional package resolved; fulfillment acts on what it returns. Nothing is lost —
 * the credit's idempotency rests on the ledger's own `UNIQUE (ref)`, not on call ordering.
 */

/** What one projection did, and to what. The caller acts on this — fulfillment reads it, a route renders it. */
export interface PurchaseProjection {
  /**
   * `created` for a transaction seen for the first time, `updated` when a newer event moved an existing
   * row, `ignored` when the event was no newer than the row it would have updated. `ignored` is a normal,
   * successful outcome: a replay is a 200, not an error.
   */
  outcome: "created" | "updated" | "ignored";
  /** The purchase row as it now stands — the existing one, unchanged, on the `ignored` path. */
  purchase: PaymentsPurchase;
  /** The catalog product this transaction maps to, and the entitlement keys it grants. */
  product: { id: string; entitlements: readonly string[] };
  /** The entitlement rows this projection re-derived, after the write. */
  entitlements: readonly PaymentsEntitlement[];
}

/** What the writer needs beyond the event: the catalog, the deployment's environment, and the clock. */
export interface ProjectPurchaseOptions {
  /** The resolved catalog. The product, its type, and its entitlement keys all come from here. */
  config: PaymentsConfig;
  /**
   * This deployment's store environment. An input rather than something inferred from the payload, because
   * inferring it is what lets a sandbox purchase grant a production entitlement.
   */
  environment: PurchaseEnvironment;
  /** The clock, for `createdAt`/`updatedAt` and the expiry check. Injected so tests are deterministic. */
  now?: Date;
  /** The id minter. Injected for the same reason. */
  newId?: () => string;
}

/**
 * Project one normalized provider event. Returns what changed; throws only the three refusals above and
 * whatever D1 raises that is not a constraint we expect.
 */
export async function projectPurchase(
  d1: D1Database,
  input: ProviderEventInput,
  options: ProjectPurchaseOptions,
): Promise<PurchaseProjection> {
  const event = ProviderEvent.parse(input);
  const { config } = options;
  const now = options.now ?? new Date();
  const newId = options.newId ?? (() => crypto.randomUUID());

  // Refused before anything is read, let alone written. There is no state in which a sandbox transaction
  // belongs in a production database, so recording-and-ignoring would only leave a row to be mistaken later.
  if (event.environment !== options.environment) {
    throw new PaymentsEnvironmentMismatchError({
      detail: `${event.rail} transaction ${event.providerTransactionId} is ${event.environment}; this deployment is ${options.environment}.`,
    });
  }

  // The catalog is config, not rows, so an unmapped SKU is a missing resource rather than a bad request.
  const entry = productForProviderSku(config, event.rail, event.providerProductId);
  if (entry === undefined) {
    throw new PaymentsProductNotFoundError({
      detail: `No catalog product maps the ${event.rail} SKU "${event.providerProductId}".`,
    });
  }

  const db = paymentsDatabase(d1);
  const existing = await readPurchase(db, event);

  if (existing !== undefined) {
    if (existing.userId !== event.userId) throw alreadyOwned(event, existing.userId);
    // Stale, or an exact replay. Either way the row already says something at least as new, so nothing is
    // written and the caller gets the purchase it asked about.
    if (existing.providerEventAt.getTime() >= event.providerEventAt.getTime()) {
      const keys = affectedKeys(config, entry.product, existing.productId);
      return {
        outcome: "ignored",
        purchase: existing,
        product: { id: existing.productId, entitlements: entitlementsForProduct(config, existing.productId) },
        entitlements: await readEntitlements(db, event.userId, keys),
      };
    }
  }

  const keys = await keysToDerive(db, config, entry.product, existing?.productId, event.userId);
  const row = PaymentsPurchase.encode({
    id: existing?.id ?? newId(),
    userId: event.userId,
    rail: event.rail,
    providerTransactionId: event.providerTransactionId,
    productId: entry.id,
    providerProductId: event.providerProductId,
    type: entry.product.type,
    status: event.status,
    role: event.role,
    environment: event.environment,
    purchasedAt: event.purchasedAt,
    expiresAt: event.expiresAt,
    revokedAt: event.revokedAt,
    originalTransactionId: event.originalTransactionId,
    amountMinor: event.amountMinor,
    currency: event.currency,
    providerEventAt: event.providerEventAt,
    payload: event.payload,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  const at = now.getTime();
  const statements: D1PreparedStatement[] = [upsertPurchaseStatement(d1, row)];
  for (const key of keys) {
    // Two statements per key, because a derivation cannot update a row that is not there yet. The insert is
    // the row's existence; the update is its value, computed from the purchases table inside this same
    // transaction — so the answer accounts for the purchase written one statement earlier.
    statements.push(compile(d1, ensureEntitlement(db, newId(), event.userId, key, at)));
    statements.push(compile(d1, deriveEntitlement(db, config, event.userId, key, at)));
  }

  // One batch, one D1 transaction: the purchase and every entitlement it implies commit together or not at
  // all. `withD1Retry` covers the transient faults D1 surfaces by message; a retry is safe because every
  // statement here is an upsert or a derivation, so re-running the batch reaches the same state.
  await withD1Retry(() => d1.batch(statements));

  const projected = await readPurchase(db, event);
  if (projected === undefined) {
    throw new InternalError({
      message: "The purchase could not be recorded.",
      action: "Retry. If it persists, check the app database for the pithy_payments_* tables.",
      detail: `Projected ${event.rail} transaction ${event.providerTransactionId} but could not read it back.`,
    });
  }
  // The race the pre-read cannot see: a concurrent submission for a different user landed first, and this
  // batch's `ON CONFLICT` guard correctly refused to rebind the row. Report the refusal rather than a
  // success against a row that is not this caller's.
  if (projected.userId !== event.userId) throw alreadyOwned(event, projected.userId);

  return {
    outcome:
      projected.providerEventAt.getTime() !== event.providerEventAt.getTime()
        ? "ignored"
        : existing === undefined
          ? "created"
          : "updated",
    purchase: projected,
    product: { id: entry.id, entitlements: entry.product.entitlements },
    entitlements: await readEntitlements(db, event.userId, keys),
  };
}

/** The 409, with the throw-site context in `detail` where an operator sees it and a client never does. */
function alreadyOwned(event: ProviderEvent, owner: string): PaymentsReceiptAlreadyOwnedError {
  return new PaymentsReceiptAlreadyOwnedError({
    detail: `${event.rail} transaction ${event.providerTransactionId} is owned by ${owner}; ${event.userId} submitted it.`,
  });
}

/**
 * The entitlement keys the catalog says this event touches: the ones its product grants, plus the ones the
 * row's previous product granted when a catalog edit re-mapped the SKU. Sorted, so a batch's statement order
 * is deterministic and two concurrent projections for one user cannot deadlock on opposite orders.
 */
function affectedKeys(
  config: PaymentsConfig,
  product: PaymentsProduct,
  previousProductId: string | undefined,
): string[] {
  const keys = new Set<string>(product.entitlements);
  if (previousProductId !== undefined) {
    for (const key of entitlementsForProduct(config, previousProductId)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Every key a write must re-derive: what {@link affectedKeys} reads out of the catalog, **plus the keys this
 * user still holds that no current product grants at all**.
 *
 * That second set cannot come from the config, because it is precisely what the config no longer mentions.
 * Drop `beta` from a product's `entitlements` and ship, and every user holding it holds it forever otherwise:
 * no purchase for that key will ever arrive again, the read path only lapses a row carrying a dated expiry,
 * and the reconciliation pass re-asks about subscriptions. A catalog edit is a deploy, so the repair is one
 * indexed read per projection and lands on this user's next purchase event, whatever it was about.
 *
 * Held rows are excluded, and the `active` filter keeps the set to rows that still claim something — a
 * support comp of a key the catalog never sold is a human's decision, and an already-cleared row needs no
 * second clearing. Sorted for the same reason as above.
 */
async function keysToDerive(
  db: PaymentsDatabase,
  config: PaymentsConfig,
  product: PaymentsProduct,
  previousProductId: string | undefined,
  userId: string,
): Promise<string[]> {
  const keys = new Set<string>(affectedKeys(config, product, previousProductId));
  const granted = new Set<string>();
  for (const candidate of Object.values(config.products)) {
    for (const key of candidate.entitlements) granted.add(key);
  }
  const held = await db
    .selectFrom(PAYMENTS_ENTITLEMENTS_TABLE)
    .select("entitlement")
    .where("userId", "=", userId)
    .where("active", "=", 1)
    .where("manual", "=", 0)
    .execute();
  for (const row of held) {
    if (!granted.has(row.entitlement)) keys.add(row.entitlement);
  }
  return [...keys].sort();
}

/** The purchase row for this `(rail, providerTransactionId)`, decoded, or undefined. */
async function readPurchase(
  db: PaymentsDatabase,
  event: Pick<ProviderEvent, "rail" | "providerTransactionId">,
): Promise<PaymentsPurchase | undefined> {
  const row = await db
    .selectFrom(PAYMENTS_PURCHASES_TABLE)
    .selectAll()
    .where("rail", "=", event.rail)
    .where("providerTransactionId", "=", event.providerTransactionId)
    .executeTakeFirst();
  return row === undefined ? undefined : PaymentsPurchase.parse(row);
}

/**
 * The entitlement rows for these keys, decoded, in key order. Empty when the product grants none.
 *
 * Chunked, because `keys` is no longer bounded by one product: {@link keysToDerive} adds every key this user
 * holds that the catalog dropped, and a long-lived account collects them. One statement binds a parameter per
 * key plus the `userId` — hence `fixed` of 1 — and D1 refuses the statement rather than truncating the list.
 */
async function readEntitlements(
  db: PaymentsDatabase,
  userId: string,
  keys: readonly string[],
): Promise<PaymentsEntitlement[]> {
  const entitlements: PaymentsEntitlement[] = [];
  for (const chunk of chunkByBoundParameters(keys, 1)) {
    const rows = await db
      .selectFrom(PAYMENTS_ENTITLEMENTS_TABLE)
      .selectAll()
      .where("userId", "=", userId)
      .where("entitlement", "in", chunk)
      .execute();
    for (const row of rows) entitlements.push(PaymentsEntitlement.parse(row));
  }
  // Sorted here rather than per chunk: the caller is handed one list, and its order must not depend on where
  // the chunk boundaries fell.
  return entitlements.sort((left, right) => (left.entitlement < right.entitlement ? -1 : 1));
}

/**
 * The purchase upsert, compiled to the statement that joins the batch. **The only place either commit-time
 * guard is expressed**, and exported for that reason: a test can compile it, let the table move underneath
 * the compiled statement, and execute it — which is the one way to reach the `ON CONFLICT` predicate.
 * Driving `projectPurchase` cannot do it, because its pre-read and post-batch checks serialize around the
 * predicate and cover the same outcomes, so a test at that level passes with the predicate deleted.
 */
export function upsertPurchaseStatement(d1: D1Database, row: PaymentsPurchaseRow): D1PreparedStatement {
  return compile(d1, upsertPurchase(paymentsDatabase(d1), row));
}

/**
 * The purchase upsert. Both guards live on the `ON CONFLICT` branch rather than only in the pre-read,
 * because a pre-read cannot see a concurrent writer: SQLite evaluates them against the row as it stands at
 * commit, so a stale event and a receipt lifted from another account are both refused by the database.
 *
 * `id`, `userId`, and `createdAt` are absent from the update set on purpose — a transaction's identity, its
 * owner, and when it was first projected are immutable.
 */
function upsertPurchase(db: PaymentsDatabase, row: PaymentsPurchaseRow) {
  return (
    db
      .insertInto(PAYMENTS_PURCHASES_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side; Kysely's insert type derives from it.
      .values(row as any)
      .onConflict((oc) =>
        oc
          .columns(["rail", "providerTransactionId"])
          .doUpdateSet({
            productId: row.productId,
            providerProductId: row.providerProductId,
            type: row.type,
            status: row.status,
            environment: row.environment,
            purchasedAt: row.purchasedAt,
            expiresAt: row.expiresAt,
            revokedAt: row.revokedAt,
            originalTransactionId: row.originalTransactionId,
            amountMinor: row.amountMinor,
            currency: row.currency,
            providerEventAt: row.providerEventAt,
            payload: row.payload,
            updatedAt: row.updatedAt,
            // biome-ignore lint/suspicious/noExplicitAny: as above — an encoded row, not the app shape.
          } as any)
          .where((eb) =>
            eb.and([
              // Monotonic: strictly newer, so an exact redelivery is a no-op rather than a rewrite.
              eb(
                eb.ref(`${PAYMENTS_PURCHASES_TABLE}.providerEventAt`),
                "<",
                // biome-ignore lint/suspicious/noExplicitAny: an encoded ms-epoch number from the row.
                row.providerEventAt as any,
              ),
              // Never rebind an owner, whoever wins the race.
              // biome-ignore lint/suspicious/noExplicitAny: as above.
              eb(eb.ref(`${PAYMENTS_PURCHASES_TABLE}.userId`), "=", row.userId as any),
            ]),
          ),
      )
  );
}

/** The entitlement row's existence. Cleared, so a project that grants nothing still leaves provenance. */
function ensureEntitlement(db: PaymentsDatabase, id: string, userId: string, key: string, at: number) {
  const row = {
    id,
    userId,
    entitlement: key,
    active: 0,
    expiresAt: null,
    sourcePurchaseId: null,
    // A row this function creates is derived, never held. Only `entitlement/manual.ts` sets the hold.
    manual: 0,
    createdAt: at,
    updatedAt: at,
  };
  return (
    db
      .insertInto(PAYMENTS_ENTITLEMENTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: an encoded row; Kysely's insert type derives from z.input.
      .values(row as any)
      .onConflict((oc) => oc.columns(["userId", "entitlement"]).doNothing())
  );
}

/**
 * Re-derive one entitlement row from the purchases table. The candidate set is named **once**, as a CTE, and
 * read three times: is anything granting, when does the winner lapse, and which purchase is it.
 *
 * The winner is the purchase whose access runs longest — `NULLS FIRST` on a descending expiry puts a
 * never-expiring purchase ahead of every dated one, which is right: owning `remove_ads` outright is not
 * beaten by a subscription that ends. `providerEventAt` breaks a tie so the choice is deterministic.
 *
 * Written as a derivation rather than as values this function computed, because that is the difference
 * between "the read model agrees with what I read a moment ago" and "the read model agrees with the
 * purchases". Only the second survives a concurrent write.
 *
 * ## Two shapes here are about D1's bound-parameter cap, not about style
 *
 * D1 refuses a statement carrying more than 100 bound parameters (see `@pithy-sh/core`'s
 * `boundParameters`), and this statement's list of granting products is the one part of it a *catalog* can
 * grow. So the CTE names the candidate set once instead of inlining the subquery per column — three copies
 * tripled every parameter — and the product ids travel as **one** JSON parameter that SQLite's `json_each`
 * expands back into rows, so the count no longer depends on the catalog at all. Twenty-seven products
 * granting one key used to throw `too many SQL variables`, and because the derivation shares the purchase
 * write's batch, the throw meant no purchase touching that key could be recorded — a project with a few
 * grandfathered prices could not sell.
 *
 * An empty list is the honest ordinary case, not a branch: `json_each('[]')` yields no rows, so no purchase
 * qualifies and the row is cleared — which is exactly right when a catalog edit stops granting a key.
 */
function deriveEntitlement(db: PaymentsDatabase, config: PaymentsConfig, userId: string, key: string, at: number) {
  const grantingProducts = JSON.stringify(
    Object.entries(config.products)
      .filter(([, product]) => product.entitlements.includes(key))
      .map(([id]) => id),
  );
  const statuses = grantingStatuses(config.graceGrantsAccess);

  return (
    db
      // The purchase currently granting `key`, or no row at all when none does.
      .with("winner", (cb) =>
        cb
          .selectFrom(PAYMENTS_PURCHASES_TABLE)
          .select(["id", "expiresAt"])
          .where("userId", "=", userId)
          // The catalog as one parameter. `json_each` is SQLite's own, so the ids stay bound values — never
          // interpolated SQL — and a thousand-product catalog binds exactly what a one-product catalog does.
          .where(sql<SqlBool>`${sql.ref("productId")} in (select value from json_each(${grantingProducts}))`)
          .where("status", "in", statuses)
          // The read-time rule, applied at write time too: a status says the purchase still stands,
          // `expiresAt` says whether the period it paid for is over.
          .where((inner) => inner.or([inner("expiresAt", "is", null), inner("expiresAt", ">", at)]))
          .orderBy("expiresAt", (ob) => ob.desc().nullsFirst())
          .orderBy("providerEventAt", "desc")
          .limit(1),
      )
      .updateTable(PAYMENTS_ENTITLEMENTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: three reads of the CTE as column values; Kysely's set type is the row shape.
      .set((eb: any) => ({
        active: eb.exists(eb.selectFrom("winner").select("id")),
        expiresAt: eb.selectFrom("winner").select("expiresAt"),
        sourcePurchaseId: eb.selectFrom("winner").select("id"),
        updatedAt: at,
      }))
      .where("userId", "=", userId)
      .where("entitlement", "=", key)
      // The hold. Without this predicate a support comp of a key the catalog also sells is erased by the very
      // next purchase event for that key — the derivation would find no purchase behind the comp and clear it.
      .where("manual", "=", 0)
  );
}

/** Compile a Kysely query to a D1 prepared statement, so it can join a `DB.batch` transaction. */
function compile(d1: D1Database, query: { compile(): CompiledQuery }): D1PreparedStatement {
  const compiled = query.compile();
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}
