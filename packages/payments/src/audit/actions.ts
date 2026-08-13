// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The audit action codes `@pithy-sh/payments` emits, as `domain/reason` strings under the `payments` domain.
 *
 * Payments emits through core's seam (`c.var.emit`) and never imports `@pithy-sh/audit` — audit is optional
 * (principle 4: depend on core seams, not on other capabilities). With audit absent the seam is a no-op; with
 * it composed these land in `pithy_audit_events`. The taxonomy is federated, so this list is owned here and
 * core holds no union of every action.
 *
 * **What is audited, and why these.** Money moving is not itself interesting — the purchases table already
 * records every transaction, in more detail than an audit event could. What an audit trail adds is the
 * *attempts*: a receipt that was refused, a notification that failed its signature check, an entitlement that
 * appeared without a payment. Those are the security-relevant events, and they are the ones a trail is read
 * for after the fact.
 *
 * **Never put a credential, a receipt, a purchase token, or a webhook signature in an event's metadata.** The
 * trail is queryable and long-lived, and a receipt is a bearer artifact — the same rule as `detail` on a
 * `PithyError`, for the same reason.
 */
export const PaymentsAuditActions = {
  /** A client-submitted receipt was verified and projected. `denied` when it belonged to another account. */
  purchaseVerified: "payments/purchase_verified",
  /** A restore re-submitted a store's transaction history against the authenticated caller. */
  purchaseRestored: "payments/purchase_restored",
  /** An authentic provider notification was received. `failure` when it arrived with nobody to project against. */
  webhookReceived: "payments/webhook_received",
  /** A notification failed its authenticity check. Always `denied`, and the reason a forgery is visible at all. */
  webhookUnverified: "payments/webhook_unverified",
  /**
   * A caller submitted a purchase whose store-account identifier is already bound to a different Pithy user.
   *
   * On Apple and Google that identifier is a value the *app* chose, so one account legitimately reaching two
   * Pithy users is possible — a shared device, a reinstall against a new account. It is also exactly what
   * squatting on another user's identifier looks like, and the two are indistinguishable from one request.
   * So the binding is left alone (the first one stands) and the attempt is recorded at `warning`: one is
   * noise, a pattern of them against different identifiers is somebody enumerating.
   */
  providerAccountContested: "payments/provider_account_contested",
  /**
   * A reconciliation pass found a purchase whose stored state disagreed with the store's, and repaired it.
   *
   * Audited at `warning` rather than `info`, and this is the one audit event that is about **us** rather than
   * about a caller. One drift is a dropped delivery. Repeated drift on the same rail means the webhook path is
   * broken — a rotated signing key, a Pub/Sub subscription pointing at a retired deployment — and the only
   * place that pattern is visible is a trail of these. A pass that finds nothing emits nothing.
   */
  purchaseReconciled: "payments/purchase_reconciled",
  /**
   * A hosted checkout session was created for a caller. Money has not moved — that is the webhook's event — but
   * this is the record of who was sent to pay for what, which is what a disputed charge is reconstructed from.
   */
  checkoutStarted: "payments/checkout_started",
  /**
   * A billing-portal session was opened. Audited because the portal shows and can cancel a customer's whole
   * billing history, so which caller opened one against which store account is a security-relevant fact.
   */
  portalOpened: "payments/portal_opened",
  /**
   * A refund's clawback debit was refused because the balance no longer covered it. Always `failure`, always
   * `critical`.
   *
   * The only fulfillment event that is audited, and the reason is the rule at the top of this file: a
   * successful credit or debit is already a ledger row keyed by a ref that names the purchase, so auditing it
   * would duplicate a better record. A refusal is a row that does **not** exist anywhere — the refund stands,
   * the balance is short, and the difference is a decision only a human can make. This is where it becomes
   * queryable.
   */
  clawbackFailed: "payments/clawback_failed",
  /**
   * An entitlement was granted by hand through the control plane — a comp, or the repair of a purchase that
   * never projected. Audited because it is one of exactly two ways an entitlement appears without money
   * moving, and because the actor is support tooling rather than the user who benefits.
   */
  /** A discount code was minted at a store. An administrative act with a cost attached, so it is recorded. */
  discountCreated: "payments/discount_created",
  /**
   * A management client listed the discount codes a store holds.
   *
   * Its own action rather than a flag on the mint event. A read-scoped connection polling a pane would
   * otherwise write thousands of mint-shaped rows into the one record of who decided a customer should pay
   * less — and `payments:discounts:read` is granted precisely to connections that cannot mint anything.
   */
  discountsRead: "payments/discounts_read",
  entitlementGranted: "payments/entitlement_granted",
  /** An entitlement was revoked by hand through the control plane. The other of the two, for the same reason. */
  entitlementRevoked: "payments/entitlement_revoked",
  /**
   * A management client read the purchase log.
   *
   * **Reads are audited here, and only on this surface.** The rule at the top of this file still holds for
   * the adopter's own users: a buyer reading their own purchases is not a security-relevant event, and
   * auditing it would drown the trail. A *management* read is the opposite case — a credential paging every
   * account's commerce leaves no other trace anywhere, and the whole point of the control plane is that a
   * customer can reconstruct what a dashboard did with the access they granted it.
   *
   * Counts and filters only. Never a row, never an amount, never a provider identifier: copying the
   * purchase log into the audit trail would make a second purchase log with weaker access rules than the
   * first.
   */
  purchasesRead: "payments/purchases_read",
  /** A management client read the subscriptions. The narrower half of the purchase log, recorded separately. */
  subscriptionsRead: "payments/subscriptions_read",
  /**
   * A management client read the entitlement model — the page, or one account's.
   *
   * The read that pairs with `entitlement_granted` and `entitlement_revoked`, so a trail shows what a
   * console looked at as well as what it changed.
   */
  entitlementsRead: "payments/entitlements_read",
  /**
   * A management client read the catalog — what this project sells.
   *
   * Audited like the others, and the reason is the same one: the customer's ability to reconstruct what a
   * dashboard did with the access they granted does not have an exception for the reads that touch no
   * account. This one discloses no person and no transaction, so the event carries a count and nothing
   * else — which is also the only fact about it worth asking after.
   */
  catalogRead: "payments/catalog_read",
  /**
   * A management client read the reconciliation run log.
   *
   * Audited like every other management read, and the rule has no exception for the one that touches no
   * account: the customer's ability to reconstruct what a dashboard did with the access they granted is the
   * point, not the sensitivity of the rows. Counts and filters only — the runs themselves are already a
   * queryable table, and copying them into the trail would make a second one.
   */
  reconcileRunsRead: "payments/reconcile_runs_read",
} as const;

/** One of the payments audit action codes. */
export type PaymentsAuditAction = (typeof PaymentsAuditActions)[keyof typeof PaymentsAuditActions];
