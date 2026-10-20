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

/**
 * The refusal the session middleware reached for this request, keyed by the request's context.
 *
 * A WeakMap rather than a request variable because `PithyVars` is core's, and this is a fact only this
 * capability's own guards read — a refused account already has no `AuthContext`, which is the part every
 * other capability's guard needs. Keyed by the context the way `../http/resolve.ts` caches the instance, so
 * it dies with the request.
 */
const refusals = new WeakMap<object, PithyError>();

/** Remember that this request's credential belongs to an account that may not act. */
export function noteRefusal(context: object, refusal: PithyError): void {
  refusals.set(context, refusal);
}

/** The refusal the session middleware reached for this request, if it reached one. */
export function noticedRefusal(context: object): PithyError | undefined {
  return refusals.get(context);
}
