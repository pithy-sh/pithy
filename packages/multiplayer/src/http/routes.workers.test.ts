import { env } from "cloudflare:test";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { Hono } from "hono";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { MULTIPLAYER_MIGRATION_ORDER } from "../capability";
import { MultiplayerConfig, type MultiplayerConfigInput, validateGames } from "../config/config";
import "../game/builtins";
import { multiplayer_0001_results } from "../migrations/0001_results";
import type { SessionView } from "../session/state";
import { registerMultiplayerRoutes } from "./routes";

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "multiplayer",
      order: MULTIPLAYER_MIGRATION_ORDER,
      migrations: { "0001_results": multiplayer_0001_results },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error("no app provider");
  return found;
}

beforeEach(async () => {
  for (const t of ["pithy_multiplayer_results", "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
});

/** A Hono app with the multiplayer routes and a stand-in for `@pithy-sh/auth`: `x-user` sets the player. */
function makeApp(input: MultiplayerConfigInput) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    if (user) c.set("auth", { userId: user, sessionId: "s1", scopes: [] });
    else c.set("auth", null);
    await next();
  });
  registerMultiplayerRoutes({ games: validateGames(MultiplayerConfig.parse(input)) })(app);
  return app;
}

const CONFIG: MultiplayerConfigInput = {
  games: [
    {
      key: "battle",
      kind: "battle",
      rules: {
        offense: {
          pick: 1,
          moves: [
            { name: "fire", power: 10 },
            { name: "ice", power: 8 },
          ],
        },
        defense: {
          pick: 1,
          moves: [
            { name: "guard-fire", blocks: "fire" },
            { name: "guard-ice", blocks: "ice" },
          ],
        },
      },
    },
  ],
};

const req = (
  app: Hono<PithyHonoEnv>,
  method: string,
  path: string,
  options: { user?: string; body?: unknown } = {},
) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.user) headers["x-user"] = options.user;
  const sendsBody = method !== "GET" && options.body !== undefined;
  return app.request(
    `http://x${path}`,
    { method, headers, body: sendsBody ? JSON.stringify(options.body) : undefined },
    env,
  );
};

describe("multiplayer routes", () => {
  test("create requires authentication and rejects an unknown game", async () => {
    const app = makeApp(CONFIG);
    expect((await req(app, "POST", "/multiplayer/games/battle")).status).toBe(401);
    const res = await req(app, "POST", "/multiplayer/games/chess", { user: "alice" });
    expect(res.status).toBe(404);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("multiplayer/game_not_found");
  });

  test("a full create → join → action → resolve flow over HTTP", async () => {
    const app = makeApp(CONFIG);
    const created = await req(app, "POST", "/multiplayer/games/battle", { user: "alice" });
    expect(created.status).toBe(201);
    const id = (await created.json<SessionView>()).sessionId;

    const joined = await req(app, "POST", `/multiplayer/sessions/${id}/join`, { user: "bob" });
    expect((await joined.json<SessionView>()).phase).toBe("active");

    await req(app, "POST", `/multiplayer/sessions/${id}/action`, {
      user: "alice",
      body: { offense: ["fire"], defense: ["guard-ice"] },
    });
    const resolved = await req(app, "POST", `/multiplayer/sessions/${id}/action`, {
      user: "bob",
      body: { offense: ["ice"], defense: ["guard-fire"] },
    });
    expect((await resolved.json<SessionView>()).phase).toBe("resolved");

    const result = await req(app, "GET", `/multiplayer/sessions/${id}/result`, { user: "alice" });
    expect(result.status).toBe(200);
    expect((await result.json<{ status: string }>()).status).toBe("resolved");
  });

  test("acting as a non-member is a 403; an unparseable id is a 404; the result 404s before terminal", async () => {
    const app = makeApp(CONFIG);
    const created = await req(app, "POST", "/multiplayer/games/battle", { user: "alice" });
    const id = (await created.json<SessionView>()).sessionId;
    await req(app, "POST", `/multiplayer/sessions/${id}/join`, { user: "bob" });

    const forbidden = await req(app, "POST", `/multiplayer/sessions/${id}/action`, {
      user: "mallory",
      body: { offense: ["fire"], defense: ["guard-ice"] },
    });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json<{ error: { code: string } }>()).error.code).toBe("multiplayer/not_a_member");

    const bad = await req(app, "GET", "/multiplayer/sessions/not-a-real-id", { user: "alice" });
    expect(bad.status).toBe(404);
    expect((await bad.json<{ error: { code: string } }>()).error.code).toBe("multiplayer/session_not_found");

    expect((await req(app, "GET", `/multiplayer/sessions/${id}/result`, { user: "alice" })).status).toBe(404);
  });

  test("the socket route forwards an authenticated upgrade to the DO and gets a 101", async () => {
    const app = makeApp(CONFIG);
    const created = await req(app, "POST", "/multiplayer/games/battle", { user: "alice" });
    const id = (await created.json<SessionView>()).sessionId;
    const res = await app.request(
      `http://x/multiplayer/sessions/${id}/socket`,
      { method: "GET", headers: { "x-user": "alice", upgrade: "websocket" } },
      env,
    );
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
  });

  test("the socket route overwrites a client-supplied user header — no impersonation", async () => {
    const app = makeApp(CONFIG);
    const created = await req(app, "POST", "/multiplayer/games/battle", { user: "alice" });
    const id = (await created.json<SessionView>()).sessionId;
    // Mallory (not a member) smuggles alice's id in the trusted header — the route must overwrite it, so the DO refuses.
    const res = await app.request(
      `http://x/multiplayer/sessions/${id}/socket`,
      { method: "GET", headers: { "x-user": "mallory", "x-pithy-user-id": "alice", upgrade: "websocket" } },
      env,
    );
    expect(res.status).toBe(403);
  });
});
