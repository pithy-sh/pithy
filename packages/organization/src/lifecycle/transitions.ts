// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { ConflictError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { type CompiledQuery, sql } from "kysely";
import type { OrganizationLifecycleAction, OrganizationLifecycleActorType } from "../data/organizationLifecycle";
import { ACTING_TABLE, LIFECYCLE_TABLE, ORGANIZATIONS_TABLE, type OrganizationDatabase } from "../data/tables";
import { OrganizationNotFoundError } from "../error/errors";
import type { OrganizationLifecycleHookEvent, OrganizationLifecycleHooks } from "./hooks";
import { OrganizationLifecycleColumns, organizationStanding } from "./state";

/**
 * The organization-lifecycle transitions — the one place an organization's state is ever changed (#623).
 *
 * The control-plane routes and the purge Workflow call these and write nothing themselves, so each transition
 * happens the same way whoever asked for it. The shape is `@pithy-sh/auth`'s user transitions', deliberately:
 *
 * 1. **The columns move, conditionally, and the history row is written with them**, as the two statements of one
 *    `d1.batch()`, which D1 runs as one transaction. The `update` names the state it expects to find, so of two
 *    concurrent suspensions exactly one moves the row, and the insert is guarded by `changes()` so a write that
 *    matched nothing records nothing. A call that finds the organization already where it asked to put it is
 *    `changed: false` and fires nothing.
 * 2. **The hook fires**, swallowed and logged: the transition is already written.
 *
 * The audit event is the route's to write, as every operator act in this package is (`../audit/emit.ts`): it
 * carries the request's correlation, which only the route has. The purge's own, with no request, is the purge's.
 *
 * **What these do not touch is a member.** The cascade that reaches members whose only organization this is
 * runs through `@pithy-sh/auth`'s own user transitions (`./cascade.ts`), and a member of any other organization
 * is never modified by anything here.
 */

/** Who made a transition. */
export interface OrganizationLifecycleActor {
  /** The kind of principal. */
  readonly type: OrganizationLifecycleActorType;
  /** The management client's verified `sub`, or null for the purge. */
  readonly id: string | null;
}

/** Everything a transition needs, resolved by the caller from its own context. */
export interface OrganizationLifecycleDeps {
  /** The tenancy tables. */
  readonly db: OrganizationDatabase;
  /** The same database as a binding, for the batch and for the hooks. */
  readonly d1: D1Database;
  /** The adopter's hooks. */
  readonly hooks: OrganizationLifecycleHooks;
  /** Where a swallowed hook failure is reported. Absent, it is swallowed silently. */
  readonly log?: Logger | undefined;
  /** The clock. Defaults to the system's. */
  readonly now?: (() => Date) | undefined;
}

/** One row of an organization's history. */
interface HistoryRow {
  readonly organizationId: string;
  readonly action: OrganizationLifecycleAction;
  readonly actor: OrganizationLifecycleActor;
  readonly reason: string | null;
  readonly at: Date;
  readonly suspendedUntil?: Date | null;
  readonly step?: string | null;
  /** A deletion's mode, kept for the erasure attestation (#823). */
  readonly mode?: OrganizationDeletionMode | null;
  /** When a deletion's purge comes due, kept for the erasure attestation (#823). */
  readonly purgeAfter?: Date | null;
}

/** The history row's values, as the table stores them. */
function encoded(row: HistoryRow) {
  return {
    organizationId: row.organizationId,
    action: row.action,
    actorType: row.actor.type,
    actorId: row.actor.id,
    reason: row.reason,
    suspendedUntil: row.suspendedUntil ? SQLiteDate.encode(row.suspendedUntil) : null,
    step: row.step ?? null,
    mode: row.mode ?? null,
    purgeAfter: row.purgeAfter ? SQLiteDate.encode(row.purgeAfter) : null,
    createdAt: SQLiteDate.encode(row.at),
  };
}

/** The transition's clock. */
function nowOf(deps: OrganizationLifecycleDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

/** Bind a compiled statement to D1, so it can join a `batch`. */
function prepared(d1: D1Database, compiled: CompiledQuery): D1PreparedStatement {
  return d1.prepare(compiled.sql).bind(...(compiled.parameters as unknown[]));
}

/**
 * Move the columns and write the history row as one transaction, and say whether the organization moved.
 *
 * The insert is guarded by `changes()`, which SQLite answers for the statement just before it — the update — so a
 * conditional update that matched nothing writes no row.
 */
async function move(
  deps: OrganizationLifecycleDeps,
  update: { compile(): CompiledQuery },
  row: HistoryRow,
): Promise<boolean> {
  const v = encoded(row);
  const insert = deps.db
    .insertInto(LIFECYCLE_TABLE)
    .columns([
      "organizationId",
      "action",
      "actorType",
      "actorId",
      "reason",
      "suspendedUntil",
      "step",
      "mode",
      "purgeAfter",
      "createdAt",
    ])
    .expression(
      deps.db
        .selectNoFrom([
          sql.val(v.organizationId).as("organizationId"),
          sql.val(v.action).as("action"),
          sql.val(v.actorType).as("actorType"),
          sql.val(v.actorId).as("actorId"),
          sql.val(v.reason).as("reason"),
          sql.val(v.suspendedUntil).as("suspendedUntil"),
          sql.val(v.step).as("step"),
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

/** Fire one hook. Swallowed and logged: the transition is already written, and a retry would fire nothing. */
async function fire(
  deps: OrganizationLifecycleDeps,
  name: keyof OrganizationLifecycleHooks,
  event: OrganizationLifecycleHookEvent,
): Promise<void> {
  const hook = deps.hooks[name];
  if (!hook) return;
  try {
    await hook(event, deps.d1);
  } catch (error) {
    deps.log?.warn(`${name} threw; the transition stands`, {
      organizationId: event.organizationId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The organization a transition acts on, or the 404 — the one that says its data is gone, when the purge ran. */
async function columnsOf(
  deps: OrganizationLifecycleDeps,
  organizationId: string,
): Promise<OrganizationLifecycleColumns> {
  const row = await deps.db
    .selectFrom(ORGANIZATIONS_TABLE)
    .select(["suspendedAt", "suspendedUntil", "deletedAt", "purgeAfter"])
    .where("id", "=", organizationId)
    .executeTakeFirst();
  if (!row) throw await absent(deps.db, organizationId);
  return OrganizationLifecycleColumns.parse(row);
}

/**
 * The 404 for an organization that is not there: the plain one, or — when the purge erased it — one whose action
 * says the data is gone, read off the history row the purge leaves behind.
 */
export async function absent(db: OrganizationDatabase, organizationId: string): Promise<OrganizationNotFoundError> {
  const purged = await db
    .selectFrom(LIFECYCLE_TABLE)
    .select("createdAt")
    .where("organizationId", "=", organizationId)
    .where("action", "=", "purged")
    .executeTakeFirst();
  if (!purged) {
    return new OrganizationNotFoundError({
      detail: `lifecycle transition for organization ${organizationId}, which has no row`,
    });
  }
  const on = SQLiteDate.parse(purged.createdAt).toISOString();
  return new OrganizationNotFoundError({
    action: `This organization was purged on ${on}. Its data is gone, and there is nothing to restore.`,
    detail: `organization ${organizationId} was purged at ${on}`,
  });
}

/** The conflict for a deleted organization: deletion outranks a suspension, so restore it first. */
function deletedConflict(restoreRoute: string, then: string): ConflictError {
  return new ConflictError({
    message: `This organization is deleted. Restore it with ${restoreRoute} first.`,
    action: `Restore it with ${restoreRoute}. ${then}`,
  });
}

/** The conflict for a write that found the organization moved under it by another request. Retrying is safe. */
function raced(organizationId: string): ConflictError {
  return new ConflictError({
    message: "The organization changed while this request was being made. Send it again.",
    detail: `lifecycle write for organization ${organizationId} matched no row; another request moved it first`,
  });
}

/** What a suspension did, and the suspension it left in force. */
export interface OrganizationSuspendTransition {
  /** Whether the organization moved. False for a restatement. */
  readonly changed: boolean;
  /** True when it was already suspended and this call restated the reason and the end instead. */
  readonly updated: boolean;
  /** When the suspension in force began. A restatement keeps the original start. */
  readonly suspendedAt: Date;
  /** When it ends by itself, or null for one that lasts until a reinstatement. */
  readonly suspendedUntil: Date | null;
}

/** What a suspension would act on: the instant, the end it would take, and where the organization stands. */
export interface SuspensionTerms {
  /** The instant the suspension is judged at. */
  readonly at: Date;
  /** When it would end by itself, or null for one that lasts until a reinstatement. */
  readonly until: Date | null;
  /** The organization's columns, as read. */
  readonly columns: OrganizationLifecycleColumns;
  /** Where it stands at `at`. */
  readonly standing: ReturnType<typeof organizationStanding>;
}

/**
 * Everything a suspension refuses, asked without suspending — an end that is not in the future, an organization
 * that is not there, one that is deleted. {@link suspendOrganization} begins here, and so does the preview of a
 * suspension's cascade (#813), so a preview is refused exactly where the write would be, with the same error.
 * Writes nothing.
 */
export async function checkSuspension(
  deps: OrganizationLifecycleDeps,
  input: { organizationId: string; until?: Date | null; restoreRoute: string },
): Promise<SuspensionTerms> {
  const at = nowOf(deps);
  const until = input.until ?? null;
  if (until && until.getTime() <= at.getTime()) {
    throw new ValidationError({ message: "A suspension must end in the future, or not at all." });
  }
  const columns = await columnsOf(deps, input.organizationId);
  const standing = organizationStanding(columns, at);
  if (standing.state === "deleted") {
    throw deletedConflict(input.restoreRoute, "Then suspend it, if it should be suspended instead.");
  }
  return { at, until, columns, standing };
}

/**
 * Suspend an organization, until `until` or until it is reinstated.
 *
 * A deleted organization cannot be suspended — deletion already shuts it — so that is a conflict naming the
 * restore route. One already suspended has its terms restated: the end is replaced, a `suspended` row records
 * the new reason, the start is kept, and no hook fires. A suspension whose end has passed is not in force, and a
 * new one replaces it.
 */
export async function suspendOrganization(
  deps: OrganizationLifecycleDeps,
  input: {
    organizationId: string;
    actor: OrganizationLifecycleActor;
    reason: string;
    until?: Date | null;
    restoreRoute: string;
  },
): Promise<OrganizationSuspendTransition> {
  const { at, until, columns, standing } = await checkSuspension(deps, input);
  const encodedUntil = until ? SQLiteDate.encode(until) : null;
  const row: HistoryRow = {
    organizationId: input.organizationId,
    action: "suspended",
    actor: input.actor,
    reason: input.reason,
    at,
    suspendedUntil: until,
  };
  if (standing.state === "suspended" && columns.suspendedAt) {
    // The same suspension, still in force: pinned by its start, so a reinstate-then-suspend in between is a
    // different suspension and this write matches nothing.
    const restatement = deps.db
      .updateTable(ORGANIZATIONS_TABLE)
      .set({ suspendedUntil: encodedUntil })
      .where("id", "=", input.organizationId)
      .where("deletedAt", "is", null)
      .where("suspendedAt", "=", SQLiteDate.encode(columns.suspendedAt));
    if (!(await move(deps, restatement, row))) throw raced(input.organizationId);
    return { changed: false, updated: true, suspendedAt: columns.suspendedAt, suspendedUntil: until };
  }
  const fresh = deps.db
    .updateTable(ORGANIZATIONS_TABLE)
    .set({ suspendedAt: SQLiteDate.encode(at), suspendedUntil: encodedUntil })
    .where("id", "=", input.organizationId)
    .where("deletedAt", "is", null)
    .where((eb) =>
      eb.or([
        eb("suspendedAt", "is", null),
        eb.and([eb("suspendedUntil", "is not", null), eb("suspendedUntil", "<=", SQLiteDate.encode(at))]),
      ]),
    );
  if (!(await move(deps, fresh, row))) throw raced(input.organizationId);
  await fire(deps, "onOrganizationSuspended", {
    organizationId: input.organizationId,
    actor: input.actor,
    reason: input.reason,
    at,
    suspendedUntil: until,
  });
  return { changed: true, updated: false, suspendedAt: at, suspendedUntil: until };
}

/**
 * Lift a suspension. An organization that is not suspended — including one whose suspension ran out — is a no-op.
 * A deleted one is a conflict: lifting the suspension it keeps would tell its owners they can act in an
 * organization every door still refuses.
 */
export async function reinstateOrganization(
  deps: OrganizationLifecycleDeps,
  input: { organizationId: string; actor: OrganizationLifecycleActor; reason: string; restoreRoute: string },
): Promise<{ readonly changed: boolean }> {
  const at = nowOf(deps);
  const columns = await columnsOf(deps, input.organizationId);
  const standing = organizationStanding(columns, at);
  if (standing.state === "deleted") {
    throw deletedConflict(
      input.restoreRoute,
      "Its suspension stays in place through a restore, and can be lifted after.",
    );
  }
  if (standing.state !== "suspended") return { changed: false };
  const update = deps.db
    .updateTable(ORGANIZATIONS_TABLE)
    .set({ suspendedAt: null, suspendedUntil: null })
    .where("id", "=", input.organizationId)
    .where("deletedAt", "is", null)
    .where("suspendedAt", "is not", null)
    .where((eb) => eb.or([eb("suspendedUntil", "is", null), eb("suspendedUntil", ">", SQLiteDate.encode(at))]));
  const row: HistoryRow = {
    organizationId: input.organizationId,
    action: "reinstated",
    actor: input.actor,
    reason: input.reason,
    at,
  };
  if (!(await move(deps, update, row))) return { changed: false };
  await fire(deps, "onOrganizationReinstated", {
    organizationId: input.organizationId,
    actor: input.actor,
    reason: input.reason,
    at,
  });
  return { changed: true };
}

/** How a deletion runs: shut now and purged once the window closes, or purged now. */
export type OrganizationDeletionMode = "soft" | "hard";

/** What a deletion did, and the deletion it left in force. */
export interface OrganizationDeleteTransition {
  /**
   * `deleted` when this call deleted it; `brought_forward` when it was already deleted and a hard deletion moved
   * its purge to now; `unchanged` when it was already deleted and this call had nothing to move.
   */
  readonly outcome: "deleted" | "brought_forward" | "unchanged";
  /** When the organization was deleted. A deletion brought forward keeps its original start. */
  readonly deletedAt: Date;
  /** When the purge may erase it — now, for a hard deletion. Restorable until then. */
  readonly purgeAfter: Date;
}

/**
 * Delete an organization.
 *
 * **Soft, the default**: it is shut now — gone from every member's list, and refused to every one of them — and
 * its data is erased once `purgeAfterDays` have passed. Its memberships are kept, so a restore inside the window
 * brings them back. **Hard**: `purgeAfter` is now, so the window is already closed, and the caller starts the
 * purge. An organization already deleted softly has its purge brought forward by a hard deletion; one already
 * due is unchanged.
 *
 * Every session's selection of it is cleared once the columns are written. A suspension it was under is left in
 * place, so restoring it does not lift that.
 */
export async function removeOrganization(
  deps: OrganizationLifecycleDeps,
  input: {
    organizationId: string;
    actor: OrganizationLifecycleActor;
    reason: string;
    mode?: OrganizationDeletionMode;
    purgeAfterDays: number;
  },
): Promise<OrganizationDeleteTransition> {
  const at = nowOf(deps);
  const hard = input.mode === "hard";
  const purgeAfter = hard ? at : new Date(at.getTime() + input.purgeAfterDays * 86_400_000);
  const columns = await columnsOf(deps, input.organizationId);
  // The mode and the due instant ride on the row, because the purge erases the organization's own column and the
  // erasure attestation still has to say both (#823).
  const row: HistoryRow = {
    organizationId: input.organizationId,
    action: "deleted",
    actor: input.actor,
    reason: input.reason,
    at,
    mode: hard ? "hard" : "soft",
    purgeAfter,
  };
  const existing = columns.deletedAt;
  if (existing) {
    const due = columns.purgeAfter ?? existing;
    const unchanged = { outcome: "unchanged", deletedAt: existing, purgeAfter: due } as const;
    if (!hard || due.getTime() <= at.getTime()) return unchanged;
    const forward = deps.db
      .updateTable(ORGANIZATIONS_TABLE)
      .set({ purgeAfter: SQLiteDate.encode(at) })
      .where("id", "=", input.organizationId)
      .where("deletedAt", "=", SQLiteDate.encode(existing))
      .where("purgeAfter", ">", SQLiteDate.encode(at));
    if (!(await move(deps, forward, row))) return unchanged;
    return { outcome: "brought_forward", deletedAt: existing, purgeAfter: at };
  }
  const update = deps.db
    .updateTable(ORGANIZATIONS_TABLE)
    .set({ deletedAt: SQLiteDate.encode(at), purgeAfter: SQLiteDate.encode(purgeAfter) })
    .where("id", "=", input.organizationId)
    .where("deletedAt", "is", null);
  if (!(await move(deps, update, row))) {
    const now = await columnsOf(deps, input.organizationId);
    if (!now.deletedAt) throw raced(input.organizationId);
    return { outcome: "unchanged", deletedAt: now.deletedAt, purgeAfter: now.purgeAfter ?? now.deletedAt };
  }
  // No session acts in it from here. A selection would grant nothing anyway — every read refuses a deleted
  // organization — but a row that points at nothing is one a restore would quietly bring back to life.
  await deps.db.deleteFrom(ACTING_TABLE).where("organizationId", "=", input.organizationId).execute();
  await fire(deps, "onOrganizationDeleted", {
    organizationId: input.organizationId,
    actor: input.actor,
    reason: input.reason,
    at,
    purgeAfter,
  });
  return { outcome: "deleted", deletedAt: at, purgeAfter };
}

/** The conflict for an organization whose purge window has closed: nothing can restore it now. */
function windowClosed(organizationId: string, closes: Date): ConflictError {
  return new ConflictError({
    message: `This organization's purge window closed on ${closes.toISOString()}. It can no longer be restored.`,
    action: "The purge is due and erases its data once it runs. There is nothing to restore.",
    detail: `restore for organization ${organizationId}, whose purge was due at ${closes.toISOString()}`,
  });
}

/**
 * Restore a deleted organization inside its purge window, with every membership it had.
 *
 * Once `purgeAfter` has passed the purge is due and may already be erasing capabilities' rows, so that is a
 * conflict naming the date. After the purge there is no organization at all, and that is a 404 whose action says
 * the data is gone. One that is not deleted is no transition. A suspension it was under is still in force after,
 * and so is any member's own account suspension — a restore lifts neither.
 */
export async function restoreOrganization(
  deps: OrganizationLifecycleDeps,
  input: { organizationId: string; actor: OrganizationLifecycleActor; reason: string },
): Promise<{ readonly changed: boolean; readonly state: "active" | "suspended" }> {
  const at = nowOf(deps);
  const columns = await columnsOf(deps, input.organizationId);
  const state =
    organizationStanding({ ...columns, deletedAt: null, purgeAfter: null }, at).state === "suspended"
      ? "suspended"
      : "active";
  if (!columns.deletedAt) return { changed: false, state };
  const closes = columns.purgeAfter;
  if (closes && closes.getTime() <= at.getTime()) throw windowClosed(input.organizationId, closes);
  const update = deps.db
    .updateTable(ORGANIZATIONS_TABLE)
    .set({ deletedAt: null, purgeAfter: null })
    .where("id", "=", input.organizationId)
    .where("deletedAt", "is not", null)
    .where("purgeAfter", ">", windowClock(deps));
  const row: HistoryRow = {
    organizationId: input.organizationId,
    action: "restored",
    actor: input.actor,
    reason: input.reason,
    at,
  };
  if (!(await move(deps, update, row))) {
    const now = await columnsOf(deps, input.organizationId);
    if (!now.deletedAt) return { changed: false, state };
    const closed = now.purgeAfter;
    if (closed && closed.getTime() <= nowOf(deps).getTime()) throw windowClosed(input.organizationId, closed);
    throw raced(input.organizationId);
  }
  return { changed: true, state };
}

/**
 * The instant a purge-window guard compares against, read when the statement runs — the database's own clock on
 * the system's, so a restore and a purge's `due` check agree whichever lands first (auth's `windowClock`, #622).
 */
function windowClock(deps: OrganizationLifecycleDeps) {
  return deps.now
    ? sql<number>`${deps.now().getTime()}`
    : sql<number>`cast(round(unixepoch('subsec') * 1000) as integer)`;
}

/** The purge's own actor: a scheduled job, with nobody calling. */
const PURGE: OrganizationLifecycleActor = { type: "system", id: null };

/**
 * Whether one organization is due for its purge: deleted, with its window closed. `gone` when there is no row —
 * the purge already erased it, or the id never existed. The cron and a hard deletion both start a purge, and this
 * is the one check either passes through, so an organization restored in between erases nothing.
 */
export async function organizationPurgeSubject(
  deps: OrganizationLifecycleDeps,
  organizationId: string,
): Promise<"due" | "not_due" | "gone"> {
  const row = await deps.db
    .selectFrom(ORGANIZATIONS_TABLE)
    .select(["suspendedAt", "suspendedUntil", "deletedAt", "purgeAfter"])
    .select(windowClock(deps).as("checkedAt"))
    .where("id", "=", organizationId)
    .executeTakeFirst();
  if (!row) return "gone";
  const columns = OrganizationLifecycleColumns.parse(row);
  if (!columns.deletedAt || !columns.purgeAfter || columns.purgeAfter.getTime() > Number(row.checkedAt)) {
    return "not_due";
  }
  return "due";
}

/** One organization whose purge is due: which, and the deletion it is due under — ms-epoch, for a journal. */
export interface DueOrganizationPurge {
  readonly organizationId: string;
  readonly deletedAt: number;
}

/** The organizations whose purge is due, oldest first, at most `limit`. What the daily pass starts a purge for. */
export async function dueOrganizationPurges(
  deps: OrganizationLifecycleDeps,
  limit: number,
): Promise<DueOrganizationPurge[]> {
  const at = nowOf(deps);
  const rows = await deps.db
    .selectFrom(ORGANIZATIONS_TABLE)
    .select(["id", "deletedAt"])
    .where("deletedAt", "is not", null)
    .where("purgeAfter", "is not", null)
    .where("purgeAfter", "<=", SQLiteDate.encode(at))
    .orderBy("purgeAfter", "asc")
    .orderBy("id", "asc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({ organizationId: row.id, deletedAt: Number(row.deletedAt) }));
}

/**
 * Record that one purge step — one capability's contribution — erased its rows, with what it said it erases. With
 * `retained`, the step kept its rows instead (#814): the row is `purge_retained`, its reason the basis given.
 */
export async function recordOrganizationPurgeStep(
  deps: OrganizationLifecycleDeps,
  input: { organizationId: string; step: string; summary: string; retained?: boolean },
): Promise<void> {
  await deps.db
    .insertInto(LIFECYCLE_TABLE)
    .values(
      encoded({
        organizationId: input.organizationId,
        action: input.retained ? "purge_retained" : "purge_step",
        actor: PURGE,
        reason: input.summary.trim() || null,
        at: nowOf(deps),
        step: input.step,
      }),
    )
    .execute();
}

/**
 * Record that a purge gave up at `step` (#823), until the next daily pass starts it again. The failure's message is
 * never written: it is code the kit did not write. The trail's event is the caller's, as every purge event here is.
 */
export async function recordOrganizationPurgeFailure(
  deps: OrganizationLifecycleDeps,
  input: { organizationId: string; step: string },
): Promise<void> {
  await deps.db
    .insertInto(LIFECYCLE_TABLE)
    .values(
      encoded({
        organizationId: input.organizationId,
        action: "purge_failed",
        actor: PURGE,
        reason: null,
        at: nowOf(deps),
        step: input.step,
      }),
    )
    .execute();
}

/**
 * Finish a purge: the `purged` record and the hook, once. **The insert is the check**: `0003` allows one `purged`
 * row per organization, the insert ignores a second, and only the call whose row landed fires — so two purges that
 * overlapped, or a retried step, finish once.
 */
export async function completeOrganizationPurge(
  deps: OrganizationLifecycleDeps,
  input: { organizationId: string },
): Promise<{ readonly changed: boolean }> {
  const at = nowOf(deps);
  const inserted = await deps.db
    .insertInto(LIFECYCLE_TABLE)
    .values(encoded({ organizationId: input.organizationId, action: "purged", actor: PURGE, reason: null, at }))
    .onConflict((conflict) => conflict.doNothing())
    .executeTakeFirst();
  if (Number(inserted.numInsertedOrUpdatedRows ?? 0n) === 0) return { changed: false };
  await fire(deps, "onOrganizationPurged", { organizationId: input.organizationId, actor: PURGE, reason: null, at });
  return { changed: true };
}
