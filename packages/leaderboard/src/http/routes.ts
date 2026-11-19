// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import type { LeaderboardConfig } from "../config/config";
import { BOOKMARK_HEADER, leaderboardSession, readBookmark } from "../session/bookmark";
import { registerLeaderboardAdminRoutes } from "./adminRoutes";
import { requireAdminScope, requireAuth, requireSubmitScope } from "./guard";
import {
  type HandlerDeps,
  hideEntry,
  listBoards,
  readAround,
  readOwnRank,
  readSegment,
  readTop,
  removeEntry,
  setOwnVisibility,
  submitScore,
} from "./handlers";
import { BoardList, BoardPage, HideResult, OwnRank, RemoveResult, SubmitResult, VisibilityResult } from "./responses";
import {
  AroundQuery,
  BoardParam,
  boardKeyOf,
  EntryParam,
  HideBody,
  InstanceEntryParam,
  InstanceParam,
  SegmentBody,
  SubmitScoreBody,
  TopQuery,
  VisibilityBody,
  WindowQuery,
} from "./schemas";

/**
 * The leaderboard routes, each declaring both how a caller is verified and what it may send:
 *
 *   GET    /leaderboard                          → list boards    (bearer | session) — takes nothing
 *   POST   /leaderboard/:board                   → submit a score (bearer | session + submit scope)
 *                                                  param BoardParam, json SubmitScoreBody
 *   GET    /leaderboard/:board/top               → top-N page     (bearer | session)
 *                                                  param BoardParam, query TopQuery
 *   POST   /leaderboard/:board/segment           → friends/cohort (bearer | session)
 *                                                  param BoardParam, json SegmentBody
 *   GET    /leaderboard/:board/me                → my rank        (bearer | session)
 *                                                  param BoardParam, query WindowQuery
 *   GET    /leaderboard/:board/around            → around me      (bearer | session)
 *                                                  param BoardParam, query AroundQuery
 *   PUT    /leaderboard/:board/me/visibility     → my consent     (bearer | session)
 *                                                  param BoardParam, query WindowQuery, json VisibilityBody
 *   PUT    /leaderboard/:board/entries/:userId/hidden → hide entry (bearer | session + admin scope)
 *                                                  param EntryParam, query WindowQuery, json HideBody
 *   DELETE /leaderboard/:board/entries/:userId   → remove entry   (bearer | session + admin scope)
 *                                                  param EntryParam, query WindowQuery
 *
 * Every `:board` route is registered again at `/leaderboard/:board/:instance` for an instance of a board
 * family (`POST /leaderboard/level/abc`), taking `InstanceParam` or `InstanceEntryParam` for its params
 * and answering through the same handler. Submit is registered last of all, so `POST :board/:instance`
 * never takes a `POST :board/segment`.
 *
 * Every route is gated by {@link requireAuth} — there is no public leaderboard surface, because an entry
 * with no authenticated player has nothing to key on. Submit additionally requires the board's submit
 * scope while `serverAuthoritative` is on (the default), and the two moderation routes require the admin
 * scope. Turnstile, if the adopter runs it, stacks on top as middleware — it is a humanity check, not an
 * identity, so it never replaces any of the above.
 *
 * Validators sit **after** the guards, never before: who you are is decided before what you sent, so an
 * unauthorised request with a malformed body is still a 401. They sit **before** the handler, which is
 * what moves a malformed request ahead of the board lookup — an unknown board sent a bad body now answers
 * 400 rather than 404. The request was never well-formed enough to have a board.
 */
export interface LeaderboardRoutesOptions {
  config: LeaderboardConfig;
  basePath?: string;
  /** Test seam: the management surface's clock. */
  now?: () => Date;
  /** Test seam: resolve handler deps from the request context. Defaults to the env-based resolver. */
  resolveDeps?: (c: Context<PithyHonoEnv>, write: boolean) => HandlerDeps & { bookmark(): string | null };
}

function defaultResolveDeps(config: LeaderboardConfig) {
  return (c: Context<PithyHonoEnv>, write: boolean): HandlerDeps & { bookmark(): string | null } => {
    const d1 = (c.env as Record<string, unknown>).DB as D1Database | undefined;
    if (!d1) {
      throw new InternalError({
        message: "The leaderboard is not configured.",
        action: "Bind a D1 database named DB in wrangler.jsonc.",
        detail: "The leaderboard capability requires a `DB` D1 binding; none was present on env.",
      });
    }
    // A write anchors at the primary and hands back a bookmark; a read follows the client's bookmark
    // when it sent one. That round trip is what makes a player see their own submission.
    const session = leaderboardSession(
      d1,
      readBookmark(c.req.raw.headers),
      write ? "first-primary" : "first-unconstrained",
    );
    const auth = c.var.auth;
    if (!auth) {
      throw new InternalError({ detail: "requireAuth() must run before a leaderboard handler resolves deps." });
    }
    return {
      config,
      db: session.db,
      d1: session.d1,
      userId: auth.userId,
      now: () => new Date(),
      context: c,
      bookmark: session.bookmark,
    };
  };
}

export function registerLeaderboardRoutes(options: LeaderboardRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? "/leaderboard";
  const resolve = options.resolveDeps ?? defaultResolveDeps(options.config);
  const { serverAuthoritative, submitScope, adminScope } = options.config;

  /** Run a handler and return its JSON, attaching the session's bookmark for the client to echo back. */
  const respond = async <T>(
    c: Context<PithyHonoEnv>,
    write: boolean,
    run: (deps: HandlerDeps) => Promise<T> | T,
    status: 200 | 201 = 200,
  ) => {
    const deps = resolve(c, write);
    const body = await run(deps);
    const bookmark = deps.bookmark();
    if (bookmark) c.header(BOOKMARK_HEADER, bookmark);
    return c.json(body as object, status);
  };

  const admin = registerLeaderboardAdminRoutes({
    config: options.config,
    basePath: base,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return (app) => {
    // The management surface, behind the control plane. Every path sits under a static `admin/`
    // segment, so it is disjoint from the player routes by construction and its order here is presentation.
    admin(app);

    app.get(
      base,
      describeRoute({
        summary: "List the configured boards.",
        operation: "boards.list",
        tool: true,
        verification: ["bearer", "session"],
        responses: { 200: BoardList },
      }),
      requireAuth(),
      (c) => respond(c, false, (deps) => listBoards(deps)),
    );

    // Every board-addressed route twice: at `:board` for a configured board, and at `:board/:instance` for
    // an instance of a family. One handler serves both, keyed by the board key the params spell.
    const roots = [
      { path: `${base}/:board`, board: BoardParam, entry: EntryParam, operation: "" },
      { path: `${base}/:board/:instance`, board: InstanceParam, entry: InstanceEntryParam, operation: "instances." },
    ] as const;

    for (const root of roots) {
      // Static segments are registered before `:board`-rooted reads so they cannot be shadowed.
      app.post(
        `${root.path}/segment`,
        describeRoute({
          summary: "Rank a segment of players, such as a friends list.",
          verification: ["bearer", "session"],
          responses: { 200: BoardPage },
        }),
        requireAuth(),
        validate("param", root.board),
        validate("json", SegmentBody),
        (c) => respond(c, false, (deps) => readSegment(deps, boardKeyOf(c.req.valid("param")), c.req.valid("json"))),
      );

      app.get(
        `${root.path}/top`,
        describeRoute({
          summary: "Read the top of a board.",
          operation: `${root.operation}top.read`,
          tool: true,
          verification: ["bearer", "session"],
          responses: { 200: BoardPage },
        }),
        requireAuth(),
        validate("param", root.board),
        validate("query", TopQuery),
        (c) => respond(c, false, (deps) => readTop(deps, boardKeyOf(c.req.valid("param")), c.req.valid("query"))),
      );

      app.get(
        `${root.path}/me`,
        describeRoute({
          summary: "Read the caller's own rank.",
          operation: `${root.operation}rank.read`,
          tool: true,
          verification: ["bearer", "session"],
          responses: { 200: OwnRank },
        }),
        requireAuth(),
        validate("param", root.board),
        validate("query", WindowQuery),
        (c) => respond(c, false, (deps) => readOwnRank(deps, boardKeyOf(c.req.valid("param")), c.req.valid("query"))),
      );

      app.get(
        `${root.path}/around`,
        describeRoute({
          summary: "Read the players ranked around the caller.",
          verification: ["bearer", "session"],
          responses: { 200: BoardPage },
        }),
        requireAuth(),
        validate("param", root.board),
        validate("query", AroundQuery),
        (c) => respond(c, false, (deps) => readAround(deps, boardKeyOf(c.req.valid("param")), c.req.valid("query"))),
      );

      app.put(
        `${root.path}/me/visibility`,
        describeRoute({
          summary: "Show or hide the caller's own entry.",
          verification: ["bearer", "session"],
          responses: { 200: VisibilityResult },
        }),
        requireAuth(),
        validate("param", root.board),
        validate("query", WindowQuery),
        validate("json", VisibilityBody),
        (c) =>
          respond(c, true, (deps) =>
            setOwnVisibility(deps, boardKeyOf(c.req.valid("param")), c.req.valid("query"), c.req.valid("json")),
          ),
      );

      app.put(
        `${root.path}/entries/:userId/hidden`,
        describeRoute({
          summary: "Hide or restore another player's entry.",
          verification: ["bearer", "session"],
          scopes: [adminScope],
          responses: { 200: HideResult },
        }),
        requireAuth(),
        requireAdminScope(adminScope),
        validate("param", root.entry),
        validate("query", WindowQuery),
        validate("json", HideBody),
        (c) => {
          const param = c.req.valid("param");
          return respond(c, true, (deps) =>
            hideEntry(deps, boardKeyOf(param), param.userId, c.req.valid("query"), c.req.valid("json")),
          );
        },
      );

      app.delete(
        `${root.path}/entries/:userId`,
        describeRoute({
          summary: "Remove another player's entry.",
          verification: ["bearer", "session"],
          scopes: [adminScope],
          responses: { 200: RemoveResult },
        }),
        requireAuth(),
        requireAdminScope(adminScope),
        validate("param", root.entry),
        validate("query", WindowQuery),
        (c) => {
          const param = c.req.valid("param");
          return respond(c, true, (deps) => removeEntry(deps, boardKeyOf(param), param.userId, c.req.valid("query")));
        },
      );
    }

    // Submit last: `POST :board/:instance` would otherwise take `POST :board/segment`.
    for (const root of roots) {
      app.post(
        root.path,
        describeRoute({
          summary: "Submit a score.",
          description: "Requires the submit scope while `serverAuthoritative` is on, which is the default.",
          verification: ["bearer", "session"],
          scopes: serverAuthoritative ? [submitScope] : [],
          responses: { 201: SubmitResult },
        }),
        requireAuth(),
        requireSubmitScope(serverAuthoritative, submitScope),
        validate("param", root.board),
        validate("json", SubmitScoreBody),
        (c) =>
          respond(c, true, (deps) => submitScore(deps, boardKeyOf(c.req.valid("param")), c.req.valid("json")), 201),
      );
    }
  };
}
