// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import type { PaymentsTables } from "../data/tables";
import {
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_RECONCILE_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
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
   * Withheld. Each row holds the raw verified provider notification exactly as it arrived, and that
   * payload is a bearer artifact — the same thing `responses.ts` refuses to put on a purchase view, for
   * the same reason. There is no projection of a delivery log worth a read scope either: what an operator
   * wants from it is "why did this purchase not update", and that question is answered by the purchase's
   * own status and the audit trail's `payments/webhook_received` events, neither of which is a receipt.
   */
  pithyPaymentsWebhookEvents: {
    withheld:
      "Each row is a raw verified provider payload — a bearer artifact. The question a delivery log is read for is answered by the purchase's status and the audit trail, without handing anyone a receipt.",
  },
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
};
