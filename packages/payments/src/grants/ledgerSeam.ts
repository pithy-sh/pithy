// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { encodeSubjectReference, type PaymentsSubject } from "../data/subject";

/**
 * The single point of contact between `@pithy-sh/payments` and `@pithy-sh/ledger`.
 *
 * The ledger is an **optional peer**: most catalogs sell features, not currency, and a project that never
 * declares a `grants` clause must neither install the package nor pay for it in its Worker bundle. So the
 * import is dynamic and it lives in exactly one file — grep `@pithy-sh/ledger` in this package and you find
 * this line and nothing else. Everything downstream depends on {@link PaymentsLedger}, a structural
 * two-method view, which is also what keeps the grant modules testable without resolving an optional package.
 *
 * **An absent ledger is an error, never a skip.** A catalog with a `grants` clause has told us a purchase
 * credits a balance; quietly not crediting it is a support ticket that arrives weeks later as "I paid and got
 * no coins". The normal place this is caught is far earlier — `payments()`'s `compose` hook refuses at
 * assembly when a `grants` product is composed without the ledger, so a deploy fails rather than a purchase.
 * This throw is the backstop for a caller that reached fulfillment some other way, and it names the fix.
 */

/**
 * The ledger operations payments performs: one to fulfill a purchase, one to reverse it.
 *
 * A structural subset rather than `@pithy-sh/ledger`'s own `Ledger`, because a type imported from an optional
 * package would put that package on the typecheck path of every module that touches fulfillment. Holds,
 * captures, and transfers are absent because a purchase is not a wager — money arrives from a store and, on a
 * refund, leaves again.
 *
 * The leading parameter is `@pithy-sh/ledger`'s own `userId`, named `accountId` here because payments never
 * hands it one — see {@link ledgerAccountId}.
 */
export interface PaymentsLedger {
  /** Add funds. Idempotent on `ref`, which is `UNIQUE` across the whole ledger. */
  credit(
    accountId: string,
    currency: string,
    amount: number,
    ref: string,
    options?: { memo?: string },
  ): Promise<unknown>;
  /** Remove funds. Refuses with `ledger/insufficient_funds` rather than letting a balance go negative. */
  debit(
    accountId: string,
    currency: string,
    amount: number,
    ref: string,
    options?: { memo?: string },
  ): Promise<unknown>;
}

/**
 * The ledger account a subject's balance lives in — **the pair, encoded, and the only derivation of it**.
 *
 * `@pithy-sh/ledger` keys an account on `(userId, currency)`: one flat id namespace, with no column saying
 * what kind of thing the id names. Nothing in the kit keeps a user id and an organization id disjoint — they
 * are minted by different systems, and under `billingSubject: "organization"` the id belongs to a membership
 * model this package knows nothing about. So handing the ledger a bare `subjectId` would let an organization
 * called `acme` and a user called `acme` share one balance: coins the company bought spendable by the person,
 * and a refund of either debiting whatever the other had left.
 *
 * **`@pithy-sh/ledger` is a per-user model, deliberately**, and this function's whole job is to respect that.
 * It keys an account `(userId, currency)`, and every route it serves addresses a user: the authenticated
 * balance read, the `:userId` segment on its management routes, its own seeds. So a user's ledger account id
 * **is** their user id — the identity on `subjectId`, nothing composed.
 *
 * It briefly encoded both halves, and that was a bug rather than a stylistic choice: a grant credited to
 * `user:ada` landed in an account nothing reads. The player's balance stayed empty, the grant was invisible
 * from both sides, and no test in either package could see it, because each package was internally
 * consistent while the two disagreed.
 *
 * **An organization never reaches here.** `checkLedgerGrants` in `capability.ts` refuses a catalog carrying a
 * `grants.ledger` clause under `billingSubject: "organization"`, at assembly — there is no account in a
 * per-user ledger for a company's credit to land in, and inventing one would write a non-user into a column
 * that means user. The throw below is the backstop for a path that composition already closed.
 *
 * **One derivation, called by `apply.ts` and `clawback.ts` alike.** A credit and its clawback must address the
 * identical account or the reversal misses, silently, leaving a refunded buyer holding the currency. Keeping
 * that in one function makes it a property of the code rather than of two edits staying in step.
 */
export function ledgerAccountId(subject: PaymentsSubject): string {
  if (subject.subjectType !== "user") {
    // Unreachable through composition: `checkLedgerGrants` refuses a catalog with a `grants.ledger` clause
    // under organization billing, at assembly. Thrown rather than encoded anyway, because the alternative is
    // a row in `pithy_ledger_accounts` whose `userId` is not a user — invisible to every route the ledger
    // serves, and impossible to tell from a balance nobody funded.
    throw new InternalError({
      message: "A balance cannot be credited to an organization.",
      action: 'Set `billingSubject: "user"`, or drop the `grants` clause from the products that credit one.',
      detail: `@pithy-sh/ledger keys every account on a user id. Refused an account for ${encodeSubjectReference(subject)}.`,
    });
  }
  return subject.subjectId;
}

/** How the ledger module is reached. Injectable so the absent-package path is a test rather than a hope. */
export type PaymentsLedgerLoader = () => Promise<{
  openLedger: (d1: D1Database, now?: () => number) => PaymentsLedger;
}>;

/** The real loader — the only `@pithy-sh/ledger` import in the package. */
const loadLedgerModule: PaymentsLedgerLoader = () => import("@pithy-sh/ledger/src/ledger");

/** What {@link openPaymentsLedger} accepts beyond the binding. */
export interface OpenPaymentsLedgerOptions {
  /** Override the module loader. Tests only; production always resolves the real package. */
  load?: PaymentsLedgerLoader;
  /** The clock the ledger stamps its rows with. Injected so a fulfillment is deterministic under test. */
  now?: () => number;
}

/**
 * Open the ledger against the app database, or explain what is missing.
 *
 * The ledger's tables live in the same D1 as payments' own — both capabilities bind `DB` — so there is no
 * second database to reach and no configuration to resolve. That is also why the two write independently and
 * a credit is idempotent on its `ref` rather than on being in the purchase's transaction: D1 has no
 * cross-statement transaction a caller can hold open across two packages.
 */
export async function openPaymentsLedger(
  d1: D1Database,
  options: OpenPaymentsLedgerOptions = {},
): Promise<PaymentsLedger> {
  const load = options.load ?? loadLedgerModule;
  let module: { openLedger: (d1: D1Database, now?: () => number) => PaymentsLedger };
  try {
    module = await load();
  } catch (cause) {
    throw new InternalError(
      {
        message: "This purchase credits a balance, and the ledger is not installed.",
        action: "Install @pithy-sh/ledger and compose ledger(...), or drop the `grants` clause from the product.",
        detail: `Loading @pithy-sh/ledger failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
      { cause },
    );
  }
  return module.openLedger(d1, options.now);
}
