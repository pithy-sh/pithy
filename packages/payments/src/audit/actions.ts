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
   * A caller submitted a purchase whose store-account identifier is already bound to a different subject.
   *
   * On Apple and Google that identifier is a value the *app* chose, so one store account legitimately
   * reaching two subjects is possible — a shared device, a reinstall against a new account, one person
   * buying for two organizations. It is also exactly what squatting on another holder's identifier looks
   * like, and the two are indistinguishable from one request.
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
  /**
   * An entitlement was granted by hand through the control plane — a comp, or the repair of a purchase that
   * never projected. Audited because it is one of exactly two ways an entitlement appears without money
   * moving, and because the actor is support tooling rather than the user who benefits.
   */
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
  /**
   * A subscription's plan was changed — a move up or down the ladder.
   *
   * **By the subscriber, on a bearer route** — not through the control plane, unlike the two grant
   * actions above. That distinction is the reason the row matters: an operator acting through the
   * control plane is already accountable to it, while a customer changing their own bill leaves this
   * row and the store's own record and nothing else.
   *
   * Audited even though a purchase row may follow it, and the exception to the rule at the top of this
   * file is the direction of the move. An upgrade settles immediately and does leave a transaction; a
   * downgrade is booked against the next billing period and writes **no** transaction at all (#465), so
   * the purchases table holds nothing until the renewal, and the act that made next month's invoice
   * smaller has no record anywhere else. Auditing only one of the two directions would make the trail
   * agree with the ledger precisely where the ledger is already sufficient, and go silent where it is not.
   *
   * The proration mode is chosen by the rail from the direction of the change and is never a caller's to
   * set. It would belong in the event for exactly that reason — a decision this package made on a
   * customer's behalf — but **the route cannot record it**: the rail returns a `SubscriptionStanding`
   * and no flag saying which mode it picked, so the row carries both plans and both price ids and lets
   * the direction imply the mode. Stated rather than left as a silent omission, because a reader who
   * expects the mode here would otherwise conclude the trail had lost it.
   *
   * Price ids and the direction. Never a quote's totals — a preview is not what was charged, and copying
   * money into the trail would make a second, weaker ledger.
   */
  subscriptionPlanChanged: "payments/subscription_plan_changed",
  /**
   * A subscription was canceled by its subscriber on a bearer route, effective at the end of the
   * period already paid for.
   *
   * The write whose *absence* is the incident. A scheduled cancellation leaves `status` at `active` and
   * blanks `next_billed_at` (recorded against the sandbox, #465), so a subscription that has quietly
   * stopped renewing is indistinguishable, in any projection built from status, from one that has not.
   * When a customer says they never asked to cancel, this row is the whole answer: which actor asked,
   * for which subject, and when.
   */
  subscriptionCanceled: "payments/subscription_canceled",
  /**
   * A scheduled cancellation was withdrawn, and the subscription will renew after all.
   *
   * Its own action rather than an outcome on the cancellation event, because the two are separate acts by
   * possibly separate actors, and the pair is what a dispute is reconstructed from. Folded together, the
   * trail asserts a cancellation and holds nothing that says it was taken back — which reads, to whoever
   * audits later, as a subscription that kept billing after it was canceled.
   */
  subscriptionCancelWithdrawn: "payments/subscription_cancel_withdrawn",
  /**
   * A subscriber asked for a subscription's payments back, on a bearer route.
   *
   * **The one write in this capability that leaves no other record at all.** A refund is a *request*:
   * Paddle holds most live ones awaiting a human, no transaction is created, the purchase rows are
   * untouched, and the entitlement stands. Nothing enters `pithy_payments_purchases` until — and unless —
   * the store approves it weeks later and the webhook arrives. Between the ask and that webhook there is
   * one place recording that somebody asked for money back, for which subject, and which actor asked. This
   * is it, and a rejected refund means that gap is permanent.
   *
   * Its own action rather than an outcome on the cancellation, for the reason the withdrawal has its own:
   * canceling and asking for a refund are separate acts, often minutes apart and sometimes by different
   * actors, and the pair is what a dispute is reconstructed from.
   *
   * **Counts and adjustment ids. Never an amount.** How much a customer is getting back is not decided at
   * this moment by anybody — that is the store's later decision — so a figure here would be a number
   * asserting something nobody has agreed to, in the one table nothing corrects. The adjustment ids are
   * carried because they are the only handle an operator has on money in flight, and they are neither a
   * credential nor a bearer artifact.
   *
   * Emitted **only when an adjustment was actually raised.** A repeat of a request already standing is the
   * no-op, the same as a retried cancel, and a trail claiming two refunds where one was asked for is worse
   * than one claiming none.
   */
  subscriptionRefundRequested: "payments/subscription_refund_requested",
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
  /**
   * A management client started a reconciliation pass.
   *
   * **A write, and audited as one** — this is the trail entry that says a human, on a date, caused every repair
   * the run then made. The repairs carry the run's id, so the trail joins: this row names who pressed, and the
   * grant and revoke rows behind it name what moved. Without it a pass triggered from a browser is
   * indistinguishable from the 04:00 cron, which is exactly the question somebody reading the trail is asking.
   */
  reconcileRunStarted: "payments/reconcile_run_started",
} as const;

/** One of the payments audit action codes. */
export type PaymentsAuditAction = (typeof PaymentsAuditActions)[keyof typeof PaymentsAuditActions];
