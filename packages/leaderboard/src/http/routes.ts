// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import type { LeaderboardConfig } from "../config/config";
import { BOOKMARK_HEADER, leaderboardSession, readBookmark } from "../session/bookmark";
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
import {
  AroundQuery,
  BoardParam,
  EntryParam,
  HideBody,
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
    return { config, db: session.db, userId: auth.userId, now: () => new Date(), bookmark: session.bookmark };
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

  return (app) => {
    app.get(base, requireAuth(), (c) => respond(c, false, (deps) => listBoards(deps)));

    // Static segments are registered before `:board`-rooted reads so they cannot be shadowed.
    app.post(
      `${base}/:board/segment`,
      requireAuth(),
      zValidator("param", BoardParam, validationHook),
      zValidator("json", SegmentBody, validationHook),
      (c) => respond(c, false, (deps) => readSegment(deps, c.req.valid("param").board, c.req.valid("json"))),
    );

    app.get(
      `${base}/:board/top`,
      requireAuth(),
      zValidator("param", BoardParam, validationHook),
      zValidator("query", TopQuery, validationHook),
      (c) => respond(c, false, (deps) => readTop(deps, c.req.valid("param").board, c.req.valid("query"))),
    );

    app.get(
      `${base}/:board/me`,
      requireAuth(),
      zValidator("param", BoardParam, validationHook),
      zValidator("query", WindowQuery, validationHook),
      (c) => respond(c, false, (deps) => readOwnRank(deps, c.req.valid("param").board, c.req.valid("query"))),
    );

    app.get(
      `${base}/:board/around`,
      requireAuth(),
      zValidator("param", BoardParam, validationHook),
      zValidator("query", AroundQuery, validationHook),
      (c) => respond(c, false, (deps) => readAround(deps, c.req.valid("param").board, c.req.valid("query"))),
    );

    app.put(
      `${base}/:board/me/visibility`,
      requireAuth(),
      zValidator("param", BoardParam, validationHook),
      zValidator("query", WindowQuery, validationHook),
      zValidator("json", VisibilityBody, validationHook),
      (c) =>
        respond(c, true, (deps) =>
          setOwnVisibility(deps, c.req.valid("param").board, c.req.valid("query"), c.req.valid("json")),
        ),
    );

    app.put(
      `${base}/:board/entries/:userId/hidden`,
      requireAuth(),
      requireAdminScope(adminScope),
      zValidator("param", EntryParam, validationHook),
      zValidator("query", WindowQuery, validationHook),
      zValidator("json", HideBody, validationHook),
      (c) => {
        const { board, userId } = c.req.valid("param");
        return respond(c, true, (deps) => hideEntry(deps, board, userId, c.req.valid("query"), c.req.valid("json")));
      },
    );

    app.delete(
      `${base}/:board/entries/:userId`,
      requireAuth(),
      requireAdminScope(adminScope),
      zValidator("param", EntryParam, validationHook),
      zValidator("query", WindowQuery, validationHook),
      (c) => {
        const { board, userId } = c.req.valid("param");
        return respond(c, true, (deps) => removeEntry(deps, board, userId, c.req.valid("query")));
      },
    );

    app.post(
      `${base}/:board`,
      requireAuth(),
      requireSubmitScope(serverAuthoritative, submitScope),
      zValidator("param", BoardParam, validationHook),
      zValidator("json", SubmitScoreBody, validationHook),
      (c) => respond(c, true, (deps) => submitScore(deps, c.req.valid("param").board, c.req.valid("json")), 201),
    );
  };
}
