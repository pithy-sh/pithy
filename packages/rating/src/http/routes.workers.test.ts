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
import "../algorithm/builtins";
import { RATING_MIGRATION_ORDER } from "../capability";
import { RatingConfig, type RatingConfigInput, validateRatingGames } from "../config/config";
import { rating_0001_rating } from "../migrations/0001_rating";
import { registerRatingRoutes } from "./routes";

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "rating",
      order: RATING_MIGRATION_ORDER,
      migrations: { "0001_rating": rating_0001_rating },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error("no app provider");
  return found;
}

beforeEach(async () => {
  for (const t of ["pithy_rating_ratings", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
});

/** A Hono app with the rating routes and a stand-in for `@pithy-sh/auth`: `x-user`/`x-scopes` set identity. */
function makeApp(input: RatingConfigInput) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    const scopes = (c.req.header("x-scopes") ?? "").split(",").filter(Boolean);
    if (user) c.set("auth", { userId: user, sessionId: "s1", scopes });
    else c.set("auth", null);
    await next();
  });
  const config = RatingConfig.parse(input);
  registerRatingRoutes({ games: validateRatingGames(config), config })(app);
  return app;
}

const CONFIG: RatingConfigInput = {
  games: [
    {
      key: "duel",
      algorithm: "elo",
      xp: { win: 20, draw: 10, loss: 5 },
      levels: [
        { key: "rookie", from: 0 },
        { key: "pro", from: 15 },
      ],
    },
  ],
};

describe("rating routes", () => {
  test("recording an outcome requires authentication", async () => {
    const res = await makeApp(CONFIG).request(
      "/rating/games/duel/outcomes",
      {
        method: "POST",
        body: JSON.stringify({ ranks: { ada: 1, alan: 2 } }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  test("recording is server-authoritative — denied without the record scope", async () => {
    const res = await makeApp(CONFIG).request(
      "/rating/games/duel/outcomes",
      {
        method: "POST",
        headers: { "x-user": "server", "content-type": "application/json" },
        body: JSON.stringify({ ranks: { ada: 1, alan: 2 } }),
      },
      env,
    );
    expect(res.status).toBe(403);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("rating/record_forbidden");
  });

  test("records an outcome with the scope, then reads each player's standing", async () => {
    const app = makeApp(CONFIG);
    const record = await app.request(
      "/rating/games/duel/outcomes",
      {
        method: "POST",
        headers: { "x-user": "server", "x-scopes": "rating:record", "content-type": "application/json" },
        body: JSON.stringify({ ranks: { ada: 1, alan: 2 } }),
      },
      env,
    );
    expect(record.status).toBe(201);

    const me = await app.request("/rating/games/duel/me", { headers: { "x-user": "ada" } }, env);
    expect(me.status).toBe(200);
    const view = await me.json<{ skill: number; xp: number; level: string; provisional: boolean }>();
    expect(view.skill).toBeGreaterThan(1500); // Ada won
    expect(view.xp).toBe(20);
    expect(view.level).toBe("pro");
    expect(view.provisional).toBe(false);
  });

  test("an unrated player's read is provisional", async () => {
    const me = await makeApp(CONFIG).request("/rating/games/duel/me", { headers: { "x-user": "newbie" } }, env);
    const view = await me.json<{ provisional: boolean; games: number }>();
    expect(view.provisional).toBe(true);
    expect(view.games).toBe(0);
  });

  test("hideSkill nulls the skill number in a player-facing read", async () => {
    const app = makeApp({ games: [{ key: "ranked", algorithm: "elo", hideSkill: true }] });
    const me = await app.request("/rating/games/ranked/me", { headers: { "x-user": "ada" } }, env);
    expect((await me.json<{ skill: number | null }>()).skill).toBeNull();
  });

  test("an unknown game is a 404", async () => {
    const res = await makeApp(CONFIG).request("/rating/games/missing/me", { headers: { "x-user": "ada" } }, env);
    expect(res.status).toBe(404);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("rating/game_not_found");
  });
});

/** Read the `error` object off a rendered `PithyError` response. */
async function errorOf(res: Response) {
  return (await res.json<{ error: { code: string; status: number } }>()).error;
}

describe("rating route validation", () => {
  test("a malformed body is a 400", async () => {
    const res = await makeApp(CONFIG).request(
      "/rating/games/duel/outcomes",
      {
        method: "POST",
        headers: { "x-user": "server", "x-scopes": "rating:record", "content-type": "application/json" },
        body: JSON.stringify({ ranks: { ada: "first" } }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("an unparseable JSON body is a 400, not a 500", async () => {
    const res = await makeApp(CONFIG).request(
      "/rating/games/duel/outcomes",
      {
        method: "POST",
        headers: { "x-user": "server", "x-scopes": "rating:record", "content-type": "application/json" },
        body: "{ not json",
      },
      env,
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("a malformed game param is a 400", async () => {
    const res = await makeApp(CONFIG).request("/rating/games/NOT_A_KEY/me", { headers: { "x-user": "ada" } }, env);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("a malformed userId param is a 400", async () => {
    const res = await makeApp(CONFIG).request(
      `/rating/games/duel/players/${"u".repeat(201)}`,
      { headers: { "x-user": "ada" } },
      env,
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });

  test("shape loses to identity — an unscoped caller sending a bad body is still a 403", async () => {
    const res = await makeApp(CONFIG).request(
      "/rating/games/duel/outcomes",
      {
        method: "POST",
        headers: { "x-user": "server", "content-type": "application/json" },
        body: JSON.stringify({ ranks: "nonsense" }),
      },
      env,
    );
    // The guards run before the validators, so identity is answered first — never a 400 that leaks
    // whether the body would have been accepted.
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("rating/record_forbidden");
  });

  test("shape beats resolution — a game key that is both malformed and unknown is a 400, not the 404", async () => {
    // New order: the param validator runs before the handler's `resolveGame` lookup. A well-shaped but
    // unconfigured key ("missing", above) is still the 404 — only a malformed segment stops earlier.
    const res = await makeApp(CONFIG).request("/rating/games/Missing/me", { headers: { "x-user": "ada" } }, env);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("validation/invalid_input");
  });
});
