import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { fromZodError, InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Context, Hono } from "hono";
import type { z } from "zod";
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
import { AroundQuery, TopQuery, WindowQuery } from "./schemas";

/**
 * The leaderboard routes and their declared verification strategies:
 *
 *   GET    /leaderboard                          → list boards       (bearer | session)
 *   POST   /leaderboard/:board                   → submit a score    (bearer | session + submit scope)
 *   GET    /leaderboard/:board/top               → top-N page        (bearer | session)
 *   POST   /leaderboard/:board/segment           → friends/cohort    (bearer | session)
 *   GET    /leaderboard/:board/me                → my rank           (bearer | session)
 *   GET    /leaderboard/:board/around            → around me         (bearer | session)
 *   PUT    /leaderboard/:board/me/visibility     → my consent        (bearer | session)
 *   PUT    /leaderboard/:board/entries/:userId/hidden → hide entry   (bearer | session + admin scope)
 *   DELETE /leaderboard/:board/entries/:userId   → remove entry      (bearer | session + admin scope)
 *
 * Every route is gated by {@link requireAuth} — there is no public leaderboard surface, because an entry
 * with no authenticated player has nothing to key on. Submit additionally requires the board's submit
 * scope while `serverAuthoritative` is on (the default), and the two moderation routes require the admin
 * scope. Turnstile, if the adopter runs it, stacks on top as middleware — it is a humanity check, not an
 * identity, so it never replaces any of the above.
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

  /**
   * Parse the query string, mapping a Zod failure to a `validation/invalid_input` 400. Letting the raw
   * ZodError escape would surface a malformed `?limit=` as a 500 — our fault, not the caller's.
   */
  const query = <S extends z.ZodType>(c: Context<PithyHonoEnv>, schema: S): z.output<S> => {
    const result = schema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!result.success) throw fromZodError(result.error);
    return result.data;
  };

  return (app) => {
    app.get(base, requireAuth(), (c) => respond(c, false, (deps) => listBoards(deps)));

    // Static segments are registered before `:board`-rooted reads so they cannot be shadowed.
    app.post(`${base}/:board/segment`, requireAuth(), async (c) => {
      const body = await c.req.json();
      return respond(c, false, (deps) => readSegment(deps, c.req.param("board"), body));
    });

    app.get(`${base}/:board/top`, requireAuth(), (c) =>
      respond(c, false, (deps) => readTop(deps, c.req.param("board"), query(c, TopQuery))),
    );

    app.get(`${base}/:board/me`, requireAuth(), (c) =>
      respond(c, false, (deps) => readOwnRank(deps, c.req.param("board"), query(c, WindowQuery))),
    );

    app.get(`${base}/:board/around`, requireAuth(), (c) =>
      respond(c, false, (deps) => readAround(deps, c.req.param("board"), query(c, AroundQuery))),
    );

    app.put(`${base}/:board/me/visibility`, requireAuth(), async (c) => {
      const body = await c.req.json();
      return respond(c, true, (deps) => setOwnVisibility(deps, c.req.param("board"), query(c, WindowQuery), body));
    });

    app.put(`${base}/:board/entries/:userId/hidden`, requireAuth(), requireAdminScope(adminScope), async (c) => {
      const body = await c.req.json();
      return respond(c, true, (deps) =>
        hideEntry(deps, c.req.param("board"), c.req.param("userId"), query(c, WindowQuery), body),
      );
    });

    app.delete(`${base}/:board/entries/:userId`, requireAuth(), requireAdminScope(adminScope), (c) =>
      respond(c, true, (deps) => removeEntry(deps, c.req.param("board"), c.req.param("userId"), query(c, WindowQuery))),
    );

    app.post(`${base}/:board`, requireAuth(), requireSubmitScope(serverAuthoritative, submitScope), async (c) => {
      const body = await c.req.json();
      return respond(c, true, (deps) => submitScore(deps, c.req.param("board"), body), 201);
    });
  };
}
