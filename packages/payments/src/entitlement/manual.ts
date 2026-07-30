// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { PaymentsEntitlement } from "../data/entitlement";
import { PAYMENTS_ENTITLEMENTS_TABLE, paymentsDatabase } from "../data/tables";

/**
 * Manual entitlement writes — the support surface behind `POST /payments/entitlements/grant` and `/revoke`.
 *
 * These are the only writes to the read model that no purchase produced, which is exactly why the routes over
 * them are `control-plane`, default-denied, and audited on both paths. Everything else in this package can be
 * traced back to a store's own artifact; this cannot, so the trail is the only record of who decided it.
 *
 * ## The hold, and why `grant` and `revoke` are not symmetric
 *
 * Every other row in this table is derived: the projection recomputes it from the purchases table on every
 * write that touches its key, which is what keeps the read model from silently disagreeing with the money.
 * A comp has no purchase behind it, so a derivation would find nothing supporting it and clear it — and a
 * support comp erased by the user's next renewal is worse than no comp at all, because nobody would notice.
 *
 * So a grant sets `manual`, and the projection skips a row carrying it. The two shapes both work and both
 * last: comping a key the catalog does not sell (`beta_access`, `founder`) and comping one it does (`pro`).
 *
 * A **revoke clears the hold** rather than setting it, which is the deliberate asymmetry. It means a revoke
 * is the exact inverse of a grant — it takes the row back out of a human's hands — and it means a revoke
 * never becomes a permanent block on a user who later pays. That matters: an entitlement the purchases still
 * support is re-derived on the next event, so revoking a *paid* subscription here holds only until the store
 * next says something about it. To end a paid entitlement, refund it through the store; that is the record
 * the projection reads, and the only one that keeps the read model and the money agreeing.
 *
 * A revoke writes an inactive row even when the user held nothing, because support tooling should not have to
 * know whether a row exists, and because the row is itself the record that somebody decided this account is
 * not entitled.
 */

/** Who, and to what. The caller has already been through `requireControlPlane`. */
export interface ManualEntitlementInput {
  /** The user whose read model is being written. Never the caller — this is support acting on somebody else. */
  userId: string;
  /** The entitlement key, as gating code names it. */
  entitlement: string;
  /** When a grant lapses. Absent or null never lapses; ignored on a revoke. */
  expiresAt?: Date | null;
}

/** The clock and the id minter, injected so a test is deterministic. */
export interface ManualEntitlementOptions {
  /** The write timestamp. Defaults to now. */
  now?: Date;
  /** The id minter for a row that does not exist yet. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
}

/**
 * Grant an entitlement by hand, and hold it against the projection. Idempotent; overwrites whatever the
 * projection last derived for this key, and survives every later purchase event for it.
 */
export function grantEntitlement(
  d1: D1Database,
  input: ManualEntitlementInput,
  options: ManualEntitlementOptions = {},
): Promise<PaymentsEntitlement> {
  return writeEntitlement(d1, input, true, options);
}

/**
 * Revoke an entitlement by hand and release the hold. Idempotent, and records the decision even where there
 * was nothing to clear. A key the purchases still support is re-derived on the next event — see the module doc.
 */
export function revokeEntitlement(
  d1: D1Database,
  input: ManualEntitlementInput,
  options: ManualEntitlementOptions = {},
): Promise<PaymentsEntitlement> {
  return writeEntitlement(d1, input, false, options);
}

/**
 * The upsert both directions share. One statement, on the `UNIQUE (userId, entitlement)` conflict target, so
 * a concurrent write cannot produce a second row for one key.
 *
 * `sourcePurchaseId` is set to null on both paths, and that is the honest answer: no purchase supports this
 * row. `manual` is the half that differs — set by a grant, cleared by a revoke — and it is what the
 * projection's derivation reads to decide whether the row is its to touch.
 */
async function writeEntitlement(
  d1: D1Database,
  input: ManualEntitlementInput,
  active: boolean,
  options: ManualEntitlementOptions,
): Promise<PaymentsEntitlement> {
  const now = options.now ?? new Date();
  const newId = options.newId ?? (() => crypto.randomUUID());
  const db = paymentsDatabase(d1);
  const row = PaymentsEntitlement.encode({
    id: newId(),
    userId: input.userId,
    entitlement: input.entitlement,
    active,
    // An expiry only means anything on a grant. A revoke that carried one would describe a row that stops
    // being revoked, which is not a thing.
    expiresAt: active ? (input.expiresAt ?? null) : null,
    sourcePurchaseId: null,
    // A grant is held against the projection; a revoke hands the key back to it.
    manual: active,
    createdAt: now,
    updatedAt: now,
  });

  await withD1Retry(() =>
    db
      .insertInto(PAYMENTS_ENTITLEMENTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: the row is the schema's z.input side; Kysely's insert type derives from it.
      .values(row as any)
      .onConflict((oc) =>
        oc.columns(["userId", "entitlement"]).doUpdateSet({
          active: row.active,
          expiresAt: row.expiresAt,
          sourcePurchaseId: null,
          manual: row.manual,
          updatedAt: row.updatedAt,
          // biome-ignore lint/suspicious/noExplicitAny: as above — an encoded row, not the app shape.
        } as any),
      )
      .execute(),
  );

  const written = await db
    .selectFrom(PAYMENTS_ENTITLEMENTS_TABLE)
    .selectAll()
    .where("userId", "=", input.userId)
    .where("entitlement", "=", input.entitlement)
    .executeTakeFirst();
  if (written === undefined) {
    throw new InternalError({
      message: "The entitlement could not be recorded.",
      action: "Retry. If it persists, check the app database for the pithy_payments_* tables.",
      detail: `Wrote entitlement "${input.entitlement}" for ${input.userId} but could not read it back.`,
    });
  }
  return PaymentsEntitlement.parse(written);
}
