// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { ConflictError, NotFoundError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { formattingLocaleOf } from "@pithy-sh/core/src/i18n/locale";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { EnqueueInput } from "@pithy-sh/email/src/send/enqueue";
import { type CompiledQuery, sql } from "kysely";
import { type AuthAuditAction, AuthAuditActions } from "../audit/actions";
import type { AuthConfig } from "../capability";
import type { AuthDatabase } from "../data/tables";
import type { UserLifecycleAction, UserLifecycleActorType } from "../data/userLifecycle";
import type { UserLifecycleHookEvent, UserLifecycleHooks, UserLifecycleListener } from "./hooks";
import { MAX_REASON } from "./reason";
import { accountStanding, LifecycleColumns } from "./state";

/**
 * The account-lifecycle transitions — the one place an account's state is ever changed (#620).
 *
 * The admin routes (#621, #622), the self-service deletion, and the purge Workflow call these and write
 * nothing themselves, so each transition happens the same way whoever asked for it:
 *
 * 1. **The columns move, conditionally, and the history row is written with them.** The `update` names the
 *    state it expects to find, so of two concurrent suspensions exactly one changes a row, and only that one
 *    goes on. A request that finds the account already where it asked to put it is `changed: false` and does
 *    nothing else — no row, no mail, no hook — which is what "once per transition" means.
 * 2. **The row in `pithy_auth_user_lifecycle`** — the actor, the reason, the time — is the second statement of
 *    the same `d1.batch()`, which D1 runs as one transaction, and it is written only when the first moved the
 *    account. Two awaits would leave a gap: a failed insert after a committed update, and a retry that finds
 *    the account already moved, returns `changed: false`, and loses the row, the event, the mail and the hook.
 * 3. **The audit event is emitted** — the trail answers who and from where; the row answers what happened.
 * 4. **The mail is enqueued**, when the config sends it, in the account's own language.
 * 5. **The hook fires.**
 *
 * Steps 3 to 5 report something that has already happened, so none of them can undo it: each swallows its own
 * failure, and a throwing hook or an email binding that is not there is logged and the transition stands.
 *
 * **What these do not do is end sessions.** Enforcement does not need them to — a suspended account's session
 * is refused at every door the moment the column is written (`./enforce.ts`) — and revoking them is a route's
 * decision, made through Better Auth so `onSessionRevoked` hears about it.
 */

/** Who made a transition. */
export interface LifecycleActor {
  /** The kind of principal. */
  readonly type: UserLifecycleActorType;
  /** Its id — the connection's for a management client, the user's own for self-service — or null. */
  readonly id: string | null;
}

/** Everything a transition needs, resolved by the caller from its own context. */
export interface LifecycleDeps {
  /** The auth tables. */
  readonly db: AuthDatabase;
  /** The same database as a binding, for the hooks — see `UserLifecycleListener`. */
  readonly d1: D1Database;
  /** The audit seam. A no-op when the audit capability is absent. */
  readonly emit: AuditEmit;
  /** The resolved config: the purge window, and which mails are sent. */
  readonly config: Pick<AuthConfig, "retention" | "lifecycleEmails">;
  /** The adopter's hooks. */
  readonly hooks: UserLifecycleHooks;
  /** The email capability's enqueue, bound to this run's env. Absent, nothing is mailed. */
  readonly enqueueEmail?: ((input: EnqueueInput) => Promise<unknown>) | undefined;
  /** Where a swallowed failure is reported. Absent, it is swallowed silently. */
  readonly log?: Logger | undefined;
  /** The clock. Defaults to the system's. */
  readonly now?: (() => Date) | undefined;
  /**
   * The request a transition was asked from, carried onto its audit event: the correlation every admin event
   * carries, and metadata the caller adds — the management connection's id, for a control-plane call.
   */
  readonly context?: LifecycleAuditContext | undefined;
}

/** What the caller's request adds to a transition's audit event. */
export interface LifecycleAuditContext {
  /** The caller's address, from `cf-connecting-ip`. */
  readonly ip?: string | undefined;
  /** The caller's user agent. */
  readonly userAgent?: string | undefined;
  /** The request's id, from `cf-ray`. */
  readonly requestId?: string | undefined;
  /** Extra metadata, merged under the transition's own. */
  readonly metadata?: Record<string, unknown> | undefined;
}

/** What a transition did. */
export interface LifecycleTransition {
  /** Whether the account moved. `false` when it was already where the call asked to put it. */
  readonly changed: boolean;
  /** Whether a lifecycle mail was enqueued for the account. False when the config, the call or a missing email capability sent none. */
  readonly mailed: boolean;
}

/** What a suspension did, and the suspension it left in force. */
export interface SuspendTransition extends LifecycleTransition {
  /**
   * True when the account was already suspended and this call restated the reason and the end instead (#621).
   * That is not a transition — `changed` is false and no hook fires — but it is written, audited and mailed.
   */
  readonly updated: boolean;
  /** When the suspension in force began. A restatement keeps the original start. */
  readonly suspendedAt: Date;
  /** When it ends by itself, or null for one that lasts until a reinstatement. */
  readonly suspendedUntil: Date | null;
}

/** A reason, trimmed and bounded, or null when none was given. */
function reasonOf(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  const trimmed = reason.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_REASON) {
    throw new ValidationError({
      message: `A reason is at most ${MAX_REASON} characters.`,
      detail: `lifecycle reason of ${trimmed.length} characters`,
    });
  }
  return trimmed;
}

/** The account a transition acts on: who to write to, and where it stands. */
interface Subject {
  readonly email: string;
  readonly name: string;
  readonly locale: string | null;
  readonly columns: LifecycleColumns;
}

async function subjectOf(db: AuthDatabase, userId: string): Promise<Subject> {
  const row = await db
    .selectFrom("pithyAuthUsers")
    .select(["email", "name", "locale", "suspendedAt", "suspendedUntil", "deletedAt", "purgeAfter"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!row) {
    throw new NotFoundError({
      message: "No such account.",
      action: "If it was deleted and its purge has run, its data is gone and there is nothing to act on.",
      detail: `lifecycle transition for user ${userId}, which has no row`,
    });
  }
  return { email: row.email, name: row.name, locale: row.locale ?? null, columns: LifecycleColumns.parse(row) };
}

/** A date written for its reader, in their language — the shape every lifecycle mail carries its dates in. */
function readable(date: Date, locale: string | null): string {
  const tag = (locale ? formattingLocaleOf(locale) : null) ?? "en";
  return new Intl.DateTimeFormat(tag, { dateStyle: "long", timeZone: "UTC" }).format(date);
}

/** One row of an account's history. */
interface HistoryRow {
  readonly userId: string;
  readonly action: UserLifecycleAction;
  readonly actor: LifecycleActor;
  readonly reason: string | null;
  readonly at: Date;
  readonly suspendedUntil?: Date | null;
  readonly step?: string | null;
  /** A hard deletion's choice for the purge's last mail; see `UserLifecycleEvent.notify`. */
  readonly notify?: boolean | null;
  /** A deletion's mode, kept for the erasure attestation (#823). */
  readonly mode?: DeletionMode | null;
  /** When a deletion's purge comes due, kept for the erasure attestation (#823). */
  readonly purgeAfter?: Date | null;
}

/** The history row's values, as the table stores them. */
function encoded(row: HistoryRow) {
  return {
    userId: row.userId,
    action: row.action,
    actorType: row.actor.type,
    actorId: row.actor.id,
    reason: row.reason,
    suspendedUntil: row.suspendedUntil ? SQLiteDate.encode(row.suspendedUntil) : null,
    step: row.step ?? null,
    notify: row.notify === undefined || row.notify === null ? null : SQLiteBoolean.encode(row.notify),
    mode: row.mode ?? null,
    purgeAfter: row.purgeAfter ? SQLiteDate.encode(row.purgeAfter) : null,
    createdAt: SQLiteDate.encode(row.at),
  };
}

/** A history row with no column change to pair it with: a purge step, a finished purge. Not swallowed. */
async function record(deps: LifecycleDeps, row: HistoryRow): Promise<void> {
  await deps.db.insertInto("pithyAuthUserLifecycle").values(encoded(row)).execute();
}

/** Bind a compiled statement to D1, so it can join a `batch`. */
function prepared(d1: D1Database, compiled: CompiledQuery): D1PreparedStatement {
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}

/**
 * Move the columns and write the history row as one transaction, and say whether the account moved.
 *
 * The insert is guarded by `changes()`, which SQLite answers for the statement just before it — the update —
 * so a conditional update that matched nothing writes no row. Not swallowed: until both are written, nothing
 * after them runs.
 */
async function move(deps: LifecycleDeps, update: { compile(): CompiledQuery }, row: HistoryRow): Promise<boolean> {
  const v = encoded(row);
  const insert = deps.db
    .insertInto("pithyAuthUserLifecycle")
    .columns([
      "userId",
      "action",
      "actorType",
      "actorId",
      "reason",
      "suspendedUntil",
      "step",
      "notify",
      "mode",
      "purgeAfter",
      "createdAt",
    ])
    .expression(
      deps.db
        .selectNoFrom([
          sql.val(v.userId).as("userId"),
          sql.val(v.action).as("action"),
          sql.val(v.actorType).as("actorType"),
          sql.val(v.actorId).as("actorId"),
          sql.val(v.reason).as("reason"),
          sql.val(v.suspendedUntil).as("suspendedUntil"),
          sql.val(v.step).as("step"),
          sql.val(v.notify).as("notify"),
          sql.val(v.mode).as("mode"),
          sql.val(v.purgeAfter).as("purgeAfter"),
          sql.val(v.createdAt).as("createdAt"),
        ])
        .where(sql<number>`changes()`, ">", 0),
    )
    .compile();
  const [updated] = await deps.d1.batch([prepared(deps.d1, update.compile()), prepared(deps.d1, insert)]);
  return (updated?.meta.changes ?? 0) > 0;
}

/** The audit event, swallowed on failure — an audit write never breaks what it records. */
async function audit(
  deps: LifecycleDeps,
  action: AuthAuditAction,
  userId: string,
  actor: LifecycleActor,
  metadata: Record<string, unknown>,
): Promise<void> {
  const context = deps.context;
  const event: AuditEventInput = {
    action,
    outcome: "success",
    actorType: actor.type,
    actorId: actor.id,
    resourceType: "user",
    resourceId: userId,
    ...(context?.ip ? { ip: context.ip } : {}),
    ...(context?.userAgent ? { userAgent: context.userAgent } : {}),
    ...(context?.requestId ? { requestId: context.requestId } : {}),
    metadata: { ...context?.metadata, ...metadata },
  };
  try {
    await deps.emit(event);
  } catch (error) {
    deps.log?.warn(`lifecycle audit ${action} failed; the transition stands`, { reason: messageOf(error) });
  }
}

/** One lifecycle mail, when the config sends it. Swallowed on failure, like the audit write. Says whether it was enqueued. */
async function mail(
  deps: LifecycleDeps,
  enabled: boolean,
  to: string,
  locale: string | null,
  template: "accountSuspended" | "accountReinstated" | "deletionScheduled" | "deletionComplete",
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (!enabled || !deps.enqueueEmail) return false;
  try {
    await deps.enqueueEmail({ to, template, payload, ...(locale ? { locale } : {}) });
    return true;
  } catch (error) {
    deps.log?.warn(`lifecycle mail ${template} could not be enqueued; the transition stands`, {
      reason: messageOf(error),
    });
    return false;
  }
}

/** Fire one hook. Swallowed and logged: the transition is already written, and a retry would fire nothing. */
async function fire(
  deps: LifecycleDeps,
  name: keyof UserLifecycleHooks,
  hook: UserLifecycleListener | undefined,
  event: UserLifecycleHookEvent,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(event, deps.d1);
  } catch (error) {
    deps.log?.warn(`${name} threw; the transition stands`, { userId: event.userId, reason: messageOf(error) });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Without a name, a greeting says "Hi," rather than greeting an empty string. */
function named(name: string): { name?: string } {
  return name.trim() ? { name } : {};
}

/** The conflict for a deleted account: deletion outranks a suspension, so restore it first. */
function deletedConflict(restoreRoute: string | undefined, then: string): ConflictError {
  return new ConflictError({
    message: restoreRoute
      ? `This account is deleted. Restore it with ${restoreRoute} first.`
      : "This account is deleted. Restore it first.",
    action: restoreRoute ? `Restore it with ${restoreRoute}. ${then}` : `Restore it first. ${then}`,
  });
}

/** The conflict for a write that found the account moved under it by another request. Retrying is safe. */
function raced(userId: string): ConflictError {
  return new ConflictError({
    message: "The account changed while this request was being made. Send it again.",
    detail: `lifecycle write for user ${userId} matched no row; another request moved the account first`,
  });
}

/**
 * The instant a purge-window guard compares against, **read when the statement runs**, as ms-epoch (#622).
 *
 * A restore and a purge's `due` check race for one account, and each has to see the window the other saw. A
 * timestamp the restore took before its statement went out is stale by the time D1 runs it: the window can
 * close in between, by itself or because a hard deletion brought it forward, and a purge whose `due` check ran
 * in that gap goes on to erase an account the restore reported back. So on the system clock the guard is the
 * database's own time, evaluated inside the statement, and D1 runs statements one at a time: whichever lands
 * first, the other sees it. An injected clock is a test's, and is read afresh here, at the statement.
 */
function windowClock(deps: LifecycleDeps) {
  return deps.now
    ? sql<number>`${deps.now().getTime()}`
    : sql<number>`cast(round(unixepoch('subsec') * 1000) as integer)`;
}

/** The conflict for an account whose purge window has closed: nothing can restore it now. */
function windowClosed(userId: string, closes: Date): ConflictError {
  return new ConflictError({
    message: `This account's purge window closed on ${closes.toISOString()}. It can no longer be restored.`,
    action: "The purge is due and erases its data once it runs. There is nothing to restore.",
    detail: `restore for user ${userId}, whose purge was due at ${closes.toISOString()}`,
  });
}

/**
 * Suspend an account, until `until` or until it is reinstated.
 *
 * A deleted account cannot be suspended — deletion already shuts it, and outranks a suspension — so that is a
 * conflict rather than a no-op, and names `restoreRoute` when the caller gives one. A suspension whose end has
 * passed is not in force, and a new one replaces it.
 *
 * **An account already suspended has its terms restated (#621).** The reason and the end are replaced, a
 * `suspended` row records the new reason — the newest one is what the person is shown — and the audit event
 * and the mail say so. The start is kept, and no hook fires: the account was suspended and still is, so
 * nothing transitioned. A fresh suspension that loses the race to another suspension finds the account
 * suspended, so it retries once as a restatement rather than failing. A write that finds the account moved
 * under it any other way, by a reinstatement or a deletion that landed first, is a conflict: what the caller
 * asked for no longer describes the account.
 *
 * `notify: false` sends no mail, whatever the config says; the config can only turn mail off, never on.
 */
export async function suspendUser(
  deps: LifecycleDeps,
  input: {
    userId: string;
    actor: LifecycleActor;
    reason: string | null;
    until?: Date | null;
    notify?: boolean;
    restoreRoute?: string;
  },
): Promise<SuspendTransition> {
  const at = (deps.now ?? (() => new Date()))();
  const reason = reasonOf(input.reason);
  const until = input.until ?? null;
  if (until && until.getTime() <= at.getTime()) {
    throw new ValidationError({ message: "A suspension must end in the future, or not at all." });
  }
  const subject = await subjectOf(deps.db, input.userId);
  const standing = accountStanding(subject.columns, at);
  if (standing.state === "deleted") {
    throw deletedConflict(input.restoreRoute, "Then suspend it, if it should be suspended instead.");
  }
  const encodedUntil = until ? SQLiteDate.encode(until) : null;
  /** The same suspension, still in force: pinned by its start, so a reinstate-then-suspend in between is a different suspension and this write matches nothing. */
  const restatement = (startedAt: Date) =>
    deps.db
      .updateTable("pithyAuthUsers")
      .set({ suspendedUntil: encodedUntil })
      .where("id", "=", input.userId)
      .where("deletedAt", "is", null)
      .where("suspendedAt", "=", SQLiteDate.encode(startedAt))
      .where((eb) => eb.or([eb("suspendedUntil", "is", null), eb("suspendedUntil", ">", SQLiteDate.encode(at))]));
  const fresh = deps.db
    .updateTable("pithyAuthUsers")
    .set({ suspendedAt: SQLiteDate.encode(at), suspendedUntil: encodedUntil })
    .where("id", "=", input.userId)
    .where("deletedAt", "is", null)
    .where((eb) =>
      eb.or([
        eb("suspendedAt", "is", null),
        eb.and([eb("suspendedUntil", "is not", null), eb("suspendedUntil", "<=", SQLiteDate.encode(at))]),
      ]),
    );
  const row: HistoryRow = {
    userId: input.userId,
    action: "suspended",
    actor: input.actor,
    reason,
    at,
    suspendedUntil: until,
  };
  let updated = standing.state === "suspended";
  let startedAt = updated && subject.columns.suspendedAt ? subject.columns.suspendedAt : at;
  if (!(await move(deps, updated ? restatement(startedAt) : fresh, row))) {
    // A fresh suspension that lost to another suspension landing first finds the account suspended, which
    // is the case a restatement answers: retry once as one. Anything else — a deletion, or a restatement
    // that lost to a reinstatement — means what the caller asked for no longer describes the account.
    const now = updated ? null : await subjectOf(deps.db, input.userId);
    const moved = now ? accountStanding(now.columns, at) : null;
    if (!now?.columns.suspendedAt || moved?.state !== "suspended") throw raced(input.userId);
    updated = true;
    startedAt = now.columns.suspendedAt;
    if (!(await move(deps, restatement(startedAt), row))) throw raced(input.userId);
  }

  await audit(deps, AuthAuditActions.adminUserSuspended, input.userId, input.actor, {
    reason,
    suspendedUntil: until?.toISOString() ?? null,
    updated,
  });
  const mailed = await mail(
    deps,
    deps.config.lifecycleEmails.accountSuspended && input.notify !== false,
    subject.email,
    subject.locale,
    "accountSuspended",
    {
      ...named(subject.name),
      ...(reason ? { reason } : {}),
      ...(until ? { until: readable(until, subject.locale) } : {}),
    },
  );
  if (!updated) {
    await fire(deps, "onUserSuspended", deps.hooks.onUserSuspended, {
      userId: input.userId,
      actor: input.actor,
      reason,
      at,
      suspendedUntil: until,
    });
  }
  return { changed: !updated, updated, mailed, suspendedAt: startedAt, suspendedUntil: until };
}

/**
 * Lift a suspension. An account that is not suspended — including one whose suspension ran out — is a no-op.
 *
 * Where the account stands is read through `accountStanding`, never off the raw column, because a suspension
 * past its end leaves `suspendedAt` set and is not a suspension. A deleted account is a conflict, as it is
 * for `suspendUser`: deletion outranks the suspension it keeps, so lifting that suspension would mail "you can
 * sign in again" to somebody every sign-in still refuses. Restore it first.
 *
 * `notify: false` sends no mail, on the same rule as `suspendUser`.
 */
export async function reinstateUser(
  deps: LifecycleDeps,
  input: { userId: string; actor: LifecycleActor; reason: string | null; notify?: boolean; restoreRoute?: string },
): Promise<LifecycleTransition> {
  const at = (deps.now ?? (() => new Date()))();
  const reason = reasonOf(input.reason);
  const subject = await subjectOf(deps.db, input.userId);
  const standing = accountStanding(subject.columns, at);
  if (standing.state === "deleted") {
    throw deletedConflict(
      input.restoreRoute,
      "Its suspension stays in place through a restore, and can be lifted after.",
    );
  }
  if (standing.state !== "suspended") return { changed: false, mailed: false };
  const update = deps.db
    .updateTable("pithyAuthUsers")
    .set({ suspendedAt: null, suspendedUntil: null })
    .where("id", "=", input.userId)
    .where("deletedAt", "is", null)
    .where("suspendedAt", "is not", null)
    .where((eb) => eb.or([eb("suspendedUntil", "is", null), eb("suspendedUntil", ">", SQLiteDate.encode(at))]));
  const row: HistoryRow = { userId: input.userId, action: "reinstated", actor: input.actor, reason, at };
  if (!(await move(deps, update, row))) return { changed: false, mailed: false };

  await audit(deps, AuthAuditActions.adminUserReinstated, input.userId, input.actor, { reason });
  const mailed = await mail(
    deps,
    deps.config.lifecycleEmails.accountReinstated && input.notify !== false,
    subject.email,
    subject.locale,
    "accountReinstated",
    named(subject.name),
  );
  await fire(deps, "onUserReinstated", deps.hooks.onUserReinstated, {
    userId: input.userId,
    actor: input.actor,
    reason,
    at,
  });
  return { changed: true, mailed };
}

/** How a deletion runs: shut now and purged once the window closes, or purged now. */
export type DeletionMode = "soft" | "hard";

/** What a deletion did, and the deletion it left in force. */
export interface DeleteTransition extends LifecycleTransition {
  /**
   * `deleted` when this call deleted an account in good standing; `brought_forward` when the account was
   * already deleted and a hard deletion moved its purge to now; `unchanged` when it was already deleted and
   * this call had nothing to move.
   */
  readonly outcome: "deleted" | "brought_forward" | "unchanged";
  /** When the account was deleted. A deletion brought forward keeps its original start. */
  readonly deletedAt: Date;
  /** When the purge may erase it — now, for a hard deletion. Restorable until then. */
  readonly purgeAfter: Date;
}

/**
 * Delete an account. Audited as the account's own deletion when its holder is the actor.
 *
 * **Soft, the default**: it is shut now, and its data is erased once `retention.purgeAfterDays` have passed.
 * Restorable until then. The deletion-scheduled mail carries the purge date and, when the config names one,
 * the restore path. A deleted account deleted softly again is no transition.
 *
 * **Hard** (#622): `purgeAfter` is now, so the window is already closed — nothing can restore it — and the
 * caller starts the purge. No deletion-scheduled mail, because nothing is scheduled; the purge sends the
 * deletion-complete one. An account already deleted softly has its purge brought forward to now, which is
 * written and audited but fires no hook: the account was deleted and still is. One already due is unchanged.
 *
 * A suspension the account was under is left in place, so restoring the account does not lift it.
 * `notify: false` sends no mail, whatever the config says.
 */
export async function deleteUser(
  deps: LifecycleDeps,
  input: { userId: string; actor: LifecycleActor; reason: string | null; mode?: DeletionMode; notify?: boolean },
): Promise<DeleteTransition> {
  const at = (deps.now ?? (() => new Date()))();
  const reason = reasonOf(input.reason);
  const hard = input.mode === "hard";
  const purgeAfter = hard ? at : new Date(at.getTime() + deps.config.retention.purgeAfterDays * 86_400_000);
  const subject = await subjectOf(deps.db, input.userId);
  // A hard deletion's `notify` is the purge's to read, so it is written on the row: the purge that sends the last
  // mail may be one the daily pass started, with no request to carry it (#622).
  // The mode and the due instant ride on the row too, because the purge erases the account's own column and the
  // erasure attestation still has to say both (#823).
  const row: HistoryRow = {
    userId: input.userId,
    action: "deleted",
    actor: input.actor,
    reason,
    at,
    mode: hard ? "hard" : "soft",
    purgeAfter,
    ...(hard && input.notify !== undefined ? { notify: input.notify } : {}),
  };
  const existing = subject.columns.deletedAt;
  if (existing) {
    const due = subject.columns.purgeAfter ?? existing;
    const unchanged = {
      changed: false,
      mailed: false,
      outcome: "unchanged",
      deletedAt: existing,
      purgeAfter: due,
    } as const;
    if (!hard || due.getTime() <= at.getTime()) return unchanged;
    // Brought forward: the same deletion, with its window closed now. Pinned by its start, so a restore and a
    // fresh deletion in between is a different deletion and this write matches nothing.
    const forward = deps.db
      .updateTable("pithyAuthUsers")
      .set({ purgeAfter: SQLiteDate.encode(at) })
      .where("id", "=", input.userId)
      .where("deletedAt", "=", SQLiteDate.encode(existing))
      .where("purgeAfter", ">", SQLiteDate.encode(at));
    if (!(await move(deps, forward, row))) return unchanged;
    await audit(deps, AuthAuditActions.adminUserHardDeleted, input.userId, input.actor, {
      reason,
      purgeAfter: at.toISOString(),
      broughtForward: true,
    });
    return { changed: false, mailed: false, outcome: "brought_forward", deletedAt: existing, purgeAfter: at };
  }
  const update = deps.db
    .updateTable("pithyAuthUsers")
    .set({ deletedAt: SQLiteDate.encode(at), purgeAfter: SQLiteDate.encode(purgeAfter) })
    .where("id", "=", input.userId)
    .where("deletedAt", "is", null);
  if (!(await move(deps, update, row))) {
    // Another deletion landed first. The account is where this call asked to put it, so it is no transition;
    // anything else moved it is a conflict, and a retry reads it afresh.
    const now = await subjectOf(deps.db, input.userId);
    if (!now.columns.deletedAt) throw raced(input.userId);
    const due = now.columns.purgeAfter ?? now.columns.deletedAt;
    return { changed: false, mailed: false, outcome: "unchanged", deletedAt: now.columns.deletedAt, purgeAfter: due };
  }

  const self = input.actor.type === "user" && input.actor.id === input.userId;
  const action = hard
    ? AuthAuditActions.adminUserHardDeleted
    : self
      ? AuthAuditActions.userSelfDeleted
      : AuthAuditActions.adminUserSoftDeleted;
  await audit(deps, action, input.userId, input.actor, { reason, purgeAfter: purgeAfter.toISOString() });
  const restoreUrl = deps.config.retention.restoreUrl;
  const mailed = hard
    ? false
    : await mail(
        deps,
        deps.config.lifecycleEmails.deletionScheduled && input.notify !== false,
        subject.email,
        subject.locale,
        "deletionScheduled",
        {
          ...named(subject.name),
          purgeOn: readable(purgeAfter, subject.locale),
          ...(restoreUrl ? { restoreUrl } : {}),
        },
      );
  await fire(deps, "onUserDeleted", deps.hooks.onUserDeleted, {
    userId: input.userId,
    actor: input.actor,
    reason,
    at,
    purgeAfter,
  });
  return { changed: true, mailed, outcome: "deleted", deletedAt: at, purgeAfter };
}

/** What a restoration did, and where it left the account. */
export interface RestoreTransition extends LifecycleTransition {
  /** Where the account stands now: `active`, or `suspended` when a suspension it was under is still in force. */
  readonly state: "active" | "suspended";
}

/**
 * Restore a deleted account inside its purge window.
 *
 * **Only inside it.** Once `purgeAfter` has passed the purge is due, may already be running, and erases each
 * capability's rows in turn, so restoring then would hand back an account with some of its data gone. That
 * is a conflict naming the date the window closed. After the purge there is no account at all, and that is a
 * 404 whose action says the data is gone — read off the history row the purge leaves behind, so it is told
 * apart from an id that never existed.
 *
 * An account that is not deleted is no transition. A suspension it was under is still in force after.
 */
export async function restoreUser(
  deps: LifecycleDeps,
  input: { userId: string; actor: LifecycleActor; reason: string | null },
): Promise<RestoreTransition> {
  const at = (deps.now ?? (() => new Date()))();
  const reason = reasonOf(input.reason);
  const subject = await subjectOf(deps.db, input.userId).catch(async (error: unknown) => {
    throw (await purgedRefusal(deps.db, input.userId)) ?? error;
  });
  const suspended = (columns: LifecycleColumns) =>
    accountStanding({ ...columns, deletedAt: null, purgeAfter: null }, at).state === "suspended";
  const state = suspended(subject.columns) ? "suspended" : "active";
  if (!subject.columns.deletedAt) return { changed: false, mailed: false, state };
  // Early, and only ever early: `at` was read before the account was, so a window it finds closed is closed. One
  // it finds open may not be by the time the update runs, which is why the update guards on its own clock.
  const closes = subject.columns.purgeAfter;
  if (closes && closes.getTime() <= at.getTime()) throw windowClosed(input.userId, closes);
  const update = deps.db
    .updateTable("pithyAuthUsers")
    .set({ deletedAt: null, purgeAfter: null })
    .where("id", "=", input.userId)
    .where("deletedAt", "is not", null)
    .where("purgeAfter", ">", windowClock(deps));
  const row: HistoryRow = { userId: input.userId, action: "restored", actor: input.actor, reason, at };
  if (!(await move(deps, update, row))) {
    // Another restoration landed first: no transition. A window that closed while this one was in flight — by
    // itself, or brought forward by a hard deletion — is the conflict above. Anything else a retry reads afresh.
    const now = await subjectOf(deps.db, input.userId).catch(async (error: unknown) => {
      throw (await purgedRefusal(deps.db, input.userId)) ?? error;
    });
    if (!now.columns.deletedAt) {
      return { changed: false, mailed: false, state: suspended(now.columns) ? "suspended" : "active" };
    }
    // Read afresh: a window still open now means something else moved the account — a restore and a new
    // deletion both landed in between — and that is the retry's to read.
    const closed = now.columns.purgeAfter;
    if (closed && closed.getTime() <= (deps.now ?? (() => new Date()))().getTime()) {
      throw windowClosed(input.userId, closed);
    }
    throw raced(input.userId);
  }

  await audit(deps, AuthAuditActions.adminUserRestored, input.userId, input.actor, { reason });
  return { changed: true, mailed: false, state };
}

/**
 * The refusal for an account the purge has erased, or `null` when none was. A 404, because there is no
 * account, with the date in the action so an operator answering a restore request knows it is final.
 */
async function purgedRefusal(db: AuthDatabase, userId: string): Promise<NotFoundError | null> {
  const purged = await db
    .selectFrom("pithyAuthUserLifecycle")
    .select("createdAt")
    .where("userId", "=", userId)
    .where("action", "=", "purged")
    .orderBy("id", "desc")
    .executeTakeFirst();
  if (!purged) return null;
  const on = SQLiteDate.parse(purged.createdAt).toISOString();
  return new NotFoundError({
    message: "No such account.",
    action: `This account was purged on ${on}. Its data is gone, and there is nothing to restore or export.`,
    detail: `user ${userId} was purged at ${on}`,
  });
}

/**
 * The account's row, or the refusal for one that is not there — the 404 that says the data is gone when the
 * purge erased it, and the plain one otherwise. For a route that reads an account outside a transition: the
 * export.
 */
export async function requirePresent(db: AuthDatabase, userId: string): Promise<void> {
  const row = await db.selectFrom("pithyAuthUsers").select("id").where("id", "=", userId).executeTakeFirst();
  if (row) return;
  throw (
    (await purgedRefusal(db, userId)) ??
    new NotFoundError({ message: "No such user.", detail: `no pithy_auth_users row for ${userId}` })
  );
}

/** The purge's own actor: a scheduled job, with nobody calling. */
const PURGE: LifecycleActor = { type: "system", id: null };

/** Who the purge's last mail goes to, captured before any step erases the address. */
export interface PurgeRecipient {
  readonly email: string;
  readonly name: string | null;
  readonly locale: string | null;
}

/**
 * Whether one account is due for its purge, who its last mail goes to, and whether it goes (#622).
 *
 * `due` only for an account that is deleted and whose `purgeAfter` has passed — the cron and a hard deletion
 * both start a purge, and this is the one check either passes through, so an account restored in between is
 * `not_due` and nothing is erased. `gone` when there is no row: the purge already erased it, or the id never
 * existed, and either way there is nothing to do. The recipient is read here, before the first step, because
 * the last step erases it.
 *
 * `notify` is what the deletion in force asked of the last mail — its newest `deleted` row's — so a hard
 * deletion's `notify: false` holds for a purge the daily pass started, which was handed no such parameter.
 */
export async function purgeSubject(
  deps: LifecycleDeps,
  userId: string,
): Promise<
  { state: "due"; recipient: PurgeRecipient; notify: boolean | null } | { state: "not_due" } | { state: "gone" }
> {
  // The instant is the database's, read in the same statement as the row — the clock `restoreUser` guards on, so
  // a restore and this check agree on whether the window has closed, whichever runs first (#622).
  const row = await deps.db
    .selectFrom("pithyAuthUsers")
    .select(["email", "name", "locale", "suspendedAt", "suspendedUntil", "deletedAt", "purgeAfter"])
    .select(windowClock(deps).as("checkedAt"))
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!row) return { state: "gone" };
  const columns = LifecycleColumns.parse(row);
  if (!columns.deletedAt || !columns.purgeAfter || columns.purgeAfter.getTime() > Number(row.checkedAt)) {
    return { state: "not_due" };
  }
  const deletion = await deps.db
    .selectFrom("pithyAuthUserLifecycle")
    .select("notify")
    .where("userId", "=", userId)
    .where("action", "=", "deleted")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  const saved = deletion?.notify;
  const notify = saved === undefined || saved === null ? null : SQLiteBoolean.decode(saved);
  return { state: "due", recipient: { email: row.email, name: row.name, locale: row.locale ?? null }, notify };
}

/**
 * The account's address, as a purge step reads it (#814) — `null` when there is no account, or no address. Read
 * inside the step that asks, so it is never carried in a Workflow's journal.
 */
export async function purgeAddress(db: AuthDatabase, userId: string): Promise<string | null> {
  const row = await db.selectFrom("pithyAuthUsers").select("email").where("id", "=", userId).executeTakeFirst();
  return row?.email ?? null;
}

/** One account whose purge is due: which, and the deletion it is due under — ms-epoch, so a Workflow journal holds it. */
export interface DuePurge {
  readonly userId: string;
  readonly deletedAt: number;
}

/**
 * The accounts whose purge is due — deleted, with `purgeAfter` passed — oldest first, at most `limit` (#622).
 * What the daily cron starts a purge for. An account still inside its window is not here, and neither is one
 * that was restored. Each carries its deletion's start, which names the purge's instance (`../purge/start.ts`).
 */
export async function duePurges(deps: LifecycleDeps, limit: number): Promise<DuePurge[]> {
  const at = (deps.now ?? (() => new Date()))();
  const rows = await deps.db
    .selectFrom("pithyAuthUsers")
    .select(["id", "deletedAt"])
    .where("deletedAt", "is not", null)
    .where("purgeAfter", "is not", null)
    .where("purgeAfter", "<=", SQLiteDate.encode(at))
    .orderBy("purgeAfter", "asc")
    .orderBy("id", "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({ userId: row.id, deletedAt: Number(row.deletedAt) }));
}

/**
 * Record that one purge step — one capability's contribution — erased its rows. The contribution's summary is
 * the row's reason, so the history says what the step erased and not only that it ran. With `retained`, the step
 * kept its rows instead (#814): the row is `purge_retained`, and its reason is the basis the capability gave.
 */
export async function recordPurgeStep(
  deps: LifecycleDeps,
  input: { userId: string; step: string; summary?: string | null; retained?: boolean },
): Promise<void> {
  const at = (deps.now ?? (() => new Date()))();
  await record(deps, {
    userId: input.userId,
    // A retained step kept its rows (#814): its own action, so the trail never reads a kept step as an erased one.
    action: input.retained ? "purge_retained" : "purge_step",
    actor: PURGE,
    reason: input.summary?.trim() ? input.summary.trim().slice(0, MAX_REASON) : null,
    at,
    step: input.step,
  });
  // The trail's record of the step, which the erasure attestation cites by id and chain position (#823). The step's
  // name and disposition only: the summary is the row's, and the trail never holds anything about the person.
  await audit(deps, AuthAuditActions.adminUserPurgeStep, input.userId, PURGE, {
    step: input.step,
    disposition: input.retained ? "retained" : "erased",
  });
}

/**
 * Record that a purge gave up (#823): the step it stopped at, in the history and in the trail. The daily pass starts
 * the purge again tomorrow, so this is where it stands until then, not an end. The failure's message is never
 * written: it is code the kit did not write, and it may name the person.
 */
export async function recordPurgeFailure(deps: LifecycleDeps, input: { userId: string; step: string }): Promise<void> {
  const at = (deps.now ?? (() => new Date()))();
  await record(deps, {
    userId: input.userId,
    action: "purge_failed",
    actor: PURGE,
    reason: null,
    at,
    step: input.step,
  });
  await audit(deps, AuthAuditActions.adminUserPurgeFailed, input.userId, PURGE, { step: input.step });
}

/**
 * The deletion-complete mail, sent **before the address is erased** (#622). The purge calls this after every
 * other capability's rows are gone and before auth's own, which holds the address, so the last mail is
 * enqueued while there is still an account to have sent it to. The address is handed in, captured before the
 * first step. `notify: false` sends nothing, whatever the config says.
 */
export async function mailPurgeComplete(
  deps: LifecycleDeps,
  input: { recipient: PurgeRecipient; notify?: boolean },
): Promise<LifecycleTransition> {
  const at = (deps.now ?? (() => new Date()))();
  const { email, name, locale } = input.recipient;
  const mailed = await mail(
    deps,
    deps.config.lifecycleEmails.deletionComplete && input.notify !== false,
    email,
    locale,
    "deletionComplete",
    { ...named(name ?? ""), purgedOn: readable(at, locale) },
  );
  return { changed: false, mailed };
}

/**
 * Finish a purge: the record, the audit event, the hook. The last thing that happens to the account.
 *
 * By the time a purge finishes the user row is gone, so this reads nothing about the account. Finishing a
 * purge that already finished is a no-op, so a retried Workflow step records and fires once — and so do two
 * purges of one account that overlapped. **The insert is the check**: `0005_purge_once` allows one `purged` row
 * per account, the insert ignores a second, and only the call whose row landed audits and fires. A read
 * before the insert would let two concurrent calls both find nothing and both write.
 */
export async function completePurge(deps: LifecycleDeps, input: { userId: string }): Promise<LifecycleTransition> {
  const at = (deps.now ?? (() => new Date()))();
  const inserted = await deps.db
    .insertInto("pithyAuthUserLifecycle")
    .values(encoded({ userId: input.userId, action: "purged", actor: PURGE, reason: null, at }))
    .onConflict((conflict) => conflict.doNothing())
    .executeTakeFirst();
  if (Number(inserted.numInsertedOrUpdatedRows ?? 0n) === 0) return { changed: false, mailed: false };

  await audit(deps, AuthAuditActions.adminUserPurged, input.userId, PURGE, {});
  await fire(deps, "onUserPurged", deps.hooks.onUserPurged, { userId: input.userId, actor: PURGE, reason: null, at });
  return { changed: true, mailed: false };
}
