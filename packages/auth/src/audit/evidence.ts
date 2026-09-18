// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuthDatabase } from "../data/tables";

/**
 * **Evidence that the thing an event claims actually happened, carried from the database hook that saw
 * it to the emitter that writes the row.**
 *
 * Every part of this file exists for the same reason, which is the reason #627 exists: an audit event is
 * a claim about the world, and the place a request is answered is not always the place that knows
 * whether the claim is true. `/sign-out` answers `200 {"success":true}` having found no session to
 * delete; `/email-otp/send-verification-otp` answers `200 {"success":true}` having declined to send;
 * `deleteWithHooks` runs `delete.after` on a row it read rather than on a row it removed. In none of
 * those is the endpoint lying — the event was.
 *
 * **A non-2xx is sufficient evidence of a refusal and is nowhere near necessary.** That is the general
 * shape: a status says whether the *request* was answered, and some events claim something stronger than
 * that — a message queued, a session gone, a row removed. Those have to be observed where they happen,
 * which is never the `after` hook that writes the row.
 *
 * None of these markers is request state Better Auth offers, so each is held weakly, keyed by an object
 * the runtime already scopes correctly: the row instance for a removal, and the endpoint's own
 * per-dispatch context object for a session and for a queued message (`dispatchAuthEndpoint` builds a
 * fresh `context` per call, and hands the same object to database hooks, send callbacks and the `after`
 * hook alike). Weakly, so nothing here outlives the request that made it.
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
 * **What the email seam did with one message — the answer `SendAuthEmail` hands back.**
 *
 * The three are not degrees of the same thing, and collapsing any two of them is how the trail starts
 * misreporting. A message that reached the queue is a send. A message the capability **withheld** is that
 * capability working correctly — the address hard-bounced, or the person complained — so the trail says
 * the send did not happen and why it did not, never that something broke. A send that **failed** did
 * break, and the operator reading it is looking for a binding or a migration rather than for an abuser.
 *
 * `reason` is a closed vocabulary in both cases, never an error message: a suppression reason from
 * `@pithy-sh/email`, or {@link SEND_FAULT}. An audit row is long-lived and queryable, and a thrown
 * error's text is the one thing in reach that nobody has vetted for what it might carry.
 */
export type AuthEmailDelivery =
  /** Handed to the email seam, which wrote a job row for it. A send is what the trail may claim. */
  | { readonly delivery: "queued" }
  /** The capability withheld it, correctly, and named why. Not a fault, and not a send. */
  | { readonly delivery: "withheld"; readonly reason: string }
  /** The seam itself failed. Nothing was queued and something is wrong with this deployment. */
  | { readonly delivery: "failed"; readonly reason: string };

/** The one reason a failed delivery reports. The thrown error's own text never reaches an audit row. */
export const SEND_FAULT = "enqueue-failed";

/** What the email seam answered during one request, keyed by that request's Better Auth context object. */
const messageDeliveries = new WeakMap<object, AuthEmailDelivery>();

/**
 * Record what the email seam did with this request's magic link or OTP.
 *
 * **Called from the send callback, which is the only place that knows.** `auth/magic_link_sent` and
 * `auth/otp_sent` claim a message exists, and the two send endpoints answer `200 {"success":true}`
 * whether or not one does. `/email-otp/send-verification-otp` declines twice over before the callback is
 * even reached: Better Auth drops the verification row and returns success rather than confirm that an
 * address is registered (`plugins/email-otp/routes.mjs`), and the kit's own `sendVerificationOTP` returns
 * without queuing for any `type` but `sign-in`. Neither decline is visible from the status, from the
 * body, or from anywhere the `after` hook can reach.
 *
 * **Marked after the await, which is the whole of #627's last hole.** An earlier revision marked at the
 * call — before `sendEmail` was awaited — reasoning that `runInBackgroundOrAwait` might defer the rest of
 * the callback past the response. It defers only when `options.advanced.backgroundTasks.handler` is set
 * (`better-auth/dist/context/create-context.mjs`, `runInBackgroundOrAwait`), and `makeAuth` sets no such
 * handler and exposes no way for an adopter to; absent one it awaits, so the mark still lands before the
 * `after` hook. What marking early cost was everything underneath: a suppressed recipient and a thrown
 * enqueue both wrote `auth/otp_sent outcome=success`, over a `200 {"success":true}`, for an
 * unauthenticated caller on the default composition.
 *
 * So the claim recorded here is *what the email seam did*, which is as far as any of this can see —
 * delivery belongs to a Workflow that runs long after the response.
 */
export function markMessageDelivery(requestContext: unknown, delivery: AuthEmailDelivery): void {
  if (typeof requestContext !== "object" || requestContext === null) return;
  messageDeliveries.set(requestContext, delivery);
}

/** What the email seam answered during this request, or null if it was never reached. The send paths' evidence. */
export function messageDeliveryDuring(requestContext: unknown): AuthEmailDelivery | null {
  if (typeof requestContext !== "object" || requestContext === null) return null;
  return messageDeliveries.get(requestContext) ?? null;
}

/**
 * **`delete.after` fires on a row that was read, not on a row that was removed — and that is a fact
 * about the primitive, not about any one table.**
 *
 * Better Auth's `deleteWithHooks` reads the row, runs `delete.before`, issues the delete, then runs
 * `delete.after` gated on *the row it read* being non-null. Nothing anywhere asks whether the delete
 * removed anything. So N callers racing for one row all find it, all issue a delete, exactly one of
 * those removes anything, and all N reach `delete.after` believing they did it. `deleteManyWithHooks`
 * has the same shape per entity. (`consumeOneWithHooks`, added for verification rows, gates its after
 * hooks on the consume — so upstream knows the shape; it has simply not been applied to the other two.)
 *
 * **Two producers of that one defect have now been driven to failure**, which is why the guard below is
 * a primitive rather than a branch in either of them. Concurrent unlinks emitted `auth/oauth_unlinked`
 * twice for one removal. Concurrent sign-outs then did it again on a different table: `/sign-out` reaches
 * `internalAdapter.deleteSession(token)`, every caller fires `session.delete.after`, `markSessionEnded`
 * runs for each, and `emitAfterRequest` wrote `auth/signout outcome=success` for requests that signed
 * nobody out. A third `delete.after` wired the obvious way would be the third producer.
 *
 * **The only single-winner fact available is the row's existence, so the claim *is* a delete.**
 * `delete.before` issues it; SQLite serializes the statements, so exactly one reports a removed row and
 * only that caller's `after` body runs. Better Auth's own delete then removes nothing, which it neither
 * checks nor reports — `deleteAccount`, `deleteSession` and the user-deletion cascade all discard the
 * count — so its control flow is untouched. It is the same gate `../token/rotation.ts`'s `consumeSession`
 * already uses for concurrent rotations, which is the other place this package had to decide who won.
 *
 * **Two preconditions, stated so a later reader can re-check them rather than trust them.**
 *
 * 1. *No `delete.before` veto runs after this one.* Plugin database hooks are registered before the
 *    instance's own (`runPluginInit` pushes `plugin:<id>` entries, then `source: "user"` last) and a
 *    `delete.before` returning `false` aborts immediately, so any veto has already fired and returned.
 *    The case it would not cover is `deleteManyWithHooks`, which runs every row's `before` first: a veto
 *    on the third row of a cascade would leave the first two already removed. Better Auth registers no
 *    `account` or `session` `delete.before`, and the kit composes no plugin that does.
 * 2. *The delete this pre-empts is a real delete.* `deleteWithHooks` and `deleteManyWithHooks` accept a
 *    `customDeleteFn` with `executeMainFn: false`, and Better Auth uses one for `endPreservedSessions` —
 *    which does not delete at all, it expires the row in place. `consumeOneWithHooks` is the same hazard
 *    in its other form: claiming there would delete the verification row before the consume could read
 *    it. Neither is reachable in this composition — `makeAuth` sets no `preserveSessionInDatabase` and
 *    wires no verification delete hook — and {@link ClaimableTable} is the list of models for which this
 *    has been checked. **One adopter-reachable way to break it, named rather than left implied:** a
 *    plugin's `init` may return options, `runPluginInit` merges them with `defu` under the instance's
 *    own, and the instance sets nothing for `preserveSessionInDatabase` — so a plugin that turns it on
 *    would have session rows removed here that Better Auth meant to expire in place. Both remain the
 *    dependency's to fix; see `surveyDeleteHooks` for what the kit holds from its own side.
 */

/**
 * The models a removal may be claimed on: reached only through a plain `deleteWithHooks` /
 * `deleteManyWithHooks`, keyed by a string `id`, and with no `customDeleteFn` in any path that reaches
 * them. Precondition 2 above is checked per entry, so adding one is a decision rather than a spelling.
 */
export type ClaimableTable = "pithyAuthAccounts" | "pithyAuthSessions";

/** Kysely reports a delete's row count as a bigint; anything else means the dialect told us nothing. */
function removedARow(numDeletedRows: unknown): boolean {
  if (typeof numDeletedRows === "bigint") return numDeletedRows > 0n;
  if (typeof numDeletedRows === "number") return numDeletedRows > 0;
  return false;
}

/**
 * Remove one row ahead of Better Auth and report whether this caller is the one that removed it.
 *
 * **A failed claim claims anyway.** If the delete throws — the binding is gone, the table is locked — the
 * caller still saw a row and a removal is still happening, so falling silent would turn a database fault
 * into a missing event. A trail that occasionally double-counts a removal costs somebody an afternoon;
 * one that silently drops removals costs the trail its purpose.
 */
async function claimRemoval(db: AuthDatabase, table: ClaimableTable, row: object): Promise<boolean> {
  const id = (row as { id?: unknown }).id;
  if (typeof id !== "string" && typeof id !== "number") return false;
  try {
    const result = await db.deleteFrom(table).where("id", "=", String(id)).executeTakeFirst();
    return removedARow(result?.numDeletedRows);
  } catch {
    return true;
  }
}

/**
 * The brand `claimedDelete` stamps on the `after` it produces, and the whole of what
 * {@link surveyDeleteHooks} reads.
 *
 * A private symbol rather than a property name, so nothing can satisfy the gate by declaring a flag: the
 * only way to carry it is to have come out of the function below.
 */
const CLAIMS_ITS_REMOVALS = Symbol("pithy.auth.claimsItsRemovals");

/** One model's delete hooks: the claim, and the handler only the caller that removed the row reaches. */
export interface ClaimedDelete<Row, Ctx> {
  /** Claims the removal by issuing the delete. Registered as `delete.before`. */
  before: (row: Row, ctx: Ctx) => Promise<void>;
  /** The supplied handler, gated on this caller having won the claim. Registered as `delete.after`. */
  after: (row: Row, ctx: Ctx) => Promise<void>;
}

/**
 * **Build a `delete` hook pair whose `after` runs once per removal rather than once per caller.**
 *
 * This is the shape every `delete.after` in this kit is wired through — session, account, and whatever
 * is added next — because the hole is in `deleteWithHooks` and therefore under all of them equally.
 * Handing back the pair rather than two loose functions is what makes the protection hard to omit: there
 * is no `after` to register without a `before` beside it, and the `after` carries a brand
 * {@link surveyDeleteHooks} can see, so a third model wired the obvious way fails a test rather than
 * quietly becoming the third producer.
 *
 * The claim is carried between the two hooks in a `WeakSet` keyed by the row object Better Auth passes to
 * both — the same instance, held weakly, so nothing here outlives the request — and the set is private to
 * one pair, so two models cannot read each other's claims.
 *
 * **What the gated handler must therefore be: a claim about a removal, wanting exactly-once.** An audit
 * event is one. So is `onSessionRevoked`, which tells whoever keyed state on a session that it has gone:
 * at-least-once still holds under the gate, because the only way a claim loses is that another caller won
 * it, and that caller runs the handler.
 */
export function claimedDelete<Row extends object, Ctx>(spec: {
  /** The Kysely the claim is issued through — the instance's own. */
  db: AuthDatabase;
  /** Which table the row belongs to. See {@link ClaimableTable} for what qualifies. */
  table: ClaimableTable;
  /** What to do for a removal this caller actually made. */
  after: (row: Row, ctx: Ctx) => Promise<void>;
}): ClaimedDelete<Row, Ctx> {
  const won = new WeakSet<object>();
  const after = async (row: Row, ctx: Ctx): Promise<void> => {
    if (!won.has(row)) return;
    await spec.after(row, ctx);
  };
  Object.defineProperty(after, CLAIMS_ITS_REMOVALS, { value: true });
  return {
    before: async (row: Row): Promise<void> => {
      if (await claimRemoval(spec.db, spec.table, row)) won.add(row);
    },
    after,
  };
}

/** What one walk of a `databaseHooks` object found. Both halves matter — see {@link surveyDeleteHooks}. */
export interface DeleteHookSurvey {
  /** Every model wiring a `delete.after`, protected or not. Empty means there was nothing to check. */
  wired: string[];
  /** Those whose `delete.after` did not come from {@link claimedDelete}. The invariant is that it is empty. */
  unclaimed: string[];
}

/**
 * **Walk a `databaseHooks` object and report every `delete.after` that is not claimed.**
 *
 * The rule this enforces is about the primitive, not about the models that happen to be wired today: it
 * reads whatever keys are there, so a model added tomorrow is covered the day it lands, and nothing here
 * mentions `session` or `account`. A `delete.after` passes only by being the function `claimedDelete`
 * produced — a `before` beside it is necessary and nowhere near sufficient, since a `before` that does
 * something else entirely would satisfy a shape check.
 *
 * `wired` is reported alongside so a caller can assert there was something to check. A gate whose subject
 * has gone missing — a renamed option, a hooks object built somewhere else — would otherwise pass by
 * finding nothing, which is the failure mode a gate exists to not have.
 */
export function surveyDeleteHooks(databaseHooks: unknown): DeleteHookSurvey {
  const survey: DeleteHookSurvey = { wired: [], unclaimed: [] };
  if (typeof databaseHooks !== "object" || databaseHooks === null) return survey;
  for (const [model, hooks] of Object.entries(databaseHooks as Record<string, unknown>)) {
    if (typeof hooks !== "object" || hooks === null) continue;
    const remove = (hooks as { delete?: unknown }).delete;
    if (typeof remove !== "object" || remove === null) continue;
    const { after, before } = remove as { after?: unknown; before?: unknown };
    if (typeof after !== "function") continue;
    survey.wired.push(model);
    const branded = (after as { [CLAIMS_ITS_REMOVALS]?: unknown })[CLAIMS_ITS_REMOVALS] === true;
    if (typeof before !== "function" || !branded) survey.unclaimed.push(model);
  }
  survey.wired.sort();
  survey.unclaimed.sort();
  return survey;
}
