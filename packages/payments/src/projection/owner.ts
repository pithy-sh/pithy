// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { withD1Retry } from "@pithy-sh/core/src/data/withD1Retry";
import { PaymentsProviderAccount } from "../data/providerAccount";
import type { PaymentsRail } from "../data/rail";
import { PaymentsSubject } from "../data/subject";
import {
  PAYMENTS_PROVIDER_ACCOUNTS_TABLE,
  PAYMENTS_PURCHASES_TABLE,
  type PaymentsDatabase,
  paymentsDatabase,
} from "../data/tables";

/**
 * Who a purchase belongs to — the question a webhook cannot answer for itself.
 *
 * A notification arrives carrying the store's own identifiers and no Pithy identity at all. The projection
 * writer takes an owner as an input and refuses to infer one, deliberately: a writer that could derive a
 * holder from a payload could be talked into deriving the wrong one. So resolution happens here, once,
 * against rows the server itself wrote.
 *
 * **The answer is a subject, not a user id** — the pair, and always both halves. Under organization billing
 * the person who clicked is not the holder, and `data/subject.ts` states why an id on its own identifies
 * nobody: nothing keeps an organization id from equalling some user's, so a resolution that returned an id
 * alone would let one collect the other's renewals. Every lookup below therefore selects both columns **from
 * the same row**, and the pair is never assembled from two places — not a kind from config beside an id from
 * a row, not a kind from one table beside an id from another.
 *
 * **Three sources, and the order they are consulted in is a trust order.**
 *
 * 1. **The same transaction, already projected.** A redelivery of a notification we handled is never
 *    orphaned, whatever the app set.
 * 2. **The transaction that started the subscription.** This is what makes renewals work for an app that set
 *    no account token at all: the first purchase was submitted by its owner, and every renewal chains back to
 *    it through `originalTransactionId`.
 * 3. **The account link** — `pithy_payments_provider_accounts`, written when the purchase was submitted,
 *    through the hook every store provides: Apple's `appAccountToken`, Google's `obfuscatedAccountId`,
 *    Stripe's `client_reference_id`.
 *
 * The first two are facts this server established; the third is a value a client chose. That is the whole
 * ordering, and {@link resolveNotificationOwner} spells out the attack it prevents.
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
 * The pair, read off the one row it was found in.
 *
 * A function rather than an object literal at each lookup, because the literal is exactly where the two
 * halves could come from two places: a `subjectType` taken from config beside a `subjectId` taken from a row
 * typechecks perfectly and names a holder nobody meant. Taking a row and reading both columns off it leaves
 * nowhere to pass a mismatched pair. The parse is the D1 boundary check every other decoded row in this
 * package gets, over a value the table's own CHECK constraint already closes.
 */
function subjectOf(row: { subjectType: string; subjectId: string }): PaymentsSubject {
  return PaymentsSubject.parse(row);
}

/**
 * Bind a store account identifier to a subject, and return the subject it is bound to.
 *
 * Idempotent, and **never rebinding**: `UNIQUE (rail, providerAccountId)` plus `ON CONFLICT DO NOTHING`
 * means the first binding wins and a later one is a no-op. That matters because a client re-submits its
 * receipt on every launch, and because rebinding would let a second holder capture the first one's renewal
 * notifications simply by submitting a receipt from the same store account.
 *
 * **The key is deliberately not widened by the subject**, and the kind is no escape from it either: an
 * organization whose id equals a user's does not get its own link, because `organization:acme` and
 * `user:acme` would still be two rows competing for one `(rail, providerAccountId)`. One provider identity
 * resolves to one holder, and which holder is decided once.
 *
 * The returned subject is the one actually bound, which is not always the one passed in. A caller that cares
 * about the difference compares them with `sameSubject`; the purchase-level owner check in the writer is
 * what refuses a transaction outright.
 *
 * **A link is also a repair signal, and this function does not act on it.** Purchases that arrived before
 * their owner was knowable are sitting in `pithy_payments_webhook_events` waiting for exactly this row —
 * see `projection/orphans.ts`, and #341 for what it cost while nothing looked. Acting on it here would mean
 * this function taking a catalog, an environment and a rail able to replay its own payloads, which is three
 * arguments a link has no business knowing about; so every call site calls `repairOrphanedEvents` beside
 * this one instead. **A fourth call site owes the same call.**
 */
export async function linkProviderAccount(
  d1: D1Database,
  rail: PaymentsRail,
  providerAccountId: string,
  subject: PaymentsSubject,
  options: LinkProviderAccountOptions = {},
): Promise<PaymentsSubject> {
  const db = paymentsDatabase(d1);
  const row = PaymentsProviderAccount.encode({
    id: options.newId?.() ?? crypto.randomUUID(),
    rail,
    providerAccountId,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
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
    .select(["subjectType", "subjectId"])
    .where("rail", "=", rail)
    .where("providerAccountId", "=", providerAccountId)
    .executeTakeFirst();
  // Absent only if the row vanished between the insert and this read, which nothing in this package does.
  return bound === undefined ? subject : subjectOf(bound);
}

/**
 * The store account this subject already has on this rail, or undefined.
 *
 * The reverse of {@link resolveNotificationOwner}, and it exists for the two hosted Stripe flows. `/checkout`
 * passes it so a returning buyer keeps one Stripe customer instead of minting a new one per purchase — without
 * that, the billing portal their first purchase created would not show their second. `/portal` needs it because
 * a portal session is *about* a customer, and taking that from a request would let any caller open somebody
 * else's billing.
 *
 * **Both halves filter, and that is what the portal rests on.** An id-only filter would hand `organization:acme`
 * the portal session belonging to `user:acme` — a live billing session over somebody else's card, invoices and
 * cancellation, reachable by anybody who can act for a subject whose id collides.
 *
 * The oldest link wins. A subject with two accounts on one rail is already an anomaly — the link is never
 * rebound, so it takes two purchases made under two store accounts — and the first is the one every earlier
 * purchase is filed under.
 */
export async function providerAccountForSubject(
  db: PaymentsDatabase,
  rail: PaymentsRail,
  subject: PaymentsSubject,
): Promise<string | undefined> {
  const row = await db
    .selectFrom(PAYMENTS_PROVIDER_ACCOUNTS_TABLE)
    .select("providerAccountId")
    .where("rail", "=", rail)
    .where("subjectType", "=", subject.subjectType)
    .where("subjectId", "=", subject.subjectId)
    .orderBy("createdAt")
    .executeTakeFirst();
  return row?.providerAccountId;
}

/**
 * The subject a notification belongs to, or undefined when nothing identifies one.
 *
 * **The order is a trust order, not a convenience order.** The two transaction lookups ask a question this
 * server already answered: who owned the purchase we projected for an authenticated caller. The account link
 * asks a question the *app* answered, because on Apple and Google `providerAccountId` is `appAccountToken` /
 * `obfuscatedAccountId` — values a client puts in a purchase and may put anything in. `contract.ts` says as
 * much about `accountReference`, and the same reasoning applies one hop further out: a value a client chose
 * must never outrank a fact this server established.
 *
 * Consulting the link first is a cross-subject entitlement hijack. An attacker who can guess a victim's token
 * value makes one purchase carrying it, submits it as themselves, and owns the link; the victim's own
 * notifications then resolve to the attacker, and because a renewal carries a fresh transaction id the
 * writer's owner check never fires. Last is where a client's claim belongs.
 *
 * It still belongs *somewhere*: on Stripe the link is written from `client_reference_id`, which `/checkout`
 * set from the authenticated buyer, so it is server-established and it is the only thing that can attribute
 * a first invoice. Hence last rather than gone.
 *
 * Each source answers with the whole pair or with nothing. A source that matched a row contributes that
 * row's `subjectType` **and** its `subjectId`, so a purchase filed against an organization can never resolve
 * to the user with the same id — see {@link subjectOf}.
 */
export async function resolveNotificationOwner(
  db: PaymentsDatabase,
  rail: PaymentsRail,
  hints: OwnerHints,
): Promise<PaymentsSubject | undefined> {
  // A falsy hint is skipped rather than passed to the query: `where(column, "=", undefined)` in Kysely
  // compares against null, which on a nullable column matches every unrelated one-off purchase.
  if (hints.providerTransactionId) {
    const owner = await db
      .selectFrom(PAYMENTS_PURCHASES_TABLE)
      .select(["subjectType", "subjectId"])
      .where("rail", "=", rail)
      .where("providerTransactionId", "=", hints.providerTransactionId)
      .executeTakeFirst();
    if (owner) return subjectOf(owner);
  }

  if (hints.originalTransactionId) {
    // The whole subscription family, matched on either column. A renewal's `originalTransactionId` names the
    // *first transaction's own id*, so the purchase that started the subscription is found on
    // `providerTransactionId` while its siblings are found on `originalTransactionId`. Matching only the
    // latter would miss the one row that is guaranteed to exist — the one somebody actually bought.
    const owner = await db
      .selectFrom(PAYMENTS_PURCHASES_TABLE)
      .select(["subjectType", "subjectId"])
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
    if (owner) return subjectOf(owner);
  }

  // Last, and only when nothing this server established answers. See the trust order above.
  if (hints.providerAccountId) {
    const linked = await db
      .selectFrom(PAYMENTS_PROVIDER_ACCOUNTS_TABLE)
      .select(["subjectType", "subjectId"])
      .where("rail", "=", rail)
      .where("providerAccountId", "=", hints.providerAccountId)
      .executeTakeFirst();
    if (linked) return subjectOf(linked);
  }

  return undefined;
}
