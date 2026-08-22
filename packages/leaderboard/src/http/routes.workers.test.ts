// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { Hono } from "hono";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { LeaderboardConfig, type LeaderboardConfigInput } from "../config/config";
import { leaderboard_0001_entries } from "../migrations/0001_entries";
import { BOOKMARK_HEADER } from "../session/bookmark";
import { registerLeaderboardRoutes } from "./routes";

const SUBMIT = "leaderboard:submit";
const ADMIN = "leaderboard:admin";

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "leaderboard",
      order: LEADERBOARD_MIGRATION_ORDER,
      migrations: { "0001_entries": leaderboard_0001_entries },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

/**
 * A Hono app with the leaderboard routes and a stand-in for `@pithy-sh/auth`: `x-user` sets the player,
 * `x-scopes` their scopes. That is the whole seam leaderboard depends on.
 */
function makeApp(input: LeaderboardConfigInput) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    const scopes = c.req.header("x-scopes")?.split(",").filter(Boolean) ?? [];
    if (user) c.set("auth", { userId: user, sessionId: "s1", scopes });
    else c.set("auth", null);
    await next();
  });
  registerLeaderboardRoutes({ config: LeaderboardConfig.parse(input) })(app);
  return app;
}

const CONFIG: LeaderboardConfigInput = { boards: [{ key: "b1", direction: "desc" }] };

const req = (
  app: Hono<PithyHonoEnv>,
  method: string,
  path: string,
  options: { user?: string; scopes?: string; body?: unknown; bookmark?: string } = {},
) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.user) headers["x-user"] = options.user;
  if (options.scopes) headers["x-scopes"] = options.scopes;
  if (options.bookmark) headers[BOOKMARK_HEADER] = options.bookmark;
  const sendsBody = method !== "GET" && method !== "HEAD" && options.body !== undefined;
  return app.request(
    `http://x${path}`,
    { method, headers, body: sendsBody ? JSON.stringify(options.body) : undefined },
    env,
  );
};

/** `Response.json()` is `unknown` under strict mode; these name the shapes the routes actually return. */
interface Page {
  board: string;
  window: string;
  entries: Array<{ userId: string; rank: number; score: number; tier: string | null }>;
}
const page = async (res: Response): Promise<Page> => (await res.json()) as Page;

/** Submit as the trusted server on behalf of a player. */
const submit = (app: Hono<PithyHonoEnv>, user: string, score: number) =>
  req(app, "POST", "/leaderboard/b1", { user, scopes: SUBMIT, body: { score } });

beforeEach(async () => {
  for (const t of [
    "pithy_leaderboard_entries",
    "pithy_leaderboard_boards",
    "pithy_leaderboard_locks",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
});

describe("authentication", () => {
  test("denies every route without an identity — there is no public leaderboard", async () => {
    const app = makeApp(CONFIG);
    for (const [method, path] of [
      ["GET", "/leaderboard"],
      ["POST", "/leaderboard/b1"],
      ["GET", "/leaderboard/b1/top"],
      ["GET", "/leaderboard/b1/me"],
      ["GET", "/leaderboard/b1/around"],
      ["POST", "/leaderboard/b1/segment"],
      ["PUT", "/leaderboard/b1/me/visibility"],
      ["DELETE", "/leaderboard/b1/entries/u1"],
    ] as const) {
      const res = await req(app, method, path, { body: {} });
      expect([res.status, path]).toEqual([401, path]);
    }
  });
});

describe("server-authoritative submit", () => {
  test("rejects a player's own token by default — inverting the vendor norm", async () => {
    const res = await req(makeApp(CONFIG), "POST", "/leaderboard/b1", { user: "u1", body: { score: 10 } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "leaderboard/submit_forbidden" } });
  });

  test("accepts a token carrying the submit scope", async () => {
    expect((await submit(makeApp(CONFIG), "u1", 10)).status).toBe(201);
  });

  test("accepts a player's own token once serverAuthoritative is turned off", async () => {
    const app = makeApp({ ...CONFIG, serverAuthoritative: false });
    expect((await req(app, "POST", "/leaderboard/b1", { user: "u1", body: { score: 10 } })).status).toBe(201);
  });

  test("honors a custom submit scope", async () => {
    const app = makeApp({ ...CONFIG, submitScope: "scores:write" });
    expect((await req(app, "POST", "/leaderboard/b1", { user: "u1", scopes: SUBMIT, body: { score: 1 } })).status).toBe(
      403,
    );
    expect(
      (await req(app, "POST", "/leaderboard/b1", { user: "u1", scopes: "scores:write", body: { score: 1 } })).status,
    ).toBe(201);
  });

  test("attributes the score to the authenticated player, never to a userId in the body", async () => {
    const app = makeApp(CONFIG);
    await req(app, "POST", "/leaderboard/b1", { user: "u1", scopes: SUBMIT, body: { score: 10, userId: "victim" } });
    const res = await req(app, "GET", "/leaderboard/b1/top", { user: "u1" });
    expect((await page(res)).entries.map((e: { userId: string }) => e.userId)).toEqual(["u1"]);
  });

  test("ignores an achievedAt in the body, so a client cannot backdate past the tiebreak", async () => {
    const before = Date.now();
    const app = makeApp(CONFIG);
    await req(app, "POST", "/leaderboard/b1", { user: "u1", scopes: SUBMIT, body: { score: 10, achievedAt: 0 } });
    // The submission landed with the server's clock, not the epoch zero the client asked for. Honoring
    // a client achievedAt would let anyone claim they reached a score first and take the tiebreak.
    const { results } = await env.DB.prepare("SELECT achieved_at FROM pithy_leaderboard_entries").all<{
      achieved_at: number;
    }>();
    expect(results[0]?.achieved_at).toBeGreaterThanOrEqual(before);
  });
});

describe("score validation", () => {
  test("rejects a score below the board minimum", async () => {
    const app = makeApp({ boards: [{ key: "b1", direction: "desc", min: 0, max: 100 }] });
    const res = await submit(app, "u1", -5);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "leaderboard/score_rejected" } });
  });

  test("rejects a score above the board maximum", async () => {
    const app = makeApp({ boards: [{ key: "b1", direction: "desc", min: 0, max: 100 }] });
    expect((await submit(app, "u1", 500)).status).toBe(400);
  });

  test("leaves no entry behind when a score is rejected", async () => {
    const app = makeApp({ boards: [{ key: "b1", direction: "desc", min: 0, max: 100 }] });
    await submit(app, "u1", 500);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_leaderboard_entries").all<{
      n: number;
    }>();
    expect(results[0]?.n).toBe(0);
  });

  test("rejects a non-numeric score at the boundary", async () => {
    const res = await req(makeApp(CONFIG), "POST", "/leaderboard/b1", {
      user: "u1",
      scopes: SUBMIT,
      body: { score: "lots" },
    });
    expect(res.status).toBe(400);
  });

  test("404s an unknown board rather than inventing one", async () => {
    const res = await req(makeApp(CONFIG), "POST", "/leaderboard/nope", {
      user: "u1",
      scopes: SUBMIT,
      body: { score: 1 },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "leaderboard/board_not_found" } });
  });
});

describe("reads", () => {
  test("lists the configured boards", async () => {
    const res = await req(makeApp(CONFIG), "GET", "/leaderboard", { user: "u1" });
    expect(await res.json()).toEqual({
      boards: [{ key: "b1", store: "d1", direction: "desc", aggregation: "best", window: null, tiers: [] }],
    });
  });

  test("returns a ranked top-N page", async () => {
    const app = makeApp(CONFIG);
    await submit(app, "u1", 10);
    await submit(app, "u2", 30);
    const res = await req(app, "GET", "/leaderboard/b1/top", { user: "u1" });
    expect((await page(res)).entries.map((e: { userId: string; rank: number }) => [e.userId, e.rank])).toEqual([
      ["u2", 1],
      ["u1", 2],
    ]);
  });

  test("caps the page size rather than letting a client ask for the whole board", async () => {
    const res = await req(makeApp(CONFIG), "GET", "/leaderboard/b1/top?limit=5000", { user: "u1" });
    expect(res.status).toBe(400);
  });

  test("returns the caller's own rank", async () => {
    const app = makeApp(CONFIG);
    await submit(app, "u1", 10);
    await submit(app, "u2", 30);
    const res = await req(app, "GET", "/leaderboard/b1/me", { user: "u1" });
    expect(await res.json()).toMatchObject({ userId: "u1", score: 10, rank: 2, rankStale: false });
  });

  test("404s my-rank for a player who has never submitted", async () => {
    const res = await req(makeApp(CONFIG), "GET", "/leaderboard/b1/me", { user: "ghost" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "leaderboard/entry_not_found" } });
  });

  test("marks the rank stale when the board is materialized", async () => {
    const app = makeApp({ ...CONFIG, rank: { materialize: "0 * * * *" } });
    await submit(app, "u1", 10);
    expect(await (await req(app, "GET", "/leaderboard/b1/me", { user: "u1" })).json()).toMatchObject({
      rankStale: true,
      rank: null,
    });
  });

  test("returns the slice around the caller", async () => {
    const app = makeApp(CONFIG);
    for (let i = 1; i <= 5; i++) await submit(app, `u${i}`, 100 - i);
    const res = await req(app, "GET", "/leaderboard/b1/around?radius=1", { user: "u3" });
    expect((await page(res)).entries.map((e: { userId: string }) => e.userId)).toEqual(["u2", "u3", "u4"]);
  });

  test("ranks within a segment", async () => {
    const app = makeApp(CONFIG);
    await submit(app, "u1", 10);
    await submit(app, "u2", 30);
    await submit(app, "u3", 20);
    const res = await req(app, "POST", "/leaderboard/b1/segment", { user: "u1", body: { userIds: ["u1", "u3"] } });
    expect((await page(res)).entries.map((e: { userId: string }) => e.userId)).toEqual(["u3", "u1"]);
  });

  test("rejects a segment larger than D1's bound-parameter budget allows", async () => {
    const res = await req(makeApp(CONFIG), "POST", "/leaderboard/b1/segment", {
      user: "u1",
      body: { userIds: Array.from({ length: 200 }, (_, i) => `u${i}`) },
    });
    expect(res.status).toBe(400);
  });
});

describe("consent", () => {
  test("a player can take themselves off the board", async () => {
    const app = makeApp(CONFIG);
    await submit(app, "u1", 10);
    expect(
      (await req(app, "PUT", "/leaderboard/b1/me/visibility", { user: "u1", body: { visible: false } })).status,
    ).toBe(200);
    const res = await req(app, "GET", "/leaderboard/b1/top", { user: "u2" });
    expect((await page(res)).entries).toEqual([]);
  });

  test("a player cannot change another player's visibility — the route is scoped to the caller", async () => {
    const app = makeApp(CONFIG);
    await submit(app, "u1", 10);
    // u2 has no entry, so their own visibility call 404s rather than touching u1's.
    expect(
      (await req(app, "PUT", "/leaderboard/b1/me/visibility", { user: "u2", body: { visible: false } })).status,
    ).toBe(404);
    const res = await req(app, "GET", "/leaderboard/b1/top", { user: "u1" });
    expect((await page(res)).entries).toHaveLength(1);
  });

  test("an opted-out board keeps players off it until they consent", async () => {
    const app = makeApp({ ...CONFIG, visibleByDefault: false });
    await submit(app, "u1", 10);
    expect((await page(await req(app, "GET", "/leaderboard/b1/top", { user: "u1" }))).entries).toEqual([]);
    await req(app, "PUT", "/leaderboard/b1/me/visibility", { user: "u1", body: { visible: true } });
    expect((await page(await req(app, "GET", "/leaderboard/b1/top", { user: "u1" }))).entries).toHaveLength(1);
  });
});

describe("moderation", () => {
  test("refuses to hide an entry without the admin scope", async () => {
    const app = makeApp(CONFIG);
    await submit(app, "u1", 10);
    const res = await req(app, "PUT", "/leaderboard/b1/entries/u1/hidden", { user: "mod", body: { hidden: true } });
    expect(res.status).toBe(403);
  });

  test("refuses to remove an entry without the admin scope", async () => {
    const app = makeApp(CONFIG);
    await submit(app, "u1", 10);
    expect((await req(app, "DELETE", "/leaderboard/b1/entries/u1", { user: "mod" })).status).toBe(403);
  });

  test("hides an entry with the admin scope, keeping the score", async () => {
    const app = makeApp(CONFIG);
    await submit(app, "u1", 10);
    const res = await req(app, "PUT", "/leaderboard/b1/entries/u1/hidden", {
      user: "mod",
      scopes: ADMIN,
      body: { hidden: true },
    });
    expect(res.status).toBe(200);
    expect((await page(await req(app, "GET", "/leaderboard/b1/top", { user: "u2" }))).entries).toEqual([]);
    const { results } = await env.DB.prepare("SELECT score FROM pithy_leaderboard_entries").all<{ score: number }>();
    expect(results[0]?.score).toBe(10);
  });

  test("a hidden player cannot unhide themselves through their own consent toggle", async () => {
    const app = makeApp(CONFIG);
    await submit(app, "u1", 10);
    await req(app, "PUT", "/leaderboard/b1/entries/u1/hidden", { user: "mod", scopes: ADMIN, body: { hidden: true } });
    await req(app, "PUT", "/leaderboard/b1/me/visibility", { user: "u1", body: { visible: true } });
    expect((await page(await req(app, "GET", "/leaderboard/b1/top", { user: "u2" }))).entries).toEqual([]);
  });

  test("removes an entry with the admin scope", async () => {
    const app = makeApp(CONFIG);
    await submit(app, "u1", 10);
    expect((await req(app, "DELETE", "/leaderboard/b1/entries/u1", { user: "mod", scopes: ADMIN })).status).toBe(200);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_leaderboard_entries").all<{
      n: number;
    }>();
    expect(results[0]?.n).toBe(0);
  });

  test("404s removing an entry that does not exist", async () => {
    expect(
      (await req(makeApp(CONFIG), "DELETE", "/leaderboard/b1/entries/ghost", { user: "mod", scopes: ADMIN })).status,
    ).toBe(404);
  });
});

describe("board drift guard", () => {
  test("refuses a submission after the board's direction changed under it", async () => {
    await submit(makeApp(CONFIG), "u1", 10);
    const flipped = makeApp({ boards: [{ key: "b1", direction: "asc" }] });
    const res = await submit(flipped, "u2", 5);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "leaderboard/board_immutable" } });
  });
});

describe("read-your-own-writes", () => {
  test("returns a bookmark on a write, for the client to echo back", async () => {
    const res = await submit(makeApp(CONFIG), "u1", 10);
    expect(res.headers.get(BOOKMARK_HEADER)).toBeTruthy();
  });

  test("accepts the bookmark on a read and still serves the player their own score", async () => {
    const app = makeApp(CONFIG);
    const write = await submit(app, "u1", 10);
    const bookmark = write.headers.get(BOOKMARK_HEADER) ?? undefined;
    const res = await req(app, "GET", "/leaderboard/b1/me", { user: "u1", bookmark });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ score: 10 });
  });

  test("serves a read with no bookmark, since a client that never wrote has nothing to miss", async () => {
    const app = makeApp(CONFIG);
    await submit(app, "u1", 10);
    expect((await req(app, "GET", "/leaderboard/b1/top", { user: "u2" })).status).toBe(200);
  });
});

describe("error payloads", () => {
  test("never leaks internal detail to a client", async () => {
    const res = await req(makeApp(CONFIG), "POST", "/leaderboard/nope", {
      user: "u1",
      scopes: SUBMIT,
      body: { score: 1 },
    });
    expect(await res.json()).not.toHaveProperty("detail");
  });
});

/** The `error` object every rejected request answers with. `Response.json()` is `unknown` under strict mode. */
const errorOf = async (res: Response): Promise<{ code: string; status: number }> =>
  ((await res.json()) as { error: { code: string; status: number } }).error;

describe("declared input", () => {
  test("rejects a malformed param — a board key is a path segment, so its shape is checked on the route line", async () => {
    // Shape only. `NOT_A_KEY` could never be a configured board (config enforces the same pattern), so
    // this rejects nothing that resolved before; an unknown but well-shaped key still 404s below.
    const res = await req(makeApp(CONFIG), "GET", "/leaderboard/NOT_A_KEY/top", { user: "u1" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("still 404s a well-shaped board key that is simply not configured", async () => {
    const res = await req(makeApp(CONFIG), "GET", "/leaderboard/nope/top", { user: "u1" });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("leaderboard/board_not_found");
  });

  test("rejects a malformed query", async () => {
    const res = await req(makeApp(CONFIG), "GET", "/leaderboard/b1/top?limit=lots", { user: "u1" });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("rejects a malformed body", async () => {
    const res = await req(makeApp(CONFIG), "POST", "/leaderboard/b1", {
      user: "u1",
      scopes: SUBMIT,
      body: { score: "lots" },
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("rejects a JSON body it cannot even parse, as a 400 rather than a crash", async () => {
    const res = await makeApp(CONFIG).request(
      "http://x/leaderboard/b1",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-user": "u1", "x-scopes": SUBMIT },
        body: "{ not json",
      },
      env,
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("bounds a moderation target's user id rather than passing an unbounded string to the store", async () => {
    const res = await req(makeApp(CONFIG), "DELETE", `/leaderboard/b1/entries/${"u".repeat(300)}`, {
      user: "mod",
      scopes: ADMIN,
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });
});

describe("declared input runs after the guards and before the handler", () => {
  test("an unauthenticated request with a malformed body is still a 401", async () => {
    const res = await req(makeApp(CONFIG), "POST", "/leaderboard/b1", { body: { score: "lots" } });
    expect(res.status).toBe(401);
  });

  test("an unscoped request with a malformed body is still a 403", async () => {
    const res = await req(makeApp(CONFIG), "PUT", "/leaderboard/b1/entries/u1/hidden", {
      user: "mod",
      body: { hidden: "yes" },
    });
    expect(res.status).toBe(403);
  });

  test("an unknown board with a malformed body is a 400, not the 404 it used to be", async () => {
    // The order changed deliberately with the move to route-line validation: the request was never
    // well-formed enough to have a board, so the shape answers before the board lookup does.
    const res = await req(makeApp(CONFIG), "POST", "/leaderboard/nope", {
      user: "u1",
      scopes: SUBMIT,
      body: { score: "lots" },
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("the same inversion on the consent route", async () => {
    const res = await req(makeApp(CONFIG), "PUT", "/leaderboard/nope/me/visibility", {
      user: "u1",
      body: { visible: "maybe" },
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });
});
