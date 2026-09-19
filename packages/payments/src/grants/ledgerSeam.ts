// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { encodeSubjectReference, type PaymentsSubject } from "../data/subject";

/**
 * The single point of contact between `@pithy-sh/payments` and `@pithy-sh/ledger` — and it imports nothing
 * from it.
 *
 * The ledger is an **optional peer**: most catalogs sell features, not currency, and a project that never
 * declares a `grants` clause must neither install the package nor carry it in a Worker bundle. This file used
 * to reach it with `import("@pithy-sh/ledger/src/ledger")` behind a `try`, which is optional at runtime and
 * required at bundle time — wrangler's esbuild resolves a literal specifier whether or not the branch holding
 * it ever runs, so every project composing payments without the ledger could not deploy its payments host at
 * all (#645). The unit test here injected a loader, so it proved the runtime half and never met the bundler.
 *
 * **So the ledger is handed to payments, never fetched by it.** `ledger()` carries its peer surface as
 * `ledgerPeer`; `payments()`'s `compose` hook finds it among the composed capabilities and keeps it for the
 * routes, and the reconcile host — which composes nothing — is handed it by the entry `pithy` generates when
 * the catalog credits a balance. Everything downstream depends on {@link PaymentsLedgerPeer} and
 * {@link PaymentsLedger}, structural views, so no module in this package names `@pithy-sh/ledger` at all —
 * not even for a type, which would put an optional package on the typecheck path of every module that touches
 * fulfillment. `optionalPeerImports.test.ts` holds the whole kit to that.
 *
 * **An absent ledger is an error, never a skip.** A catalog with a `grants` clause has told us a purchase
 * credits a balance; quietly not crediting it is a support ticket that arrives weeks later as "I paid and got
 * no coins". The normal place this is caught is far earlier — `payments()`'s `compose` hook refuses at
 * assembly when a `grants` product is composed without the ledger, so a deploy fails rather than a purchase.
 * The throw in {@link openPaymentsLedger} is the backstop for a caller that reached fulfillment some other way,
 * and it names the fix.
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

/** How a ledger is opened over a D1: `@pithy-sh/ledger`'s own `openLedger`, as payments sees it. */
export type PaymentsLedgerOpener = (d1: D1Database, now?: () => number) => PaymentsLedger;

/**
 * The slice of `@pithy-sh/ledger`'s peer surface payments calls — its `ledgerPeer`, structurally.
 *
 * Structural for {@link PaymentsLedger}'s reason: a type imported from the optional package would put it on
 * the typecheck path of every module that touches fulfillment. The ledger's own `ledgerPeer` satisfies it, and
 * `capability.test.ts` composes the real one to prove that stays true.
 */
export interface PaymentsLedgerPeer {
  /** Open the ledger against a D1 binding, stamping rows with `now`. */
  openLedger: PaymentsLedgerOpener;
}

/** What {@link openPaymentsLedger} accepts beyond the binding. */
export interface OpenPaymentsLedgerOptions {
  /** The ledger the composition handed over, or undefined when none is composed. */
  peer?: PaymentsLedgerPeer;
  /** The clock the ledger stamps its rows with. Injected so a fulfillment is deterministic under test. */
  now?: () => number;
}

/**
 * Open the ledger the composition handed over against the app database, or explain what is missing.
 *
 * The ledger's tables live in the same D1 as payments' own — both capabilities bind `DB` — so there is no
 * second database to reach and no configuration to resolve. That is also why the two write independently and
 * a credit is idempotent on its `ref` rather than on being in the purchase's transaction: D1 has no
 * cross-statement transaction a caller can hold open across two packages.
 */
export function openPaymentsLedger(d1: D1Database, options: OpenPaymentsLedgerOptions = {}): PaymentsLedger {
  if (options.peer === undefined) {
    throw new InternalError({
      message: "This purchase credits a balance, and no ledger is composed.",
      action:
        "Add `ledger(...)` to this Worker's capabilities in pithy.config.ts, or drop the `grants` clause from the product.",
      detail:
        "fulfillPurchase reached a product with a grants.ledger clause and was handed no ledger peer. payments() refuses that composition at assembly, so this caller reached fulfillment some other way, or a host was deployed without the entry that hands it the ledger.",
    });
  }
  return options.peer.openLedger(d1, options.now);
}
