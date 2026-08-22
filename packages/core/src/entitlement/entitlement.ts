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
 * denies. Runtime denial is the backstop rather than the primary defense — a Worker whose routes gate
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
 * One entitlement the caller holds, as the seam exposes it. This is the resolved read model, not a table:
 * `@pithy-sh/payments` materializes a row per `(holder, entitlement)` and decodes it into this shape.
 *
 * **Who the holder is stays out of this shape, deliberately.** A payments project bills either a person or
 * an organization, and its rows are keyed on that pair — but the seam resolves for *one* caller acting for
 * *one* holder, so the pair is constant across a single `list()` and every element of the result would
 * repeat it. Carrying it here would put a comparison within reach of {@link requireEntitlement} that the
 * gate has no correct way to make (see {@link EntitlementResolver}), and would hand every non-payments
 * provider two fields it cannot fill.
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
  .describe("One entitlement the current caller holds, as the core seam exposes it — the resolved read model.");
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
 * already knows who is asking — a gate never passes a holder, and so can never gate on the wrong one.
 *
 * **That property is why the seam still takes no argument, now that a provider's holder can be an
 * organization rather than a person.** `@pithy-sh/payments` decides which subject the caller is acting
 * for *before* it constructs the resolver: the resolution happens once, in its middleware, against the
 * adopter's own membership model, and the resolver closes over the answer. So a gate cannot pass the
 * wrong holder because it passes none, and the alternative — a `list(holder)` — would put that choice at
 * every call site, where a route reaching for `c.var.auth.userId` under organization billing looks
 * exactly like correct code and quietly checks a company's plan against one employee.
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
  /**
   * Who {@link list} answered for, **for the log and the audit trail only**. Optional: a resolver that
   * cannot say omits it, and every gate behaves exactly as it did before this existed.
   *
   * See {@link EntitlementHolder} for why this is a label and a tenant rather than the holder itself.
   */
  holder?(): Promise<EntitlementHolder | undefined>;
}

/**
 * How a resolver's holder appears in a denial's `detail` and on the denial's audit row — and **nothing a
 * gate may compare**.
 *
 * A provider's holder stopped being a person when `@pithy-sh/payments` learned to bill organizations, and
 * that left a denial unable to say which of two things had happened: a company that has bought nothing,
 * and a caller acting for **no** company at all — the ordinary state of somebody signed in with no
 * organization selected. Both produced `payments resolved []`. They are different problems: one is a sale,
 * the other is a subject resolver returning nothing. The same gap left the denial's audit row with no
 * `tenant`, so a trail could not answer "which of our customers is hitting the paywall" — `actorId` cannot,
 * because one person acts in two tenants.
 *
 * **So why not put the holder on the seam?** Because {@link EntitlementResolver} deliberately takes no
 * holder and returns none: the provider decides who the caller acts for *once*, in its own middleware,
 * before it builds the resolver, and a gate that never receives a holder can never check the wrong one.
 * A field carrying the holder itself would put that choice back within reach — a route comparing a resolved
 * subject against `c.var.auth.userId` looks like careful code and quietly checks a company's plan against
 * one employee.
 *
 * The shape is what keeps that from happening. Neither field is the holder:
 *
 * - **`label`** is display text for one log line. It is not parsed, not matched, and has no format this
 *   package defines — a provider renders it however reads best (`@pithy-sh/payments` uses `user:ada` and
 *   `organization:acme`, its own encoding).
 * - **`tenant`** is the audit dimension and nothing else, opaque exactly as `AuditEvent.tenant` is. `null`
 *   means *the holder is not a tenant* — which is the honest answer under per-person billing, where the
 *   holder is the actor and a tenant echoing `actorId` would be a dimension the app does not have.
 *
 * There is nothing here to compare a caller against, because there is no caller-shaped value: `label` is
 * prose and `tenant` is a dimension. `require.test.ts` pins the property directly — the gate's decision is
 * identical for every holder, including none.
 */
export interface EntitlementHolder {
  /** Display text naming the holder, for a denial's `detail`. Never parsed, never matched. */
  readonly label: string;
  /** The tenant this was resolved for, or null when the holder is not a tenant. `AuditEvent.tenant`. */
  readonly tenant: string | null;
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
