// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import type { AuthDatabase } from "../data/tables";
import { accountStanding, LifecycleColumns, lifecycleRefusal } from "./state";

/**
 * The reads enforcement needs, and the one place a refusal is remembered for the rest of a request.
 *
 * ## Where an account is refused
 *
 * - **Every request** — the session middleware reads the state off the user Better Auth resolved for the
 *   session, which carries the columns, so the check costs no query. A refused account gets no
 *   `AuthContext`, so every `requireAuth()` in the kit refuses it whoever wrote the guard; this capability's
 *   own `requireAuth()` raises the refusal itself, with its code, rather than a 401.
 * - **Every sign-in and every token refresh** — `session.create.before` in `../instance/auth.ts`. Every way
 *   a session comes into being goes through `createSession`, so one hook covers magic link, OTP, every
 *   social callback and `/token/rotate` alike.
 * - **Better Auth's own endpoints that act as the session's holder** — `/token`, `/get-session`,
 *   `/update-user` and the rest — refused in `handleBetterAuth` from the middleware's verdict, because
 *   Better Auth resolves its own session there and never asks this capability.
 *
 * The reason for a suspension is the one read only a refused request pays for: it lives in
 * `pithy_auth_user_lifecycle`, not on the user row, so an account in good standing never costs a lookup.
 */

/** The reason given for the suspension in force — the newest `suspended` row — or null when none was written. */
export async function suspensionReason(db: AuthDatabase, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom("pithyAuthUserLifecycle")
    .select("reason")
    .where("userId", "=", userId)
    .where("action", "=", "suspended")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  const reason = row?.reason?.trim();
  return reason ? reason : null;
}

/** An account's lifecycle columns, read from its row, or `null` when there is no such account. */
export async function readLifecycleColumns(db: AuthDatabase, userId: string): Promise<LifecycleColumns | null> {
  const row = await db
    .selectFrom("pithyAuthUsers")
    .select(["suspendedAt", "suspendedUntil", "deletedAt", "purgeAfter"])
    .where("id", "=", userId)
    .executeTakeFirst();
  return row ? LifecycleColumns.parse(row) : null;
}

/**
 * The refusal for this account at `now`, or `null` when it may act.
 *
 * `columns` is what the caller already holds — the session's user object, a row it read. Absent, the row is
 * read here, which is the sign-in path: a session about to be created has no user object yet.
 */
export async function lifecycleRefusalFor(
  db: AuthDatabase,
  userId: string,
  columns: Partial<LifecycleColumns> | null | undefined,
  now: Date,
): Promise<PithyError | null> {
  const held = columns ?? (await readLifecycleColumns(db, userId)) ?? {};
  const standing = accountStanding(held, now);
  if (standing.state === "active") return null;
  const reason = standing.state === "suspended" ? await suspensionReason(db, userId) : null;
  return lifecycleRefusal(userId, standing, reason);
}

/** The holder of a refused credential: whose session it is. Known because the credential itself is genuine. */
export interface RefusedHolder {
  /** The account the session belongs to. */
  readonly userId: string;
  /** The session the request presented. */
  readonly sessionId: string;
}

/**
 * The refusal the session middleware reached for this request, keyed by the request's context.
 *
 * A WeakMap rather than a request variable because `PithyVars` is core's, and this is a fact only this
 * capability's own guards read — a refused account already has no `AuthContext`, which is the part every
 * other capability's guard needs. Keyed by the context the way `../http/resolve.ts` caches the instance, so
 * it dies with the request.
 *
 * **The holder rides with it (#622).** A suspended account may still delete itself — the app stores require
 * that a person can always leave — and that one route has to know whose account the refused credential
 * opens. Nothing else reads it: the holder is reachable only through `accountHolder`, and only that route uses it.
 */
const refusals = new WeakMap<object, { refusal: PithyError; holder: RefusedHolder | undefined }>();

/** Remember that this request's credential belongs to an account that may not act, and whose it is. */
export function noteRefusal(context: object, refusal: PithyError, holder?: RefusedHolder): void {
  refusals.set(context, { refusal, holder });
}

/** The refusal the session middleware reached for this request, if it reached one. */
export function noticedRefusal(context: object): PithyError | undefined {
  return refusals.get(context)?.refusal;
}

/**
 * The holder of a **suspended** account's credential on this request, or `undefined` (#622).
 *
 * Only a suspension: a deleted account has nothing left to delete, and a check that could not be made has
 * established nobody. The one reader is the self-service deletion, through `../http/middleware.ts`.
 */
export function suspendedHolder(context: object): RefusedHolder | undefined {
  const noted = refusals.get(context);
  return noted?.refusal.payload.code === "auth/account_suspended" ? noted.holder : undefined;
}

/**
 * The header a sign-in carries to ask for a session that can do nothing but delete its account, and the one
 * value it takes (#622).
 *
 * A suspension revokes every session the account holds and refuses every new one, so without this a suspended
 * person would hold no credential and could get none — and the one route a suspension leaves open, deleting the
 * account, would be one nobody could reach. With it, the sign-in completes: the person still proves who they are,
 * by the code, the link or the provider, exactly as for any sign-in. **The session that results is still a
 * suspended account's**, so the session middleware refuses it everywhere, Better Auth's own endpoints included,
 * and only `DELETE /auth/account` admits it. Nothing about the header is trusted beyond that: it asks for a
 * session no more capable than none, save for leaving.
 */
export const ACCOUNT_DELETION_INTENT_HEADER = "x-pithy-intent";
/** The value of `ACCOUNT_DELETION_INTENT_HEADER` that asks for a deletion-only session. */
export const ACCOUNT_DELETION_INTENT = "delete-account";

/**
 * Whether a sign-in refused with `refusal` may still create its session: only a **suspended** account's, and only
 * when the request asks for nothing but deleting it. A deleted account has nothing left to delete, and a check
 * that could not be made has established nobody, so neither is admitted.
 */
export function admitsDeletionSignIn(refusal: PithyError, headers: Headers | null | undefined): boolean {
  if (refusal.payload.code !== "auth/account_suspended") return false;
  const asked = headers?.get(ACCOUNT_DELETION_INTENT_HEADER)?.trim().toLowerCase();
  return asked === ACCOUNT_DELETION_INTENT;
}
