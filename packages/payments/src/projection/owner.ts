// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { PaymentsProviderAccount } from "../data/providerAccount";
import type { PaymentsRail } from "../data/rail";
import {
  PAYMENTS_PROVIDER_ACCOUNTS_TABLE,
  PAYMENTS_PURCHASES_TABLE,
  type PaymentsDatabase,
  paymentsDatabase,
} from "../data/tables";

/**
 * Who a purchase belongs to — the question a webhook cannot answer for itself.
 *
 * A notification arrives carrying the store's own identifiers and no Pithy user id. The projection writer
 * takes an owner as an input and refuses to infer one, deliberately: a writer that could derive a user from a
 * payload could be talked into deriving the wrong one. So resolution happens here, once, against rows the
 * server itself wrote.
 *
 * **Three sources, in decreasing order of how directly they were stated.**
 *
 * 1. **The account link** — `pithy_payments_provider_accounts`, written when the buying user submitted the
 *    purchase. This is the app's own declaration, through the hook every store provides: Apple's
 *    `appAccountToken`, Google's `obfuscatedAccountId`, Stripe's `client_reference_id`.
 * 2. **The same transaction, already projected.** A redelivery of a notification we handled is never
 *    orphaned, whatever the app set.
 * 3. **The transaction that started the subscription.** This is what makes renewals work for an app that set
 *    no account token at all: the first purchase was submitted by its owner, and every renewal chains back to
 *    it through `originalTransactionId`.
 *
 * The order is which to believe when more than one answers. A disagreement between the link and an old row
 * means the app moved the subscription, and the app's statement is the later, more direct fact.
 *
 * When nothing answers, the answer is undefined — an orphan. The notification is still recorded, so it is
 * visible and replayable once a link arrives. Guessing would be the alternative, and a guess here grants
 * somebody else's subscription.
 */

/** What a notification offers as identification. Every field is optional; a rail supplies what it carries. */
export interface OwnerHints {
  /** The store's account identifier, if the purchase carried one. */
  providerAccountId?: string | null;
  /** This transaction's own id. Matches a purchase already projected. */
  providerTransactionId?: string | null;
  /** The transaction that started the subscription. Matches the purchase a renewal descends from. */
  originalTransactionId?: string | null;
}

/** Options for the account link. The clock is injected so a link's `createdAt` is deterministic in tests. */
export interface LinkProviderAccountOptions {
  /** The clock. */
  now?: Date;
  /** The id minter. */
  newId?: () => string;
}

/**
 * Bind a store account identifier to a Pithy user, and return the user it is bound to.
 *
 * Idempotent, and **never rebinding**: `UNIQUE (rail, providerAccountId)` plus `ON CONFLICT DO NOTHING`
 * means the first binding wins and a later one is a no-op. That matters because a client re-submits its
 * receipt on every launch, and because rebinding would let a second Pithy account capture the first one's
 * renewal notifications simply by submitting a receipt from the same store account.
 *
 * The returned user is the one actually bound, which is not always the one passed in. A caller that cares
 * about the difference compares them; the purchase-level owner check in the writer is what refuses a
 * transaction outright.
 */
export async function linkProviderAccount(
  d1: D1Database,
  rail: PaymentsRail,
  providerAccountId: string,
  userId: string,
  options: LinkProviderAccountOptions = {},
): Promise<string> {
  const db = paymentsDatabase(d1);
  const row = PaymentsProviderAccount.encode({
    id: options.newId?.() ?? crypto.randomUUID(),
    rail,
    providerAccountId,
    userId,
    createdAt: options.now ?? new Date(),
  });

  await withD1Retry(() =>
    db
      .insertInto(PAYMENTS_PROVIDER_ACCOUNTS_TABLE)
      // biome-ignore lint/suspicious/noExplicitAny: an encoded row; Kysely's insert type derives from z.input.
      .values(row as any)
      .onConflict((oc) => oc.columns(["rail", "providerAccountId"]).doNothing())
      .execute(),
  );

  const bound = await db
    .selectFrom(PAYMENTS_PROVIDER_ACCOUNTS_TABLE)
    .select("userId")
    .where("rail", "=", rail)
    .where("providerAccountId", "=", providerAccountId)
    .executeTakeFirst();
  // Absent only if the row vanished between the insert and this read, which nothing in this package does.
  return bound?.userId ?? userId;
}

/**
 * The store account this user already has on this rail, or undefined.
 *
 * The reverse of {@link resolveNotificationOwner}, and it exists for the two hosted Stripe flows. `/checkout`
 * passes it so a returning buyer keeps one Stripe customer instead of minting a new one per purchase — without
 * that, the billing portal their first purchase created would not show their second. `/portal` needs it because
 * a portal session is *about* a customer, and taking that from a request would let any caller open somebody
 * else's billing.
 *
 * The oldest link wins. A user with two accounts on one rail is already an anomaly — the link is never rebound,
 * so it takes two purchases made under two store accounts — and the first is the one every earlier purchase is
 * filed under.
 */
export async function providerAccountForUser(
  db: PaymentsDatabase,
  rail: PaymentsRail,
  userId: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom(PAYMENTS_PROVIDER_ACCOUNTS_TABLE)
    .select("providerAccountId")
    .where("rail", "=", rail)
    .where("userId", "=", userId)
    .orderBy("createdAt")
    .executeTakeFirst();
  return row?.providerAccountId;
}

/**
 * The user a notification belongs to, or undefined when nothing identifies one.
 *
 * **The order is a trust order, not a convenience order.** The two transaction lookups ask a question this
 * server already answered: who owned the purchase we projected for an authenticated caller. The account link
 * asks a question the *app* answered, because on Apple and Google `providerAccountId` is `appAccountToken` /
 * `obfuscatedAccountId` — values a client puts in a purchase and may put anything in. `contract.ts` says as
 * much about `accountReference`, and the same reasoning applies one hop further out: a value a client chose
 * must never outrank a fact this server established.
 *
 * Consulting the link first is a cross-user entitlement hijack. An attacker who can guess a victim's token
 * value makes one purchase carrying it, submits it as themselves, and owns the link; the victim's own
 * notifications then resolve to the attacker, and because a renewal carries a fresh transaction id the
 * writer's owner check never fires. Last is where a client's claim belongs.
 *
 * It still belongs *somewhere*: on Stripe the link is written from `client_reference_id`, which `/checkout`
 * set from the authenticated buyer, so it is server-established and it is the only thing that can attribute
 * a first invoice. Hence last rather than gone.
 */
export async function resolveNotificationOwner(
  db: PaymentsDatabase,
  rail: PaymentsRail,
  hints: OwnerHints,
): Promise<string | undefined> {
  // A falsy hint is skipped rather than passed to the query: `where(column, "=", undefined)` in Kysely
  // compares against null, which on a nullable column matches every unrelated one-off purchase.
  if (hints.providerTransactionId) {
    const owner = await db
      .selectFrom(PAYMENTS_PURCHASES_TABLE)
      .select("userId")
      .where("rail", "=", rail)
      .where("providerTransactionId", "=", hints.providerTransactionId)
      .executeTakeFirst();
    if (owner) return owner.userId;
  }

  if (hints.originalTransactionId) {
    // The whole subscription family, matched on either column. A renewal's `originalTransactionId` names the
    // *first transaction's own id*, so the purchase that started the subscription is found on
    // `providerTransactionId` while its siblings are found on `originalTransactionId`. Matching only the
    // latter would miss the one row that is guaranteed to exist — the one somebody actually bought.
    const owner = await db
      .selectFrom(PAYMENTS_PURCHASES_TABLE)
      .select("userId")
      .where("rail", "=", rail)
      .where((eb) =>
        eb.or([
          eb("providerTransactionId", "=", hints.originalTransactionId as string),
          eb("originalTransactionId", "=", hints.originalTransactionId as string),
        ]),
      )
      // Oldest first: the transaction that started the subscription is the one whose owner is least disputable.
      .orderBy("purchasedAt")
      .executeTakeFirst();
    if (owner) return owner.userId;
  }

  // Last, and only when nothing this server established answers. See the trust order above.
  if (hints.providerAccountId) {
    const linked = await db
      .selectFrom(PAYMENTS_PROVIDER_ACCOUNTS_TABLE)
      .select("userId")
      .where("rail", "=", rail)
      .where("providerAccountId", "=", hints.providerAccountId)
      .executeTakeFirst();
    if (linked) return linked.userId;
  }

  return undefined;
}
