// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { type AuditEmit, noopEmit } from "@pithy-sh/core/src/audit/recorder";
import { PaymentsAuditActions } from "../audit/actions";
import type { PaymentsConfig, PaymentsLedgerGrant } from "../config/config";
import type { PaymentsPurchase } from "../data/purchase";
import type { PurchaseStatus } from "../data/status";
import type { PurchaseProjection } from "../projection/writer";
import { type ClawbackOutcome, clawbackGrants } from "./clawback";
import { ledgerAccountId, openPaymentsLedger, type PaymentsLedger } from "./ledgerSeam";

/**
 * Fulfillment: turning a projected purchase into the balance a `grants` clause promised.
 *
 * This is deliberately **not** in the projection writer. The writer stays pure D1 so its tests resolve no
 * optional package, and the credit is a separate step its caller runs on what it returned — a route, or any
 * other caller holding a projection. Nothing is lost by the separation, because the credit's idempotency has
 * never rested on call ordering: it rests on the ledger's `UNIQUE (ref)`.
 *
 * ## The ref, which is the whole design
 *
 * `payments:grant:<purchaseId>:<currency>`. Three properties, each load-bearing:
 *
 * - **Per credit, never per purchase.** A duplicate `ref` aborts the ledger's batch, and the ledger reports
 *   that abort as *success* with the current balance — a replay must be a no-op, so it cannot distinguish
 *   itself from one. So a purchase crediting two currencies under one ref would credit the first and silently
 *   drop the second, with nothing anywhere to read. The currency is in the ref for that reason alone.
 * - **A pure function of durable identifiers.** Never `crypto.randomUUID()`, never `Date.now()`. `purchaseId`
 *   is minted once, at first projection, and every later write keeps it — so a retry three days later derives
 *   the identical ref and the ledger recognizes the replay. A ref that varied would double-credit.
 * - **Per billing period on a subscription, for free.** Each renewal is a distinct provider transaction on all
 *   three rails, so it is a distinct purchase row with a distinct id, so it is a distinct ref. The same guard
 *   that makes a redelivery a no-op lets next month's renewal through, with no period arithmetic anywhere.
 *
 * ## When a credit fires
 *
 * Whenever the charge stands — regardless of the projection's `outcome`. Applying a grant for an `ignored`
 * replay is not waste, it is the repair: if a previous delivery projected the purchase and then failed before
 * the ledger write, the redelivery is the only thing that will ever fix it, and the stable ref makes trying
 * free. The one thing checked is whether the money is actually with us; see {@link UNPAID_STATUSES}.
 *
 * A failure that is not the ledger's own refusal propagates. `openLedger` classifies aborts by regexing the
 * error message, so a transient D1 fault arrives unwrapped and un-typed — treating it as "credited nothing"
 * would drop a purchase's currency permanently, where letting it raise leaves the retry to settle it.
 */

/**
 * The statuses in which this charge's money is not with us: a payment still outstanding, one that never
 * arrived at all, or one that was taken back. Everything else — `active`, `canceled`, `expired`, `paused` —
 * describes a period that was paid for, whatever has since become of the subscription.
 *
 * `expired` is the member most easily got wrong in the other direction. It says a period ended, not that its
 * invoice failed; refusing to credit on it would lose a coin pack whose only delivery arrived late. Which is
 * precisely why a termination that took no money needs its own status: **`never_paid`** is here, and reading
 * a never-paid ending as `expired` credited a 100-coin pack for a bank debit that bounced — with no clawback
 * ever to follow it, because nothing was ever charged to reverse. See `data/status.ts`.
 */
const UNPAID_STATUSES: ReadonlySet<PurchaseStatus> = new Set<PurchaseStatus>([
  "in_grace",
  "on_hold",
  "never_paid",
  "refunded",
  "revoked",
]);

/** One balance credit a purchase produced, with the ref that makes it happen exactly once. */
export interface AppliedGrant {
  /** The ledger currency credited. */
  currency: string;
  /** How much, as an integer in the currency's minor unit. */
  amount: number;
  /** The idempotency key the ledger recorded it under. */
  ref: string;
}

/** What one fulfillment did in both directions. Empty on both sides for a catalog with no `grants` clause. */
export interface FulfillmentReport {
  /** The credits applied, in catalog order. */
  granted: readonly AppliedGrant[];
  /** The refund reversals attempted, whether or not the balance covered them. */
  clawedBack: readonly ClawbackOutcome[];
}

/** What the grant modules need beyond the projection: the catalog the `grants` clause lives in. */
export interface GrantOptions {
  /** The resolved catalog. */
  config: PaymentsConfig;
}

/** What {@link fulfillPurchase} needs: the catalog, the audit seam, and optionally a ledger to use. */
export interface FulfillPurchaseOptions extends GrantOptions {
  /** The audit seam. Defaults to core's no-op, so a caller with no recorder composed needs no branch. */
  emit?: AuditEmit;
  /** An already-open ledger. Absent in production — the guarded import supplies one only when it is needed. */
  ledger?: PaymentsLedger;
  /** The clock the ledger stamps its rows with. Injected so a fulfillment is deterministic under test. */
  now?: () => number;
}

/**
 * The idempotency key for one credit. A pure function of two durable identifiers, and the only place the
 * shape is written — a caller reconciling a ledger row back to a purchase derives it the same way.
 */
export function grantRef(purchaseId: string, currency: string): string {
  return `payments:grant:${purchaseId}:${currency}`;
}

/** The ledger grant this purchase's catalog product declares, or undefined for the products that declare none. */
export function ledgerGrantFor(config: PaymentsConfig, productId: string): PaymentsLedgerGrant | undefined {
  return config.products[productId]?.grants?.ledger;
}

/**
 * Whether this purchase's charge stands, and so whether what it bought should be credited.
 *
 * **A `state` row is never paid, whatever its status says**, and the check is on `role` before it is on
 * `status` because the two answer different questions. `status` asks what became of a charge; a
 * subscription's standing is not a charge, so the question does not apply to it and an honest `active`
 * would otherwise read as money that arrived. Lemon Squeezy is the only rail that writes such a row —
 * its subscription webhooks carry no charge at all — and without this line every LS subscriber would be
 * credited once for the subscription on top of once per invoice. See {@link PurchaseRole}.
 */
export function purchaseIsPaid(purchase: Pick<PaymentsPurchase, "status" | "role">): boolean {
  if (purchase.role === "state") return false;
  return !UNPAID_STATUSES.has(purchase.status);
}

/**
 * Credit what a fulfilled purchase's `grants` clause promised. Returns what was asked of the ledger, which is
 * not the same as what changed: a replay asks for the identical credit and the ledger no-ops it.
 */
export async function applyGrants(
  ledger: PaymentsLedger,
  projection: PurchaseProjection,
  options: GrantOptions,
): Promise<AppliedGrant[]> {
  const { purchase } = projection;
  const grant = ledgerGrantFor(options.config, purchase.productId);
  if (grant === undefined || !purchaseIsPaid(purchase)) return [];

  const ref = grantRef(purchase.id, grant.currency);
  // The account is derived from the purchase's subject pair, never from its id alone — `ledgerAccountId`
  // says why, and the clawback derives it the same way so a reversal cannot miss.
  //
  // Identifiers only in the memo. It lands in a queryable ledger row beside a player's balance, so it names
  // what was bought and on which store, and never the artifact that proved it.
  await ledger.credit(ledgerAccountId(purchase), grant.currency, grant.amount, ref, {
    memo: `payments ${purchase.rail} ${purchase.productId}`,
  });
  return [{ currency: grant.currency, amount: grant.amount, ref }];
}

/**
 * Fulfill one projected purchase in both directions: credit what it bought, and reverse what a refund took
 * back where the catalog asks for it.
 *
 * The ledger is opened **lazily, and only when the catalog names a currency**. That laziness is the whole
 * reason the optional peer stays optional: a project selling nothing but features never resolves the import,
 * so it neither installs `@pithy-sh/ledger` nor carries it in a Worker bundle.
 *
 * A refused clawback is recorded here rather than thrown. It is the one fulfillment fact no other table
 * holds — a successful credit or debit is already a ledger row, keyed by a ref that names the purchase — so
 * the audit trail is where a shortfall becomes queryable and alertable.
 */
export async function fulfillPurchase(
  d1: D1Database,
  projection: PurchaseProjection,
  options: FulfillPurchaseOptions,
): Promise<FulfillmentReport> {
  const { purchase } = projection;
  if (ledgerGrantFor(options.config, purchase.productId) === undefined) return { granted: [], clawedBack: [] };

  const ledger = options.ledger ?? (await openPaymentsLedger(d1, { now: options.now }));
  const granted = await applyGrants(ledger, projection, options);
  const clawedBack = await clawbackGrants(ledger, projection, options);

  const emit = options.emit ?? noopEmit;
  for (const attempt of clawedBack) {
    if (attempt.outcome !== "refused") continue;
    await emit({
      action: PaymentsAuditActions.clawbackFailed,
      outcome: "failure",
      // Alert-worthy: the refund stands, the balance does not cover it, and only a human can decide what to
      // do about the difference. A run of these on one product is a catalog that should not claw back at all.
      severity: "critical",
      actorType: "system",
      resourceType: "purchase",
      resourceId: purchase.id,
      metadata: {
        rail: purchase.rail,
        productId: purchase.productId,
        // Both halves, as every record of an owner carries them. An id alone would leave whoever answers the
        // alert unable to say whether the shortfall is a person's balance or a company's.
        subjectType: purchase.subjectType,
        subjectId: purchase.subjectId,
        currency: attempt.currency,
        amount: attempt.amount,
        ref: attempt.ref,
        reason: attempt.error.payload.code,
      },
    });
  }

  return { granted, clawedBack };
}
