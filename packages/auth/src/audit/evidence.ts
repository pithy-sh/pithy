// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthDatabase } from "../data/tables";

/**
 * **Evidence that the thing an event claims actually happened, carried from the database hook that saw
 * it to the emitter that writes the row.**
 *
 * Both halves of this file exist for the same reason, which is the reason #627 exists: an audit event is
 * a claim about the world, and the place a request is answered is not always the place that knows
 * whether the claim is true. `/sign-out` answers `200 {"success":true}` having found no session to
 * delete; `deleteWithHooks` runs `delete.after` on a row it read rather than on a row it removed. In
 * both cases the endpoint is not lying — the event was.
 *
 * Neither marker is request state Better Auth offers, so both are held in a `WeakSet` keyed by an object
 * the runtime already scopes correctly: the account row instance for a removal, and the endpoint's own
 * per-dispatch context object for a session. Weakly, so nothing here outlives the request that made it.
 */

/** Whose session it was. `/sign-out` reads no session of its own, so this is the only actor available. */
export interface EndedSession {
  userId: string;
}

/** Session rows that disappeared during one request, keyed by that request's Better Auth context object. */
const endedSessions = new WeakMap<object, EndedSession>();

/**
 * Record that a session row was deleted during this request, and whose it was.
 *
 * Called from `session.delete.after`, which fires for a sign-out, a revoke, an admin ending somebody's
 * devices and the user-deletion cascade alike. Only the first of those has a path event to qualify, and
 * the rest are harmless to mark: nothing reads this except `/sign-out`.
 *
 * **The owner, because `/sign-out` cannot name one otherwise.** That endpoint declares no session
 * middleware — it reads the cookie itself — so `ctx.context.session` is null even on a sign-out that
 * worked, and the row came out `anonymous` for the one person it was certainly about. The session that
 * disappeared is the answer.
 */
export function markSessionEnded(requestContext: unknown, userId: unknown): void {
  if (typeof requestContext !== "object" || requestContext === null) return;
  if (typeof userId !== "string" || userId === "") return;
  // The first is the one the request was made with; a revoke-all's others are collateral.
  if (!endedSessions.has(requestContext)) endedSessions.set(requestContext, { userId });
}

/** Which session actually disappeared during this request, if any. `/sign-out`'s evidence. */
export function sessionEndedDuring(requestContext: unknown): EndedSession | null {
  if (typeof requestContext !== "object" || requestContext === null) return null;
  return endedSessions.get(requestContext) ?? null;
}

/**
 * **Exactly one `auth/oauth_unlinked` per removal, decided by the database rather than by a snapshot.**
 *
 * Better Auth's `deleteWithHooks` reads the row, deletes it, then runs `delete.after` — and it gates
 * that hook on *the row it read* being non-null, never on the delete having removed anything. Two
 * concurrent `/unlink-account` calls for the same account therefore both find the row, both issue a
 * delete (the second removing nothing), and both fire `delete.after`: one removal, two rows in a trail
 * somebody will one day reconcile against.
 *
 * The only single-winner fact available is the row's existence, so the claim *is* a delete. `delete.before`
 * issues it; SQLite serializes the two statements, so exactly one reports a removed row and only that
 * caller emits. Better Auth's own delete then runs and removes nothing, which it neither checks nor
 * reports — `deleteAccount` and the user-deletion cascade both discard the count — so its control flow is
 * untouched.
 *
 * **Why pre-empting the delete is safe here, stated so a later reader can re-check it rather than trust
 * it.** Plugin database hooks are registered before the instance's own (`runPluginInit` pushes
 * `plugin:<id>` entries, then `source: "user"` last), and a `delete.before` returning `false` aborts
 * immediately — so any veto has already fired and returned before this runs. The one case it would not
 * cover is `deleteManyWithHooks`, which walks entity-major: a veto on the *third* account of a cascade
 * would leave the first two already removed. Better Auth registers no `account.delete.before`, and the
 * kit composes no plugin that does; an adopter's plugin that vetoes an account delete is the case to
 * revisit this for.
 *
 * The claim is carried to `delete.after` in a `WeakSet` keyed by the row object Better Auth passes to
 * both hooks — the same object instance, held weakly, so nothing here outlives the request.
 */
const claimedRemovals = new WeakSet<object>();

/** Kysely reports a delete's row count as a bigint; anything else means the dialect told us nothing. */
function removedARow(numDeletedRows: unknown): boolean {
  if (typeof numDeletedRows === "bigint") return numDeletedRows > 0n;
  if (typeof numDeletedRows === "number") return numDeletedRows > 0;
  return false;
}

/**
 * Claim the removal of one account row, before Better Auth deletes it.
 *
 * **A failed claim claims anyway.** If the delete throws — the binding is gone, the table is locked —
 * the caller still saw a row and a removal is still happening, so falling silent would turn a database
 * fault into a missing audit event. A trail that occasionally double-counts a removal costs somebody an
 * afternoon; one that silently drops removals costs the trail its purpose.
 */
export async function claimAccountRemoval(db: AuthDatabase, account: unknown): Promise<void> {
  if (typeof account !== "object" || account === null) return;
  const id = (account as { id?: unknown }).id;
  if (typeof id !== "string" && typeof id !== "number") return;
  try {
    const result = await db.deleteFrom("pithyAuthAccounts").where("id", "=", String(id)).executeTakeFirst();
    if (removedARow(result?.numDeletedRows)) claimedRemovals.add(account);
  } catch {
    claimedRemovals.add(account);
  }
}

/** Whether this row's removal was claimed here — i.e. whether this caller is the one that removed it. */
export function removalWasClaimed(account: unknown): boolean {
  return typeof account === "object" && account !== null && claimedRemovals.has(account);
}
