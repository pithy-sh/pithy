// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import type { PaymentsTables } from "../data/tables";
import {
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
} from "../http/guards";

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
 * `Record<keyof PaymentsTables, …>` rather than a partial map: **a fifth table does not compile until
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
  /** The entitlement read model — what an account holds right now, and why. */
  pithyPaymentsEntitlements: { reads: [PAYMENTS_ENTITLEMENTS_READ_SCOPE] },
  /**
   * Withheld. Every row is a *provider-side* identity — `cus_PithyAda`, an Apple `appAccountToken` — paired
   * with the Pithy user it belongs to. Listing it in bulk hands a management client a cross-reference from
   * a customer's store account to their user id, and there is nothing an operator can do with it that a
   * purchase does not already answer: a purchase names its own owner and its own rail. The one legitimate
   * question it settles — "which Stripe customer is this person" — belongs to a route that answers it for
   * one named user, if it is ever wanted, and not to a page of a thousand of them.
   */
  pithyPaymentsProviderAccounts: {
    withheld:
      "Every row pairs a provider-side account identifier with a Pithy user. In bulk that is a cross-reference nothing on this surface needs, and a purchase already names its owner and rail.",
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
};
