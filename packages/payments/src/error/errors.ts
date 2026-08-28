// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { MessageParams } from "@pithy-sh/core/src/i18n/catalog";

/**
 * `@pithy-sh/payments` throw sugar. The `payments/*` codes live in core's closed `KitErrorPayload` union
 * (CLAUDE.md §Errors); these subclasses are the package-local vehicles that set one of those members.
 * Runtime code in this package throws one of these, never a plain `new Error`.
 *
 * **A store's raw error text, a receipt payload, a webhook signature, and a purchase token belong in
 * `detail`, never `message`.** The HTTP codec strips `detail`, and that is the single security boundary
 * between what an operator reads in a log and what a caller reads in a response. Every default `message`
 * below is written to be safe to hand a stranger.
 *
 * One code is absent from what this package raises, and deliberately: `payments/entitlement_required` is
 * constructed by core's `requireEntitlement()`. The gate lives in core because a gate that arrives with a
 * package fails **open** when that package is absent — so core owns both the middleware and its payload,
 * and the subclass here exists so the domain's throw sugar is complete and every member of the namespace
 * has exactly one vehicle.
 */

interface PaymentsErrorArgs {
  message?: string;
  action?: string;
  detail?: string;
  /**
   * Values a translating client interpolates into its own wording for this code. Client-facing, so —
   * unlike `action` and `detail` — these cross the boundary with `message`.
   */
  params?: MessageParams;
}

/** The receipt could not be read at all. Nothing was asked of the provider. */
export class PaymentsInvalidReceiptError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/invalid_receipt",
        status: 400,
        message: args.message ?? "That receipt could not be read.",
        action: args.action ?? "Submit the transaction exactly as the store SDK returned it.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** The rail was asked and said no. Distinct from the rail failing to answer at all. */
export class PaymentsVerificationFailedError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/verification_failed",
        status: 400,
        message: args.message ?? "The store did not recognize that purchase.",
        action: args.action ?? "Restore purchases and retry. If it persists, contact support.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * An inbound notification failed its authenticity check. 401, not 403: a failed signature means the caller
 * did not prove who it is, which is a different statement from a known caller being refused.
 */
export class PaymentsWebhookUnverifiedError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/webhook_unverified",
        status: 401,
        message: args.message ?? "That notification could not be verified.",
        action: args.action ?? "Check the webhook signing secret registered for this environment.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** The request names a rail this project has not enabled. Rails are config, so a missing one is a 404. */
export class PaymentsRailNotConfiguredError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/rail_not_configured",
        status: 404,
        message: args.message ?? "That payment method is not available.",
        action: args.action ?? "Enable the rail in the `rails` block of pithy.config.ts and redeploy.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** No catalog product maps the rail's SKU. The catalog is config, so a new SKU needs a deploy. */
export class PaymentsProductNotFoundError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/product_not_found",
        status: 404,
        message: args.message ?? "That product is not for sale here.",
        action: args.action ?? "Add the SKU to the `products` catalog in pithy.config.ts and redeploy.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * A sandbox purchase reached a production deployment, or the reverse. Rejected outright — granting a real
 * entitlement from a sandbox transaction is the most common in-app-purchase security defect there is.
 */
export class PaymentsEnvironmentMismatchError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/environment_mismatch",
        status: 400,
        message: args.message ?? "That purchase belongs to a different store environment.",
        action: args.action ?? "Use a production purchase against production, and a sandbox one against sandbox.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * The transaction is already projected against a different user. A replay by its own owner is a 200 — the
 * write path is idempotent — but a receipt lifted from another account is refused rather than silently
 * rebound, which is what makes a stolen receipt worthless.
 */
export class PaymentsReceiptAlreadyOwnedError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/receipt_already_owned",
        status: 409,
        message: args.message ?? "That purchase belongs to another account.",
        action: args.action ?? "Sign in as the account that made the purchase, then restore it.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * The rail could not be reached, or answered with a server error. The purchase is neither granted nor
 * refused: the reconciliation Workflow repairs it, so the caller may retry.
 */
export class PaymentsProviderUnavailableError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/provider_unavailable",
        status: 503,
        message: args.message ?? "The store did not answer.",
        action: args.action ?? "Retry shortly. Your purchase is safe and will be reconciled either way.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * A refund's clawback debit was refused by the ledger, because the balance no longer covers it.
 *
 * Constructed far more often than it is thrown. A clawback runs after the refund is already recorded, so
 * raising this at the caller would undo nothing and would turn a store's own webhook into a 5xx it retries
 * forever. Instead the payload is *recorded* — the audit trail carries the code, the amount, and the account —
 * which is what makes a failed clawback queryable and alertable rather than a line in a log. The class exists
 * so that record is the same shape as every other failure in the system, and so an adopter's own tooling can
 * raise the code when it has a caller to answer.
 */
export class PaymentsClawbackFailedError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/clawback_failed",
        status: 409,
        message: args.message ?? "That refund could not be reversed against the balance.",
        action: args.action ?? "Review the account's ledger. The balance was spent before the refund arrived.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * A manual grant named an entitlement key this project does not define.
 *
 * 400 rather than the 404 the catalog's other refusals use, and the difference is what the caller named. A
 * SKU or a product id names a *resource* the catalog either holds or does not, so a miss is Not Found. An
 * entitlement key names the *vocabulary* gating code is written in, and a key outside it is a malformed
 * request — `pr` for `pro`, `pro ` with a trailing space, a key renamed a release ago. Unchecked, each of
 * those was a 200, a row, and a customer who stays locked out with nothing anywhere to read.
 *
 * **The `message` echoes the key and never the set.** A caller learns which key it got wrong, because it
 * sent it. What this project defines is a separate disclosure behind `payments:catalog:read`, and a refusal
 * that listed it would be that read, ungated.
 */
export class PaymentsEntitlementNotInCatalogError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/entitlement_not_in_catalog",
        status: 400,
        message: args.message ?? "That entitlement is not one this project defines.",
        action:
          args.action ??
          "Grant a key one of the catalog's products lists, or declare it in `manualEntitlements` in pithy.config.ts.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/** The caller does not hold an entitlement the route requires. Core's gate is what normally raises it. */
export class PaymentsEntitlementRequiredError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/entitlement_required",
        status: 403,
        message: args.message ?? "This feature requires an active subscription or purchase.",
        action: args.action ?? "Purchase or restore the product that grants access, then retry.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * A discount code the store would not accept — unknown, expired, exhausted, or not valid for what is being
 * bought.
 *
 * **400 and its own code, never a generic checkout failure.** A customer told "something went wrong" at
 * checkout concludes their card was declined and stops trying; one told their code was not accepted removes
 * the code and buys. The two are a different sentence on the screen and a different outcome for the sale.
 *
 * The code is echoed in `message` because the caller sent it and it is what they need to correct. The
 * store's own reason rides in `detail`, which the HTTP codec strips.
 */
export class PaymentsDiscountInvalidError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/discount_invalid",
        status: 400,
        message: args.message ?? "That discount code was not accepted.",
        action: args.action ?? "Check the code, or continue without one.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * A write path could not learn which subject the caller is acting for.
 *
 * Under organization billing the capability asks the adopter *who is this caller acting for* and the
 * adopter answers from its own session — it has the memberships, and this package never learns what an
 * organization is. An unanswered seam on a **read** needs no code at all: the query holds nothing, the
 * gate denies, and unentitled is the direction every gate in the kit already fails. A **write** has
 * nowhere to fail to. Submitting a purchase, restoring, opening checkout, opening the billing portal —
 * each of them has a row or a session to create and no holder to create it against. Writing nothing and
 * answering 200 is the worse outcome by a distance: the customer is charged by the store, the webhook
 * arrives for a subject nobody stamped, and the money is real while the entitlement is not.
 *
 * **403, not 400 and not 500.** The caller is authenticated and the request is well-formed, so it is not
 * a bad request. And an operator reading *our* logs finds nothing to fix, because what is missing is the
 * adopter's resolver returning a value — so it is not a fault of ours either.
 *
 * The three fields split hard here. `message` tells a caller to pick an account, which is the one thing
 * they can do about it. `action` names `billingSubject` and the resolver, which are an operator's words
 * and a small map of the deployment a stranger has no need of. `detail` carries what the resolver was
 * asked and what it gave back. The codec strips the last two.
 */
export class PaymentsSubjectUnresolvedError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/subject_unresolved",
        status: 403,
        message: args.message ?? "No billing account is selected. Choose one, then retry.",
        action:
          args.action ??
          'This project sets `billingSubject: "organization"`. Have the subject resolver in pithy.config.ts return the organization the caller is acting for.',
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}

/**
 * A subscription cannot be changed, or refunded, the way it was asked. The item shape is one this rail
 * will not reproduce, the subscription is already canceled, there is no payment on it to refund, or the
 * outcome asked for contradicts the state it is in — a plan move on a subscription whose cancellation is
 * already scheduled, where honoring one instruction means discarding the other (#465).
 *
 * **A no-op is not a contradiction, and must not throw.** A change to the plan already held, and a cancel
 * when that cancellation is already scheduled, name a state the subscription is already in. Both return
 * success without calling the provider. That is the idempotency answer for a retried write: a client that
 * loses a response and sends the same instruction again is not in conflict with anything, and answering 409
 * would turn every duplicate submission into an incident. Only a request that cannot be reconciled with the
 * present state reaches this code.
 *
 * **One code for all of it, and that is the argument, not an economy.** The obvious alternative was four:
 * `subscription_multi_item`, `subscription_quantity_ambiguous`, `subscription_already_canceled`,
 * `subscription_state_conflict`. Every one of them is the same 409, hands a caller the same sentence, and
 * asks them to do the same thing — re-read the subscription and ask for something its present state
 * allows. A code exists so a client can *branch*, and four codes nothing branches on is four members of
 * core's closed union, four translation catalog keys, and a `switch` whose arms all render one string.
 * What actually differs between the four is a fact about somebody's billing — how many items, which
 * price, what quantity, what date — and that is throw-site context, which is what `detail` is and which
 * the codec strips. So the distinction is kept where it is useful and off the wire where it is a leak.
 *
 * **The refund verb refuses through this code too, and the name is the only reason that needs saying.**
 * `subscription_change_refused` reads as being about a plan move, so a reader looking for the code a
 * refund refusal carries would conclude there is none. There is: a set with no payment in it, a payment
 * the store will not refund because it is not completed, a transaction the store does not know, and a set
 * too large to issue inside one request are all 409s, all tell the caller the same thing — re-read the
 * subscription and its payments, then ask for something the present state allows — and nothing branches on
 * telling them apart. Which of the four it was is a fact about somebody's billing, which is `detail`.
 * **A refund that is already standing is not here at all**: it is a per-payment `already_requested`
 * outcome and a 200, because it is the state the caller asked for. See `data/subscription.ts`.
 *
 * The one case that could earn its own code is "already canceled", because a screen genuinely wants to
 * say *ends on the 15th* rather than *cannot be changed*. It does not earn it here: the screen learns
 * that from the subscription it just read, which carries `scheduled_change.effective_at`. An error code
 * is for a caller holding nothing else, and this caller is holding the subscription.
 *
 * **409, and neither 400 nor 500.** The request is well-formed and names a price this project sells, so
 * it is not a bad request. Nothing is broken and there is nothing in a log for an operator to fix, so it
 * is not ours. It is a conflict with the current state of the resource, which is the one thing 409 says,
 * and it is what tells a client to refetch rather than to re-word.
 *
 * **Why refusing beats guessing**, since the refusal is the expensive-looking choice. A plan change
 * replaces the whole items array: sending one item to a two-item subscription silently deletes the other,
 * and inventing a quantity over- or under-charges a real card. Both failures are writes to somebody's
 * billing that no read afterwards can distinguish from an intended change. A 409 is recoverable by a
 * human in a minute; a dropped add-on is discovered on an invoice.
 *
 * `message` is safe to hand a stranger and names nothing about the subscription. `action` is the
 * operator's half. `detail` carries the subscription id, the item shape, the status, the dates — none of
 * which cross the boundary. `params` is the exception, and deliberately: it is client-facing, so a date a
 * screen means to render in the reader's own language goes there and nowhere else.
 */
export class PaymentsSubscriptionChangeRefusedError extends PithyError {
  constructor(args: PaymentsErrorArgs = {}, options?: { cause?: unknown }) {
    super(
      {
        code: "payments/subscription_change_refused",
        status: 409,
        message: args.message ?? "That subscription cannot be changed that way.",
        action:
          args.action ??
          "Re-read the subscription's current state — its status, what it holds, and any scheduled change — then ask for a move that state allows.",
        detail: args.detail,
        params: args.params,
      },
      options,
    );
  }
}
