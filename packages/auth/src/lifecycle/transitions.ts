// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
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
}

/** What a transition did. */
export interface LifecycleTransition {
  /** Whether the account moved. `false` when it was already where the call asked to put it. */
  readonly changed: boolean;
}

/** The longest reason the kit stores. It is shown to the person, so it is a sentence, not a case file. */
const MAX_REASON = 500;

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
    .columns(["userId", "action", "actorType", "actorId", "reason", "suspendedUntil", "step", "createdAt"])
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
  const event: AuditEventInput = {
    action,
    outcome: "success",
    actorType: actor.type,
    actorId: actor.id,
    resourceType: "user",
    resourceId: userId,
    metadata,
  };
  try {
    await deps.emit(event);
  } catch (error) {
    deps.log?.warn(`lifecycle audit ${action} failed; the transition stands`, { reason: messageOf(error) });
  }
}

/** One lifecycle mail, when the config sends it. Swallowed on failure, like the audit write. */
async function mail(
  deps: LifecycleDeps,
  enabled: boolean,
  to: string,
  locale: string | null,
  template: "accountSuspended" | "accountReinstated" | "deletionScheduled" | "deletionComplete",
  payload: Record<string, unknown>,
): Promise<void> {
  if (!enabled || !deps.enqueueEmail) return;
  try {
    await deps.enqueueEmail({ to, template, payload, ...(locale ? { locale } : {}) });
  } catch (error) {
    deps.log?.warn(`lifecycle mail ${template} could not be enqueued; the transition stands`, {
      reason: messageOf(error),
    });
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

/**
 * Suspend an account, until `until` or until it is reinstated.
 *
 * A deleted account cannot be suspended — deletion already shuts it, and outranks a suspension — so that is a
 * conflict rather than a no-op. A suspension whose end has passed is not in force, and a new one replaces it.
 */
export async function suspendUser(
  deps: LifecycleDeps,
  input: { userId: string; actor: LifecycleActor; reason: string | null; until?: Date | null },
): Promise<LifecycleTransition> {
  const at = (deps.now ?? (() => new Date()))();
  const reason = reasonOf(input.reason);
  const until = input.until ?? null;
  if (until && until.getTime() <= at.getTime()) {
    throw new ValidationError({ message: "A suspension must end in the future, or not at all." });
  }
  const subject = await subjectOf(deps.db, input.userId);
  const standing = accountStanding(subject.columns, at);
  if (standing.state === "deleted") {
    throw new ConflictError({
      message: "This account is deleted.",
      action: "Restore it first, if it should be suspended instead.",
    });
  }
  if (standing.state === "suspended") return { changed: false };
  const update = deps.db
    .updateTable("pithyAuthUsers")
    .set({ suspendedAt: SQLiteDate.encode(at), suspendedUntil: until ? SQLiteDate.encode(until) : null })
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
  if (!(await move(deps, update, row))) return { changed: false };

  await audit(deps, AuthAuditActions.adminUserSuspended, input.userId, input.actor, {
    reason,
    suspendedUntil: until?.toISOString() ?? null,
  });
  await mail(deps, deps.config.lifecycleEmails.accountSuspended, subject.email, subject.locale, "accountSuspended", {
    ...named(subject.name),
    ...(reason ? { reason } : {}),
    ...(until ? { until: readable(until, subject.locale) } : {}),
  });
  await fire(deps, "onUserSuspended", deps.hooks.onUserSuspended, {
    userId: input.userId,
    actor: input.actor,
    reason,
    at,
    suspendedUntil: until,
  });
  return { changed: true };
}

/**
 * Lift a suspension. An account that is not suspended — including one whose suspension ran out — is a no-op.
 *
 * Where the account stands is read through `accountStanding`, never off the raw column, because a suspension
 * past its end leaves `suspendedAt` set and is not a suspension. A deleted account is a conflict, as it is
 * for `suspendUser`: deletion outranks the suspension it keeps, so lifting that suspension would mail "you can
 * sign in again" to somebody every sign-in still refuses. Restore it first.
 */
export async function reinstateUser(
  deps: LifecycleDeps,
  input: { userId: string; actor: LifecycleActor; reason: string | null },
): Promise<LifecycleTransition> {
  const at = (deps.now ?? (() => new Date()))();
  const reason = reasonOf(input.reason);
  const subject = await subjectOf(deps.db, input.userId);
  const standing = accountStanding(subject.columns, at);
  if (standing.state === "deleted") {
    throw new ConflictError({
      message: "This account is deleted.",
      action: "Restore it first. Its suspension stays in place through a restore, and can be lifted after.",
    });
  }
  if (standing.state !== "suspended") return { changed: false };
  const update = deps.db
    .updateTable("pithyAuthUsers")
    .set({ suspendedAt: null, suspendedUntil: null })
    .where("id", "=", input.userId)
    .where("deletedAt", "is", null)
    .where("suspendedAt", "is not", null)
    .where((eb) => eb.or([eb("suspendedUntil", "is", null), eb("suspendedUntil", ">", SQLiteDate.encode(at))]));
  const row: HistoryRow = { userId: input.userId, action: "reinstated", actor: input.actor, reason, at };
  if (!(await move(deps, update, row))) return { changed: false };

  await audit(deps, AuthAuditActions.adminUserReinstated, input.userId, input.actor, { reason });
  await mail(
    deps,
    deps.config.lifecycleEmails.accountReinstated,
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
  return { changed: true };
}

/**
 * Delete an account, softly: it is shut now, and its data is erased once `retention.purgeAfterDays` have
 * passed. Restorable until then. Audited as the account's own deletion when its holder is the actor.
 *
 * A suspension the account was under is left in place, so restoring the account does not lift it.
 */
export async function deleteUser(
  deps: LifecycleDeps,
  input: { userId: string; actor: LifecycleActor; reason: string | null },
): Promise<LifecycleTransition> {
  const at = (deps.now ?? (() => new Date()))();
  const reason = reasonOf(input.reason);
  const purgeAfter = new Date(at.getTime() + deps.config.retention.purgeAfterDays * 86_400_000);
  const subject = await subjectOf(deps.db, input.userId);
  if (subject.columns.deletedAt) return { changed: false };
  const update = deps.db
    .updateTable("pithyAuthUsers")
    .set({ deletedAt: SQLiteDate.encode(at), purgeAfter: SQLiteDate.encode(purgeAfter) })
    .where("id", "=", input.userId)
    .where("deletedAt", "is", null);
  const row: HistoryRow = { userId: input.userId, action: "deleted", actor: input.actor, reason, at };
  if (!(await move(deps, update, row))) return { changed: false };

  const self = input.actor.type === "user" && input.actor.id === input.userId;
  await audit(
    deps,
    self ? AuthAuditActions.userSelfDeleted : AuthAuditActions.adminUserSoftDeleted,
    input.userId,
    input.actor,
    { reason, purgeAfter: purgeAfter.toISOString() },
  );
  await mail(deps, deps.config.lifecycleEmails.deletionScheduled, subject.email, subject.locale, "deletionScheduled", {
    ...named(subject.name),
    purgeOn: readable(purgeAfter, subject.locale),
  });
  await fire(deps, "onUserDeleted", deps.hooks.onUserDeleted, {
    userId: input.userId,
    actor: input.actor,
    reason,
    at,
    purgeAfter,
  });
  return { changed: true };
}

/**
 * Restore a deleted account inside its purge window. After the purge there is no account, and that is a 404
 * whose action says the data is gone.
 */
export async function restoreUser(
  deps: LifecycleDeps,
  input: { userId: string; actor: LifecycleActor; reason: string | null },
): Promise<LifecycleTransition> {
  const at = (deps.now ?? (() => new Date()))();
  const reason = reasonOf(input.reason);
  const subject = await subjectOf(deps.db, input.userId);
  if (!subject.columns.deletedAt) return { changed: false };
  const update = deps.db
    .updateTable("pithyAuthUsers")
    .set({ deletedAt: null, purgeAfter: null })
    .where("id", "=", input.userId)
    .where("deletedAt", "is not", null);
  const row: HistoryRow = { userId: input.userId, action: "restored", actor: input.actor, reason, at };
  if (!(await move(deps, update, row))) return { changed: false };

  await audit(deps, AuthAuditActions.adminUserRestored, input.userId, input.actor, { reason });
  return { changed: true };
}

/** The purge's own actor: a scheduled job, with nobody calling. */
const PURGE: LifecycleActor = { type: "system", id: null };

/** Record that one purge step — one capability's contribution — erased its rows. */
export async function recordPurgeStep(deps: LifecycleDeps, input: { userId: string; step: string }): Promise<void> {
  const at = (deps.now ?? (() => new Date()))();
  await record(deps, { userId: input.userId, action: "purge_step", actor: PURGE, reason: null, at, step: input.step });
}

/**
 * Finish a purge: the last mail, the record, the audit event, the hook.
 *
 * **The address is handed in, not read**, because by the time a purge finishes the user row is gone — the
 * Workflow captures the recipient before its first step and passes it here. Finishing a purge that already
 * finished is a no-op, so a retried Workflow step mails nobody twice.
 */
export async function completePurge(
  deps: LifecycleDeps,
  input: { userId: string; recipient: { email: string; name: string | null; locale: string | null } },
): Promise<LifecycleTransition> {
  const at = (deps.now ?? (() => new Date()))();
  const already = await deps.db
    .selectFrom("pithyAuthUserLifecycle")
    .select("id")
    .where("userId", "=", input.userId)
    .where("action", "=", "purged")
    .executeTakeFirst();
  if (already) return { changed: false };

  await record(deps, { userId: input.userId, action: "purged", actor: PURGE, reason: null, at });
  await audit(deps, AuthAuditActions.adminUserPurged, input.userId, PURGE, {});
  const { email, name, locale } = input.recipient;
  await mail(deps, deps.config.lifecycleEmails.deletionComplete, email, locale, "deletionComplete", {
    ...named(name ?? ""),
    purgedOn: readable(at, locale),
  });
  await fire(deps, "onUserPurged", deps.hooks.onUserPurged, { userId: input.userId, actor: PURGE, reason: null, at });
  return { changed: true };
}
