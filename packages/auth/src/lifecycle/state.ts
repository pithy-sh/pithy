// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { z } from "zod";
import { User } from "../data/betterAuth";

/**
 * What an account's four lifecycle columns mean, decided once.
 *
 * Every enforcement point — the session middleware, sign-in, token refresh — reads the state through
 * {@link accountStanding} and refuses through {@link lifecycleRefusal}. Enforcement written twice is
 * enforcement that disagrees, and the first disagreement would be a suspension one door honors and another
 * does not.
 */

/**
 * The four columns, decoded off whatever carries them: a `pithy_auth_users` row, or the user object Better
 * Auth resolved for a session, which carries them because `../data/kitFields.ts` declares them. Unknown keys
 * are dropped, and a key that is absent — a row read before `0004_user_lifecycle` — reads as null.
 */
export const LifecycleColumns = User.pick({
  suspendedAt: true,
  suspendedUntil: true,
  deletedAt: true,
  purgeAfter: true,
}).describe("An account's lifecycle columns, as `pithy_auth_users` stores them.");
export type LifecycleColumns = z.output<typeof LifecycleColumns>;

/** Where an account stands, at one instant. */
export type AccountStanding =
  | { readonly state: "active" }
  | { readonly state: "suspended"; readonly until: Date | null }
  | { readonly state: "deleted"; readonly purgeAfter: Date | null };

/**
 * Where an account stands at `now`.
 *
 * **Deleted outranks suspended.** An account deleted while it was suspended is deleted: the suspension's end
 * passing must not reopen it.
 *
 * **A suspension past its `suspendedUntil` is not a suspension**, and no write expires it. The end is
 * exclusive — at the instant it names, the account is active again. A column nobody has cleared is a
 * fact about the past, not about now, and reading it that way is what lets a timed suspension end on time
 * with nothing scheduled to end it.
 *
 * **A deletion past its `purgeAfter` is still a deletion.** Only the purge ends that state, by erasing the
 * account, and until it has run the account must stay shut.
 */
export function accountStanding(columns: Partial<LifecycleColumns>, now: Date): AccountStanding {
  if (columns.deletedAt) return { state: "deleted", purgeAfter: columns.purgeAfter ?? null };
  if (columns.suspendedAt) {
    const until = columns.suspendedUntil ?? null;
    if (until === null || until.getTime() > now.getTime()) return { state: "suspended", until };
  }
  return { state: "active" };
}

/** What a suspended account is told when nobody wrote a reason. */
const UNEXPLAINED_SUSPENSION = "This account is suspended.";

/**
 * The refusal for an account that may not act, or `null` for one that may.
 *
 * **The reason an operator gave is the public `message`**, because it is written for the person who is locked
 * out and it is the one thing their screen cannot invent. `params` carries the end of a suspension, or the
 * last day a deletion can be undone, as ISO-8601, for a client that renders the date in its reader's own
 * words. Neither the account id nor who acted crosses: `detail` holds the id for the log, and `clientError`
 * strips it with `action`.
 *
 * 403 for both, never 401: the credential is genuine, and signing in again cannot help.
 */
export function lifecycleRefusal(userId: string, standing: AccountStanding, reason: string | null): PithyError | null {
  if (standing.state === "active") return null;
  if (standing.state === "suspended") {
    return new PithyError({
      code: "auth/account_suspended",
      status: 403,
      message: reason ?? UNEXPLAINED_SUSPENSION,
      ...(standing.until ? { params: { suspendedUntil: standing.until.toISOString() } } : {}),
      action: "An operator suspended this account. Reinstate it from the management surface, or let it run out.",
      detail: `user ${userId} is suspended${standing.until ? ` until ${standing.until.toISOString()}` : ""}`,
    });
  }
  return new PithyError({
    code: "auth/account_deleted",
    status: 403,
    message: "This account is deleted.",
    ...(standing.purgeAfter ? { params: { purgeAfter: standing.purgeAfter.toISOString() } } : {}),
    action: "The account is inside its purge window. Restore it from the management surface before the purge runs.",
    detail: `user ${userId} is deleted${standing.purgeAfter ? `, purge after ${standing.purgeAfter.toISOString()}` : ""}`,
  });
}

/** Whether a caught error is one of the two lifecycle refusals. */
export function isLifecycleRefusal(error: unknown): error is PithyError {
  return (
    error instanceof PithyError &&
    (error.payload.code === "auth/account_suspended" || error.payload.code === "auth/account_deleted")
  );
}
