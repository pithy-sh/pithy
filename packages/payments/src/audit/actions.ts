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
  entitlementGranted: "payments/entitlement_granted",
  /** An entitlement was revoked by hand through the control plane. The other of the two, for the same reason. */
  entitlementRevoked: "payments/entitlement_revoked",
} as const;

/** One of the payments audit action codes. */
export type PaymentsAuditAction = (typeof PaymentsAuditActions)[keyof typeof PaymentsAuditActions];
