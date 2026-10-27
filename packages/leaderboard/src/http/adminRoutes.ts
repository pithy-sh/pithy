// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import { clearLock, type EntryActOutcome, moderateEntry } from "../admin/moderate";
import { listEntries, listLocks } from "../admin/read";
import { type LeaderboardAuditAction, LeaderboardAuditActions } from "../audit/actions";
import { type LeaderboardBoard, type LeaderboardConfig, materializeSchedule } from "../config/config";
import { leaderboardDatabase } from "../data/tables";
import { LeaderboardBoardNotFoundError } from "../error/errors";
import { windowKeyAt } from "../window/schedule";
import {
  AdminBoardList,
  AdminEntriesPage,
  AdminLockClearResult,
  AdminLockList,
  AdminModerationResult,
} from "./responses";
import {
  AdminBoardParam,
  AdminEntriesQuery,
  AdminEntryParam,
  ClearLockBody,
  CorrectEntryBody,
  EntryActBody,
  LockParam,
} from "./schemas";
import { LEADERBOARD_ENTRIES_MODERATE_SCOPE, LEADERBOARD_ENTRIES_READ_SCOPE } from "./scopes";
import { adminBoardView, adminEntryState, adminEntryView, adminLockView } from "./views";

/**
 * The leaderboard's management surface (#817), behind the control plane:
 *
 *   GET  {base}/admin/boards                                   → every board            (leaderboard:entries:read)
 *   GET  {base}/admin/boards/:board/entries                    → a window, paged         (leaderboard:entries:read)
 *                                                                param AdminBoardParam, query AdminEntriesQuery
 *   GET  {base}/admin/locks                                    → the refresh lock        (leaderboard:entries:read)
 *   POST {base}/admin/boards/:board/entries/:userId/hide       → hide an entry           (leaderboard:entries:moderate)
 *   POST {base}/admin/boards/:board/entries/:userId/unhide     → unhide an entry         (leaderboard:entries:moderate)
 *                                                                param AdminEntryParam, json EntryActBody
 *   POST {base}/admin/boards/:board/entries/:userId/correct    → correct a score         (leaderboard:entries:moderate)
 *                                                                param AdminEntryParam, json CorrectEntryBody
 *   POST {base}/admin/locks/:name/clear                        → clear a stale lock      (leaderboard:entries:moderate)
 *                                                                param LockParam, json ClearLockBody
 *
 * **`requireControlPlane` replaces `requireAuth`, never stacks with it.** A management client holds no
 * session, and the seam leaves `c.var.auth` null so a control-plane credential can satisfy no player gate;
 * stacking the two would deny every management call permanently. The guard goes first and the validators
 * after it, so an unverified caller learns nothing about which requests were well-formed.
 *
 * Every act emits one audit event when it changed something, with the connection, the board, the entry,
 * the act, before and after, and the reason. A replay and a no-op emit nothing.
 */

export interface LeaderboardAdminRoutesOptions {
  config: LeaderboardConfig;
  basePath: string;
  /** Test seam: the clock. */
  now?: () => Date;
}

/** The `DB` binding. Read on the primary: a moderator acts on what is there, not on a replica's lag. */
function database(c: Context<PithyHonoEnv>): D1Database {
  const d1 = (c.env as Record<string, unknown>).DB as D1Database | undefined;
  if (!d1) {
    throw new InternalError({
      message: "The leaderboard is not configured.",
      action: "Bind a D1 database named DB in wrangler.jsonc.",
      detail: "The leaderboard capability requires a `DB` D1 binding; none was present on env.",
    });
  }
  return d1;
}

/**
 * The verified management client. `requireControlPlane()` has run on every route that calls this, so the
 * throw is a wiring guard, not a runtime path.
 */
function caller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const context = c.var.controlPlane;
  if (!context) {
    throw new InternalError({
      message: "The leaderboard could not identify the management caller.",
      detail: "requireControlPlane() must run before a leaderboard management handler reads the caller.",
    });
  }
  return context;
}

/** The configured board, or the capability's own 404. A param schema shapes the key; it never looks it up. */
function board(config: LeaderboardConfig, key: string): LeaderboardBoard {
  const found = config.boards.find((b) => b.key === key);
  if (!found) throw new LeaderboardBoardNotFoundError({ detail: `No board configured with key "${key}".` });
  return found;
}

const ENTRY_ACTIONS: Record<"hide" | "unhide" | "correct", LeaderboardAuditAction> = {
  hide: LeaderboardAuditActions.entryHidden,
  unhide: LeaderboardAuditActions.entryUnhidden,
  correct: LeaderboardAuditActions.entryCorrected,
};

export function registerLeaderboardAdminRoutes(
  options: LeaderboardAdminRoutesOptions,
): (app: Hono<PithyHonoEnv>) => void {
  const { config, basePath: base } = options;
  const clock = options.now ?? (() => new Date());
  const materialized = materializeSchedule(config) !== undefined;
  // Every window an act changes on a materialized board is marked for the next pass, closed ones included.
  const ranks = materialized ? "next-refresh" : "live";

  /** Run one entry act and answer it, emitting the one audit event when the act changed the entry. */
  async function entryAct(
    c: Context<PithyHonoEnv>,
    act: "hide" | "unhide" | "correct",
    param: AdminEntryParam,
    body: EntryActBody & { score?: number },
  ) {
    const b = board(config, param.board);
    const now = clock();
    const who = caller(c);
    const outcome: EntryActOutcome = await moderateEntry(database(c), {
      act,
      board: b,
      // Left unresolved when the body names none: a replay answers the window its first request acted on.
      windowKey: body.window,
      userId: param.userId,
      materialized,
      ...(body.score === undefined ? {} : { score: body.score }),
      idempotencyKey: body.idempotencyKey,
      reason: body.reason,
      actor: { connectionId: who.connectionId, actorId: who.subject },
      now,
    });
    const window = outcome.windowKey;
    if (outcome.changed && !outcome.replayed) {
      await c.var.emit({
        action: ENTRY_ACTIONS[act],
        outcome: "success",
        // A moderator changing what every player sees is notable, as a comp is.
        severity: "warning",
        actorType: "control-plane",
        actorId: who.subject,
        resourceType: "leaderboard_entry",
        resourceId: `${b.key}:${window}:${param.userId}`,
        requestId: c.req.header("cf-ray"),
        metadata: {
          connectionId: who.connectionId,
          board: b.key,
          window,
          userId: param.userId,
          act,
          before: adminEntryState(outcome.before),
          after: adminEntryState(outcome.after),
          reason: outcome.reason,
        },
      });
    }
    return c.json(
      {
        act,
        board: b.key,
        window,
        userId: param.userId,
        before: adminEntryState(outcome.before),
        after: adminEntryState(outcome.after),
        reason: outcome.reason,
        changed: outcome.changed,
        replayed: outcome.replayed,
        ranks,
      } satisfies AdminModerationResult,
      200,
    );
  }

  return (app) => {
    app.get(
      `${base}/admin/boards`,
      describeRoute({
        summary: "List every configured board, with the window open now.",
        verification: "control-plane",
        scopes: [LEADERBOARD_ENTRIES_READ_SCOPE],
        responses: { 200: AdminBoardList },
      }),
      requireControlPlane(LEADERBOARD_ENTRIES_READ_SCOPE),
      (c) => {
        const now = clock();
        return c.json(
          { boards: config.boards.map((b) => adminBoardView(config, b, now)) } satisfies AdminBoardList,
          200,
        );
      },
    );

    app.get(
      `${base}/admin/boards/:board/entries`,
      describeRoute({
        summary: "Read a window of a board, ranked and paged, hidden entries included.",
        verification: "control-plane",
        scopes: [LEADERBOARD_ENTRIES_READ_SCOPE],
        responses: { 200: AdminEntriesPage },
      }),
      requireControlPlane(LEADERBOARD_ENTRIES_READ_SCOPE),
      validate("param", AdminBoardParam),
      validate("query", AdminEntriesQuery),
      async (c) => {
        const b = board(config, c.req.valid("param").board);
        const query = c.req.valid("query");
        const window = query.window ?? windowKeyAt(b.window, clock());
        const page = await listEntries(leaderboardDatabase(database(c)), b, window, {
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.userId === undefined ? {} : { userId: query.userId }),
          ...(query.hidden === undefined ? {} : { hidden: query.hidden === "true" }),
        });
        return c.json(
          {
            board: b.key,
            window,
            entries: page.items.map(adminEntryView),
            nextCursor: page.nextCursor,
          } satisfies AdminEntriesPage,
          200,
        );
      },
    );

    app.get(
      `${base}/admin/locks`,
      describeRoute({
        summary: "Read the rank-refresh lock, when one is held.",
        verification: "control-plane",
        scopes: [LEADERBOARD_ENTRIES_READ_SCOPE],
        responses: { 200: AdminLockList },
      }),
      requireControlPlane(LEADERBOARD_ENTRIES_READ_SCOPE),
      async (c) => {
        const locks = await listLocks(leaderboardDatabase(database(c)));
        return c.json({ locks: locks.map(adminLockView) } satisfies AdminLockList, 200);
      },
    );

    app.post(
      `${base}/admin/boards/:board/entries/:userId/hide`,
      describeRoute({
        summary: "Hide an entry from every read, with a reason.",
        verification: "control-plane",
        scopes: [LEADERBOARD_ENTRIES_MODERATE_SCOPE],
        responses: { 200: AdminModerationResult },
      }),
      requireControlPlane(LEADERBOARD_ENTRIES_MODERATE_SCOPE),
      validate("param", AdminEntryParam),
      validate("json", EntryActBody),
      (c) => entryAct(c, "hide", c.req.valid("param"), c.req.valid("json")),
    );

    app.post(
      `${base}/admin/boards/:board/entries/:userId/unhide`,
      describeRoute({
        summary: "Put a hidden entry back on the board, with a reason.",
        verification: "control-plane",
        scopes: [LEADERBOARD_ENTRIES_MODERATE_SCOPE],
        responses: { 200: AdminModerationResult },
      }),
      requireControlPlane(LEADERBOARD_ENTRIES_MODERATE_SCOPE),
      validate("param", AdminEntryParam),
      validate("json", EntryActBody),
      (c) => entryAct(c, "unhide", c.req.valid("param"), c.req.valid("json")),
    );

    app.post(
      `${base}/admin/boards/:board/entries/:userId/correct`,
      describeRoute({
        summary: "Correct an entry's score, with a reason. The original is kept.",
        verification: "control-plane",
        scopes: [LEADERBOARD_ENTRIES_MODERATE_SCOPE],
        responses: { 200: AdminModerationResult },
      }),
      requireControlPlane(LEADERBOARD_ENTRIES_MODERATE_SCOPE),
      validate("param", AdminEntryParam),
      validate("json", CorrectEntryBody),
      (c) => entryAct(c, "correct", c.req.valid("param"), c.req.valid("json")),
    );

    app.post(
      `${base}/admin/locks/:name/clear`,
      describeRoute({
        summary: "Clear a stale rank-refresh lock, naming the holder it was taken by.",
        verification: "control-plane",
        scopes: [LEADERBOARD_ENTRIES_MODERATE_SCOPE],
        responses: { 200: AdminLockClearResult },
      }),
      requireControlPlane(LEADERBOARD_ENTRIES_MODERATE_SCOPE),
      validate("param", LockParam),
      validate("json", ClearLockBody),
      async (c) => {
        const { name } = c.req.valid("param");
        const body = c.req.valid("json");
        const who = caller(c);
        const outcome = await clearLock(database(c), {
          name,
          holder: body.holder,
          idempotencyKey: body.idempotencyKey,
          reason: body.reason,
          actor: { connectionId: who.connectionId, actorId: who.subject },
          now: clock(),
        });
        const lock = adminLockView(outcome.lock);
        if (!outcome.replayed) {
          await c.var.emit({
            action: LeaderboardAuditActions.lockCleared,
            outcome: "success",
            severity: "warning",
            actorType: "control-plane",
            actorId: who.subject,
            resourceType: "leaderboard_lock",
            resourceId: name,
            requestId: c.req.header("cf-ray"),
            metadata: {
              connectionId: who.connectionId,
              act: "clear_lock",
              lock: name,
              before: lock,
              after: null,
              reason: outcome.reason,
            },
          });
        }
        return c.json({ lock, reason: outcome.reason, replayed: outcome.replayed } satisfies AdminLockClearResult, 200);
      },
    );
  };
}
