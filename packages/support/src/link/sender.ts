// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { Entitlement } from "@pithy-sh/core/src/entitlement/entitlement";
import { normalizeAddress } from "../mime/address";

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
  const normalized = normalizeAddress(address);
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

  const normalized = normalizeAddress(address);
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
