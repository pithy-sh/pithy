// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import type { PaymentsTables } from "../data/tables";
import {
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_RECONCILE_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
  PAYMENTS_USAGE_READ_SCOPE,
  PAYMENTS_WEBHOOKS_READ_SCOPE,
} from "../http/scopes";

/**
 * What a management client may learn from each table payments owns.
 *
 * **This is a decision, taken once, where the tables are.** Issue #247 was not a missing route so much
 * as a missing question: payments stored a customer's whole purchase history and their entitlement read
 * model, shipped two control-plane writes against the second, and nobody ever asked whether a management
 * client could *see* either. Three panes in the first adopter computed `absent` and dropped out of the
 * rail. Absent, not blocked — no grant restores a route that does not exist.
 *
 * So every table declares which side of the line it is on, and the type is
 * `Record<keyof PaymentsTables, …>` rather than a partial map: **a sixth table does not compile until
 * somebody decides what a management client may see of it.** That is the structural half of the gate.
 * `coverage.test.ts` is the other half — it checks that a table declaring a read has a control-plane
 * `GET` demanding exactly that scope, and that every resource this capability can *write* it can also
 * read.
 *
 * A withheld table states its reason here rather than in a test's exclusion list, because the reason is
 * a property of the table and belongs next to it. Neither reason below is "no pane asked for it".
 */

/** One table's disclosure decision: the reads that return its rows, or why there are none. */
export type PaymentsDisclosure =
  | {
      /**
       * Every control-plane scope that returns rows from this table. Non-empty by construction, so
       * "readable" cannot degrade into "readable by nothing" through an edit.
       */
      readonly reads: readonly [ControlPlaneScope, ...ControlPlaneScope[]];
    }
  | {
      /** Why no management client may read this table. A property of the table, not an exemption. */
      readonly withheld: string;
    };

/** Every payments table, and what a management client may learn from it. */
export const PAYMENTS_TABLE_DISCLOSURE: Record<keyof PaymentsTables, PaymentsDisclosure> = {
  /**
   * The purchase log, read two ways. `payments:purchases:read` is the whole projection of provider
   * truth; `payments:subscriptions:read` is the same rows narrowed to the ones that renew, so a tool
   * watching renewals can be granted the forward-looking half without the customer's entire order
   * history. Neither read ever selects `payload` — see `read.ts`.
   */
  pithyPaymentsPurchases: { reads: [PAYMENTS_PURCHASES_READ_SCOPE, PAYMENTS_SUBSCRIPTIONS_READ_SCOPE] },
  /** The entitlement read model — what a subject holds right now, and why. */
  pithyPaymentsEntitlements: { reads: [PAYMENTS_ENTITLEMENTS_READ_SCOPE] },
  /**
   * Withheld, and the argument is stronger now that the far side is a subject rather than a user. Every row
   * is a *provider-side* identity — `cus_PithyAda`, an Apple `appAccountToken` — paired with the subject
   * that holds it: a Pithy user, or an organization whose id came out of the adopter's own membership
   * model. Listing it in bulk hands a management client a cross-reference from a store account to the
   * adopter's internal id space, and under organization billing that maps a company to its billing
   * identity at every store it sells through.
   *
   * There is nothing an operator can do with the page that a purchase does not already answer: a purchase
   * names its own subject and its own rail. The one legitimate question it settles — "which Stripe customer
   * is this holder" — belongs to a route that answers it for one named subject, if it is ever wanted, and
   * not to a page of a thousand of them.
   */
  pithyPaymentsProviderAccounts: {
    withheld:
      "Every row pairs a provider-side account identifier with a subject — a Pithy user, or an organization from the adopter's own membership model. In bulk that is a cross-reference from a store's id space into the adopter's, and nothing on this surface needs it: a purchase already names its subject and its rail.",
  },
  /**
   * The webhook-event log, on its own scope (#830).
   *
   * It was withheld, on the argument that every row is a raw provider payload and that the purchase's status
   * and the audit trail answer what a delivery log is read for. The second half did not survive contact with
   * the first adopter: a notification that arrived and **never** projected leaves no purchase status to read
   * and no `payments/webhook_received` success to find — it is precisely the row nothing else explains, and
   * the one `pithy-sh/dashboard#167` needs to say why a purchase is paid and not entitled.
   *
   * The first half still holds, so the read is a projection rather than a table dump: the payload is never
   * selected (the event's type is read out of it by the database), and the stored `error` crosses as its code
   * alone. See `read.ts`'s `listWebhookEvents` and `http/view.ts`'s `adminWebhookEventView`.
   */
  pithyPaymentsWebhookEvents: { reads: [PAYMENTS_WEBHOOKS_READ_SCOPE] },
  /**
   * The reconciliation run log — operational state, on its own scope.
   *
   * Readable, and readable *separately*, because it is the one table here that is not about a customer. A
   * run names no account, no transaction and no amount; it says whether the compensating control for a
   * delivery mechanism that is known to fail has been firing. A health monitor should be able to hold
   * exactly this, and an adopter granting it should not thereby disclose what anybody bought.
   */
  pithyPaymentsReconcileRuns: { reads: [PAYMENTS_RECONCILE_READ_SCOPE] },
  /**
   * Withheld. One opaque resume token per stream, and nothing else — no amount, no customer, no event.
   *
   * Withheld because there is nothing here a management client could act on and one thing it could break:
   * a pane that could read a cursor invites a pane that could write one, and a cursor moved forward skips
   * every event between the old value and the new, silently and unrepairably. The sweep's own state is
   * the sweep's; what it *found* is in the purchases and webhook-event tables, which are readable.
   */
  pithyPaymentsSyncCursors: {
    withheld:
      "A sweep's resume token is internal bookkeeping, not a fact about a customer. Reading it answers nothing a management client asks, and the write it invites would silently skip every event between two cursor values.",
  },
  /**
   * One subject's override, read on the subject's entitlement read — the version a set must send back, the
   * pins, and whether the subject is `unrestricted`. Read where the entitlements are because the two answer
   * one question together: what this subject may have, and why. `unrestricted` also surfaces on the
   * entitlement listing, because a privilege this size must not be inferable only from a row nobody opens.
   */
  pithyPaymentsOverrides: { reads: [PAYMENTS_ENTITLEMENTS_READ_SCOPE] },
  /**
   * Withheld. A counter exists to refuse a write at a limit and for no other purpose, and the subject read
   * already says what the limit is. A page of every subject's usage is a page of every customer's activity,
   * and nothing a management client does needs it.
   */
  pithyPaymentsMeterCounters: {
    withheld:
      "A meter counts to refuse at a limit and for nothing else. The limit is on the subject's entitlement read; a page of every subject's usage is a page of every customer's activity, which no pane needs.",
  },
  /**
   * The last count reported for a subscription, on the subscription read — what a quantity-billed customer
   * was billed for, and when it was sent.
   */
  pithyPaymentsUsageReports: { reads: [PAYMENTS_SUBSCRIPTIONS_READ_SCOPE] },
  /**
   * The usage-reporting run log, on its own scope — the reporting pass's health, as the reconcile run log is
   * reconciliation's. Unlike that log it names subjects, in the findings an operator acts on, so it is not
   * the health monitor's scope: it is granted to whoever answers "why was this customer not billed".
   */
  pithyPaymentsUsageRuns: { reads: [PAYMENTS_USAGE_READ_SCOPE] },
};
