// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { grantableEntitlements, type PaymentsConfig } from "../config/config";
import { PaymentsEntitlement } from "../data/entitlement";
import { encodeSubjectReference, type PaymentsSubject } from "../data/subject";
import { PAYMENTS_ENTITLEMENTS_TABLE, paymentsDatabase } from "../data/tables";
import { PaymentsEntitlementNotInCatalogError } from "../error/errors";

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
 * So a grant sets `manual`, and the projection skips a row carrying it. Both shapes work and both last:
 * comping a key the catalog does not sell (`founder`) and comping one it does (`pro`).
 *
 * ## The catalog check is here, at the write
 *
 * {@link grantEntitlement} refuses a key this project does not define, with
 * `payments/entitlement_not_in_catalog`, a 400 naming the key (#300). An operator who meant `pro` and
 * typed `pr` used to get a 200, a row, and a customer who stayed locked out, invisible on both sides.
 *
 * That check first landed in `POST /payments/entitlements/grant`, and lived there alone (#305). A rule at a
 * call site has a second call site eventually: an adopter's own handler, a later route in this package, the
 * reconciliation workflow — each one a path to the row write with the rule removed. So the check moved to
 * the thing being called. The route no longer decides; it reports.
 *
 * The shape that makes that unbypassable is a **split**: `writeEntitlement` below asks nothing and is not
 * exported, and the exported grant takes a {@link PaymentsConfig} it cannot be called without. A caller
 * cannot reach the unchecked half from outside this module, and the type says why.
 *
 * Comping a key nothing sells is therefore **declared** rather than achieved by nobody checking:
 * `manualEntitlements` in `pithy.config.ts` is where an adopter names the keys they comp but do not sell,
 * and those keys are grantable and are published on the catalog read beside the products. The check reads
 * `grantableEntitlements`, so that escape travels with it. Only grants are constrained. A revoke is not, or
 * dropping a product from the catalog would be irreversible for every account still holding its key — which
 * is why {@link revokeEntitlement} takes no config, and must never grow one.
 *
 * A **revoke clears the hold** rather than setting it, which is the deliberate asymmetry. It means a revoke
 * is the exact inverse of a grant — it takes the row back out of a human's hands — and it means a revoke
 * never becomes a permanent block on a user who later pays. That matters: an entitlement the purchases still
 * support is re-derived on the next event, so revoking a *paid* subscription here holds only until the store
 * next says something about it. To end a paid entitlement, refund it through the store; that is the record
 * the projection reads, and the only one that keeps the read model and the money agreeing.
 *
 * A revoke writes an inactive row even when the subject held nothing, because support tooling should not have
 * to know whether a row exists, and because the row is itself the record that somebody decided this account is
 * not entitled.
 *
 * ## The holder is a subject, and both halves are named
 *
 * A comp is a contract somebody signed, and under organization billing the party to it is the company rather
 * than whoever at the company asked. So these take a {@link PaymentsSubject} — the pair, never an id on its
 * own. The pair is the upsert's conflict target, the read-back's predicate and the row's identity, and it is
 * the same pair the read path filters on, so a grant and the gate that honours it cannot disagree about who
 * was meant. `user:acme` and `organization:acme` are two holders: nothing in the kit makes those id spaces
 * disjoint, and support revoking the right id under the wrong kind must take nothing away from the other.
 */

/**
 * Who, and to what. The caller has already been through `requireControlPlane`.
 *
 * It **extends** {@link PaymentsSubject} rather than restating two strings, so a caller cannot supply half a
 * holder and the type is the same one every other subject-bearing surface takes. Never the caller's own
 * subject — this is support acting on somebody else's account.
 */
export interface ManualEntitlementInput extends PaymentsSubject {
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
 *
 * Refuses a key this project does not define — no product grants it and `manualEntitlements` does not
 * declare it — before any row is written. The config is a parameter rather than a closure because a grant
 * without one is the defect: see the module doc.
 */
export async function grantEntitlement(
  d1: D1Database,
  config: PaymentsConfig,
  input: ManualEntitlementInput,
  options: ManualEntitlementOptions = {},
): Promise<PaymentsEntitlement> {
  const grantable = grantableEntitlements(config);
  if (!grantable.has(input.entitlement)) {
    throw new PaymentsEntitlementNotInCatalogError({
      message: `No entitlement "${input.entitlement}" is defined here.`,
      // The set goes in `detail`, which the HTTP codec strips. An operator reading the customer's logs gets
      // the near miss spelled out; the caller learns only which key it sent, because what this project sells
      // is a separate disclosure behind `payments:catalog:read`.
      detail: `No product grants "${input.entitlement}" and \`manualEntitlements\` does not declare it. Defined: ${[...grantable].sort().join(", ") || "nothing"}.`,
    });
  }
  return writeEntitlement(d1, input, true, options);
}

/**
 * Revoke an entitlement by hand and release the hold. Idempotent, and records the decision even where there
 * was nothing to clear. A key the purchases still support is re-derived on the next event — see the module doc.
 *
 * **Takes no config, deliberately.** A revoke of a key the catalog has since dropped must stay legal, or a
 * catalog edit becomes irreversible for every account still holding it. The missing parameter is the rule.
 */
export function revokeEntitlement(
  d1: D1Database,
  input: ManualEntitlementInput,
  options: ManualEntitlementOptions = {},
): Promise<PaymentsEntitlement> {
  return writeEntitlement(d1, input, false, options);
}

/**
 * The upsert both directions share. One statement, on the `UNIQUE (subjectType, subjectId, entitlement)`
 * conflict target, so a concurrent write cannot produce a second row for one key.
 *
 * The target is all three columns because that is the index the table really has. A two-column target names
 * no unique constraint and SQLite refuses the statement outright — which is the loud failure worth having
 * here, rather than an upsert that quietly inserts a second row per holder and leaves two answers to one
 * gate. The read-back's predicate is the same three columns for the same reason.
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
    // Both halves off the one input, together. Nothing here pairs a kind from config with an id from a row.
    subjectType: input.subjectType,
    subjectId: input.subjectId,
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
        oc.columns(["subjectType", "subjectId", "entitlement"]).doUpdateSet({
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
    .where("subjectType", "=", input.subjectType)
    .where("subjectId", "=", input.subjectId)
    .where("entitlement", "=", input.entitlement)
    .executeTakeFirst();
  if (written === undefined) {
    throw new InternalError({
      message: "The entitlement could not be recorded.",
      action: "Retry. If it persists, check the app database for the pithy_payments_* tables.",
      detail: `Wrote entitlement "${input.entitlement}" for ${encodeSubjectReference(input)} but could not read it back.`,
    });
  }
  return PaymentsEntitlement.parse(written);
}
