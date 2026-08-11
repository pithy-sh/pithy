// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { parseAddress } from "@pithy-sh/core/src/address/address";
import type { Entitlement } from "@pithy-sh/core/src/entitlement/entitlement";

/**
 * The link from an address in a `From` header to the customer the app already knows about.
 *
 * This is the feature the whole capability exists for. A support thread that arrives already knowing
 * who the sender is, what they bought, on which rail, and whether their last renewal failed is a
 * different object from a message in a mailbox — and every one of those facts is already in the
 * adopter's own D1, one table over, unused.
 *
 * ## Guarded dynamic imports, not dependencies
 *
 * `@pithy-sh/auth` and `@pithy-sh/payments` are **optional** here (principle 4: depend on core seams,
 * never on a sibling's internals), so both are reached the way `@pithy-sh/matchmaking` already
 * reaches auth — a dynamic import inside a `try`, degrading to "no link" when the package is not
 * installed. A support inbox in a project with no accounts and no payments is a perfectly reasonable
 * thing to run, and it must not fail to start, or to store mail, because of what it cannot see.
 *
 * Every function here is **best-effort by contract**: it returns nothing rather than throwing, and
 * the caller stores the message either way. Linkage is context, and context is never worth losing a
 * customer's support request over.
 */

/** The account a sender resolves to, and what the app knows about them. */
export interface SenderContext {
  /**
   * Whether the `From:` header was proved to belong to the sender. **Everything below is empty when
   * this is false**, and a dashboard must render the sender as an unverified claim rather than as a
   * customer — the whole value of this panel is that an operator trusts it, so it must not be
   * populated from an address anybody could have written.
   */
  authenticated: boolean;
  /** The linked `pithy_auth_users.id`, or null when this address belongs to nobody with an account. */
  userId: string | null;
  /** The account's display name, when auth is composed and the sender is known. */
  name?: string;
  /** Whether the account has verified this address. A useful signal beside an unverified claim in a header. */
  emailVerified?: boolean;
  /** Their purchase history, newest first. Empty when payments is absent or they have bought nothing. */
  purchases: readonly SenderPurchase[];
  /** Their entitlements, lapsed ones included and marked inactive — a paywall wants to say when Pro ended. */
  entitlements: readonly Entitlement[];
}

/** One purchase, flattened to what a support console renders. */
export interface SenderPurchase {
  /** The purchase row id. */
  id: string;
  /** Which rail it went through — `apple`, `google`, or `stripe`. */
  rail: string;
  /** The Pithy product key. */
  productId: string;
  /** Its lifecycle state — `active`, `refunded`, `expired`, and so on. */
  status: string;
  /** Whether the purchase happened in the store's sandbox rather than production. */
  environment: string;
  /** When it was bought. */
  purchasedAt: Date;
  /** When it runs out; null for something owned forever. */
  expiresAt: Date | null;
  /** When it was refunded or revoked; null while it stands. */
  revokedAt: Date | null;
}

/** How many purchases a thread view carries. Enough to see the pattern, bounded so a whale is not a slow page. */
export const MAX_LINKED_PURCHASES = 25;

/**
 * Resolve a sender address to a user id.
 *
 * **Exact match on the normalized address, and deliberately no case-insensitive fallback.** The
 * `email` column is indexed and unique, so this is one index seek; a `lower(email) = ?` fallback
 * would be a full table scan, and it would run for *every unknown sender* — which on a public
 * address means every piece of spam scanning the entire user table. Better Auth normalizes on its
 * own signup path, so the exact match is the case that actually occurs; an address stored with
 * capitals by some other route simply does not link, which costs a line of context rather than a
 * customer's request.
 */
export async function resolveSenderUserId(d1: D1Database, address: string): Promise<string | null> {
  const normalized = parseAddress(address);
  if (!normalized) return null;

  try {
    const { authDatabase } = await import("@pithy-sh/auth/src/data/tables");
    const row = await authDatabase(d1)
      .selectFrom("pithyAuthUsers")
      .select(["id"])
      .where("email", "=", normalized)
      .executeTakeFirst();
    return row?.id ?? null;
  } catch {
    // `@pithy-sh/auth` is not installed, or the table does not exist yet. Both mean the same thing
    // here: nobody to link to.
    return null;
  }
}

/**
 * The address an operator's reply to an app thread will be sent to, or null when the account carries
 * nothing deliverable.
 *
 * Extracted rather than inlined because it is the one decision in {@link resolveSubmitterAccount} with
 * a wrong answer available, and inlining it puts that decision behind a guarded dynamic import where
 * no test can reach it.
 *
 * **`parseAddress` only, with no `normalizeAddress` fallback.** The fallback merely trims and
 * lowercases, so it would hand back an address this capability's own parser had just refused — and
 * this value becomes the thread's `fromAddress`, which `sendReply` enqueues an answer to. Returning
 * null makes an unparseable account the same hard fault as a missing one, which is what the caller
 * already does with it: refusing the submission beats accepting a report whose only reply address
 * cannot be delivered to.
 */
export function submitterAddress(email: string | null | undefined): string | null {
  return (email && parseAddress(email)) || null;
}

/**
 * The account behind an authenticated submitter — resolved by id, never by an address.
 *
 * The inverse of {@link resolveSenderUserId}, and it exists because the in-app channel starts from the
 * opposite end: a session names a user id, and what the thread needs is the address a reply will go
 * back to. Deriving that from anything the client sent would hand a signed-in caller the ability to
 * point a support conversation — and every operator reply on it — at somebody else's mailbox.
 *
 * Returns null when `@pithy-sh/auth` is absent or the account is gone. A submission whose account
 * cannot be read is refused by the caller rather than stored with a guessed address: an app thread with
 * no working reply address is a report nobody can answer.
 */
export async function resolveSubmitterAccount(
  d1: D1Database,
  userId: string,
): Promise<{ email: string; name?: string; emailVerified?: boolean } | null> {
  try {
    const { authDatabase } = await import("@pithy-sh/auth/src/data/tables");
    const { User } = await import("@pithy-sh/auth/src/data/betterAuth");
    const row = await authDatabase(d1)
      .selectFrom("pithyAuthUsers")
      .selectAll()
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!row) return null;
    const user = User.parse(row);
    const email = submitterAddress(user.email);
    if (!email) return null;
    return { email, name: user.name, emailVerified: user.emailVerified };
  } catch {
    return null;
  }
}

/** Read the account's own fields, when auth is composed. */
async function resolveAccount(
  d1: D1Database,
  address: string,
): Promise<{ userId: string; name?: string; emailVerified?: boolean } | null> {
  try {
    const { authDatabase } = await import("@pithy-sh/auth/src/data/tables");
    const { User } = await import("@pithy-sh/auth/src/data/betterAuth");
    const row = await authDatabase(d1)
      .selectFrom("pithyAuthUsers")
      .selectAll()
      .where("email", "=", address)
      .executeTakeFirst();
    if (!row) return null;
    const user = User.parse(row);
    return { userId: user.id, name: user.name, emailVerified: user.emailVerified };
  } catch {
    return null;
  }
}

/** Read what the account bought, when payments is composed. */
async function resolvePurchases(d1: D1Database, userId: string): Promise<readonly SenderPurchase[]> {
  try {
    const { PAYMENTS_PURCHASES_TABLE, paymentsDatabase } = await import("@pithy-sh/payments/src/data/tables");
    const { PaymentsPurchase } = await import("@pithy-sh/payments/src/data/purchase");
    const rows = await paymentsDatabase(d1)
      .selectFrom(PAYMENTS_PURCHASES_TABLE)
      .selectAll()
      .where("userId", "=", userId)
      .orderBy("purchasedAt", "desc")
      .limit(MAX_LINKED_PURCHASES)
      .execute();
    return rows.map((row) => {
      const purchase = PaymentsPurchase.parse(row);
      return {
        id: purchase.id,
        rail: purchase.rail,
        productId: purchase.productId,
        status: purchase.status,
        environment: purchase.environment,
        purchasedAt: purchase.purchasedAt,
        expiresAt: purchase.expiresAt ?? null,
        revokedAt: purchase.revokedAt ?? null,
      };
    });
  } catch {
    return [];
  }
}

/** Read what the account is entitled to, when payments is composed. */
async function resolveLinkedEntitlements(d1: D1Database, userId: string, now: Date): Promise<readonly Entitlement[]> {
  try {
    const { paymentsDatabase } = await import("@pithy-sh/payments/src/data/tables");
    const { resolveEntitlements } = await import("@pithy-sh/payments/src/projection/resolve");
    return await resolveEntitlements(paymentsDatabase(d1), userId, now);
  } catch {
    return [];
  }
}

/**
 * Everything the app already knows about a sender — read at thread-read time rather than stored.
 *
 * Derived, so it is always current: a customer who buys Pro an hour after writing in shows as
 * entitled the next time the thread is opened, with nothing to backfill and nothing to invalidate.
 * That is the same rule the classification follows, applied to the half of the model that lives in
 * somebody else's tables.
 */
export async function resolveSenderContext(
  d1: D1Database,
  address: string,
  now: Date,
  options: { authenticated: boolean },
): Promise<SenderContext> {
  const empty: SenderContext = { authenticated: options.authenticated, userId: null, purchases: [], entitlements: [] };

  const normalized = parseAddress(address);
  if (!normalized) return empty;

  const account = await resolveAccount(d1, normalized);
  if (!account) return empty;

  // **An unverified match is reported; its billing history is not.**
  //
  // The two halves carry very different risk. A name beside an address is a labelled guess an
  // operator can sanity-check, and withholding it would make the panel useless for the majority of
  // real senders, since most domains publish no verdict this Worker can trust. An itemised purchase
  // history is what somebody decides to issue a refund or reset an account on — presenting a real
  // customer's on a thread that merely *claims* to be them is the whole account-takeover path.
  //
  // `emailVerified` is withheld too: it describes the *account*, but next to an unverified sender it
  // reads as "this sender is verified", which is exactly the confusion this seam exists to remove.
  if (!options.authenticated) {
    return { authenticated: false, userId: account.userId, name: account.name, purchases: [], entitlements: [] };
  }

  return provenContext(d1, account, now);
}

/**
 * The customer context behind a **session-proven** link, resolved from the user id itself.
 *
 * An app thread already holds the id its session proved, so re-deriving it from the thread's address
 * would be both a step backwards and a correctness bug: `resolveSenderUserId` matches the `email`
 * column exactly, and an account stored with capitals by some other route would silently resolve to
 * nobody — turning the one link that *is* certain into the one the console shows as unknown.
 *
 * Everything below the link degrades exactly as it does on the mail path: purchases and entitlements
 * are guarded dynamic imports and come back empty when `@pithy-sh/payments` is absent.
 */
export async function resolveSubmitterContext(d1: D1Database, userId: string, now: Date): Promise<SenderContext> {
  const account = await resolveSubmitterAccount(d1, userId);
  if (!account) return { authenticated: true, userId, purchases: [], entitlements: [] };
  return provenContext(d1, { userId, name: account.name, emailVerified: account.emailVerified }, now);
}

/** The proven half, shared by both entry points: the account, plus what it bought and what it holds. */
async function provenContext(
  d1: D1Database,
  account: { userId: string; name?: string; emailVerified?: boolean },
  now: Date,
): Promise<SenderContext> {
  const [purchases, entitlements] = await Promise.all([
    resolvePurchases(d1, account.userId),
    resolveLinkedEntitlements(d1, account.userId, now),
  ]);

  return {
    authenticated: true,
    userId: account.userId,
    name: account.name,
    emailVerified: account.emailVerified,
    purchases,
    entitlements,
  };
}
