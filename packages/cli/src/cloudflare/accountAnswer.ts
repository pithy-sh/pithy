// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ConflictError } from "@pithy-sh/core/src/error/pithyError";
import {
  type CloudflareAccountConfirmation,
  describeUnconfirmedCloudflareAccount,
  UNCONFIRMED_CLOUDFLARE_ACCOUNT_ACTION,
} from "./config";

/**
 * What an account listing answered about one named resource (#378).
 *
 * **Three states, because the wire has two and one of them is two facts.** Cloudflare answers "the
 * account has no such thing" and "you asked an account that is not yours" with the same empty array, and
 * every call site that stored it in a `T | null` lost the difference at the assignment. `absent` is a
 * fact — an account this run can vouch for was asked, and it does not hold the thing. `unconfirmed` is
 * not a fact at all, and a caller that reads it as one deletes nothing while exiting 0, or creates a
 * real resource in somebody else's account.
 *
 * It is a discriminated union rather than a nullable value **and rather than a convention**, so a call
 * site that only handles two of the three does not compile. `storeId.ts` proved the shape with `null`
 * versus `[]`; this is that shape with a name, for the sites where the third state is a refusal.
 */
export type AccountAnswer<T> =
  | {
      /** The account holds it. */
      readonly state: "found";
      /** What the listing returned. */
      readonly value: T;
    }
  | {
      /** The account was confirmed, was asked, and does not hold it. Idempotent teardown may stop here. */
      readonly state: "absent";
    }
  | {
      /** Nothing vouches for the account that answered, so its answer settles nothing. */
      readonly state: "unconfirmed";
      /** The account that would have answered. Named, because the operator is about to be shown it. */
      readonly accountId: string;
    };

/**
 * An account, and what vouches for it — the pair every destructive and creative site now carries.
 *
 * **One field rather than two**, because they are one fact and a site that has the id without the
 * standing is the bug: `accountId` alone is what six deprovisioners already held while deleting nothing.
 * `cloudflareAccountConfirmation` supplies the second half from the same resolution the first came from.
 */
export interface ConfirmedAccount {
  /** The account every call is addressed to. Named in the refusal, so the operator sees which one answered. */
  readonly accountId: string;
  /** What vouches for it — `ambient` is the one value that refuses. */
  readonly confirmation: CloudflareAccountConfirmation;
}

/** One lookup against one account, with everything a refusal needs to name. */
export interface ConfirmedAccountLookup<T> extends ConfirmedAccount {
  /** What is being looked for, as a noun phrase: `the acme-prod-secrets Worker`. Named in the refusal's detail. */
  readonly what: string;
  /**
   * The listing.
   *
   * **Not called at all when the account is unconfirmed.** A round trip whose answer cannot be believed
   * either way is wasted, and — for the creative sites — it is one call closer to acting on it.
   */
  readonly find: () => Promise<T | null>;
}

/**
 * Ask an account for one named thing, and say which of the three things came back.
 *
 * For the caller that renders rather than refuses. Everything destructive or creative wants
 * {@link findOnConfirmedAccount}, which is this plus the refusal.
 */
export async function answerOnConfirmedAccount<T>(lookup: ConfirmedAccountLookup<T>): Promise<AccountAnswer<T>> {
  if (lookup.confirmation === "ambient") return { state: "unconfirmed", accountId: lookup.accountId };
  const found = await lookup.find();
  return found === null || found === undefined ? { state: "absent" } : { state: "found", value: found };
}

/**
 * The thing, or its **confirmed** absence. Refuses rather than reading a miss on an unconfirmed account
 * as an absence.
 *
 * This is the one-line form for the guards that were the whole of #378: the six deprovisioners'
 * `if (await getWorker(name))`, and the find-or-create sites that mint a resource when the answer is
 * `null`. Both read a miss as permission to proceed, and neither could tell which account had missed.
 */
export async function findOnConfirmedAccount<T>(lookup: ConfirmedAccountLookup<T>): Promise<T | null> {
  const answer = await answerOnConfirmedAccount(lookup);
  if (answer.state === "unconfirmed") throw unconfirmedAccount(answer.accountId, lookup.what);
  return answer.state === "found" ? answer.value : null;
}

/**
 * The refusal an unconfirmed account earns, in the sentence {@link describeUnconfirmedCloudflareAccount}
 * spells once.
 *
 * `ConflictError`, matching `cloudflareEnv`'s refusal for the pinned case: two accounts are in play and
 * nothing in the toolchain compares them. The thing being looked for goes in `detail` — it is throw-site
 * context, and `detail` is stripped at the display boundary, which is where it belongs.
 */
export function unconfirmedAccount(accountId: string, what: string): ConflictError {
  return new ConflictError({
    message: `${describeUnconfirmedCloudflareAccount(accountId)} Nothing was changed.`,
    action: UNCONFIRMED_CLOUDFLARE_ACCOUNT_ACTION,
    detail: `looked for ${what} on account ${accountId}; the account id came from the environment and the project claims none`,
  });
}
