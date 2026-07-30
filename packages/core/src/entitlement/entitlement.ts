// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The entitlement seam. `@pithy-sh/core` owns the contract — what an entitlement *is*, how a request
 * resolves the caller's, and the read-time rule that decides whether one grants access. It owns no
 * payments logic: `@pithy-sh/payments` is the provider that fills the seam, and any capability that
 * gates on a paid feature depends on this file rather than on that package (principle 4).
 *
 * **The uncomposed default denies.** This is the one deliberate difference from the audit seam next
 * door. Audit's `emit()` no-ops when no audit capability is composed, and that is safe — a missing
 * audit write cannot grant anyone access. An entitlement check is a gate, so a missing provider must
 * fail closed: {@link noEntitlementProvider} resolves to nothing, and every `requireEntitlement()`
 * denies. Runtime denial is the backstop rather than the primary defence — a Worker whose routes gate
 * on entitlements while composing no provider is a composition error `pithy doctor` reports, not
 * something an adopter is meant to discover as production 403s.
 */

/**
 * A logical entitlement key — `pro`, `ads_removed`. Lowercase, digits, and underscores, because the
 * key is a stable identifier gating code names, not display copy.
 *
 * The pattern is the load-bearing distinction of the whole capability: **a product is not an
 * entitlement.** `pro_monthly` and `pro_annual` are two products, in three rails' catalogs, granting
 * one entitlement — `pro`. Gating code never names a SKU.
 */
const ENTITLEMENT_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export const EntitlementKey = z
  .string()
  .min(1)
  .max(64)
  .regex(
    ENTITLEMENT_KEY_PATTERN,
    "An entitlement key is lowercase letters, digits, and underscores, starting with a letter.",
  )
  .describe(
    "A logical entitlement key (`pro`, `ads_removed`) — what gating code names. Never a store SKU: many products across many rails grant one key.",
  );
export type EntitlementKey = z.output<typeof EntitlementKey>;

/**
 * One entitlement a user holds, as the seam exposes it. This is the resolved read model, not a table:
 * `@pithy-sh/payments` materializes a row per `(userId, entitlement)` and decodes it into this shape.
 *
 * `active` and `expiresAt` are both present, and both matter. The flag is an optimization written by
 * the projection; the timestamp is the truth. {@link entitlementGrantsAccess} applies both, so a
 * subscription that lapsed with no notification arriving stops granting access on the read path
 * without waiting for a write.
 */
export const Entitlement = z
  .object({
    key: EntitlementKey.describe("The entitlement key this grant is for."),
    active: z
      .boolean()
      .describe(
        "Whether the granting purchase was in an access-granting state when the projection last wrote this row. An optimization, not the truth — `expiresAt` is rechecked on every read.",
      ),
    expiresAt: z
      .date()
      .nullable()
      .describe(
        "When the grant lapses, or null for a grant that never does (a non-consumable purchase). Evaluated at read time, so a silent lapse revokes access without a write.",
      ),
    source: z
      .string()
      .nullable()
      .describe(
        "Provenance — an opaque reference to whatever currently grants this entitlement (a purchase id, or a support grant). Opaque to core; the provider decides what it means.",
      ),
  })
  .describe("One entitlement a user holds, as the core seam exposes it — the resolved read model.");
export type Entitlement = z.infer<typeof Entitlement>;

/**
 * The read-time rule, in one place: an entitlement grants access when the projection marked it active
 * **and** it has not expired. Applied by {@link requireEntitlement} rather than left to each provider,
 * so the recheck is a property of the seam instead of something a provider must remember.
 *
 * A read never writes. Repairing a stale row is the reconciliation Workflow's job, which keeps the hot
 * path a pure read.
 */
export function entitlementGrantsAccess(entitlement: Entitlement, now: Date): boolean {
  if (!entitlement.active) return false;
  return entitlement.expiresAt === null || now.getTime() < entitlement.expiresAt.getTime();
}

/** Every key in `entitlements` that grants access at `now`, deduped. The set a gate is checked against. */
export function grantedEntitlementKeys(entitlements: readonly Entitlement[], now: Date): Set<string> {
  const granted = new Set<string>();
  for (const entitlement of entitlements) {
    if (entitlementGrantsAccess(entitlement, now)) granted.add(entitlement.key);
  }
  return granted;
}

/**
 * The resolver seam on the request context (`c.var.entitlements`). One method: every entitlement the
 * **current caller** holds. The resolver is built per request by the provider's middleware, so it
 * already knows who is asking — a gate never passes a user id, and so can never gate on the wrong one.
 *
 * `provider` names the capability answering, or is `null` when none is composed. It exists so a denial
 * can say *which* of the two reasons it was — genuinely unentitled, or nothing wired — in `detail`,
 * where an operator sees it and a client never does.
 */
export interface EntitlementResolver {
  /** The capability resolving entitlements (`payments`), or null when none is composed. */
  readonly provider: string | null;
  /** Every entitlement the current caller holds, granting or not. The gate applies the read-time rule. */
  list(): Promise<readonly Entitlement[]>;
}

/**
 * The default resolver when no provider is composed: hold nothing. Every gate denies, which is the
 * fail-closed default the seam exists to guarantee. `createBackend` seeds it on every request, and a
 * provider's middleware replaces it.
 */
export const noEntitlementProvider: EntitlementResolver = {
  provider: null,
  list: async () => [],
};

/**
 * The audit action a denied entitlement gate records, through the core `emit()` seam. Part of the
 * federated `domain/reason` taxonomy — core owns this one because core owns the gate. A blocked
 * attempt is a first-class audit record (`outcome: "denied"`), not only a 403.
 */
export const ENTITLEMENT_DENIED_ACTION = "entitlement/denied";
