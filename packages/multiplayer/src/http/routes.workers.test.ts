// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { ErrorBody } from "@pithy-sh/core/src/error/wire";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { Hono } from "hono";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { MULTIPLAYER_MIGRATION_ORDER } from "../capability";
import { MultiplayerConfig, type MultiplayerConfigInput, validateGames } from "../config/config";
import "../game/builtins";
import { type GameModel, registerGameModel } from "../game/model";
import { multiplayer_0001_results } from "../migrations/0001_results";
import { ServerFrame } from "../session/frames";
import { SessionResult, SessionView } from "./responses";
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

/**
 * Read a response through its schema in `responses.ts`, and require the parse to hand back exactly what
 * arrived. That is the binding between the contract and the handler: a field the handler adds or drops
 * without the schema fails here, on a real answer.
 */
async function conforming<Schema extends z.ZodType>(res: Response, schema: Schema): Promise<z.infer<Schema>> {
  const body: unknown = await res.json();
  expect(schema.parse(body)).toEqual(body);
  return body as z.infer<Schema>;
}

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
    const id = (await conforming(created, SessionView)).sessionId;

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
    expect((await conforming(resolved, SessionView)).phase).toBe("resolved");

    const result = await req(app, "GET", `/multiplayer/sessions/${id}/result`, { user: "alice" });
    expect(result.status).toBe(200);
    expect((await conforming(result, SessionResult)).status).toBe("resolved");
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

  test("a malformed game key is the validator's 400; a well-shaped unknown key keeps its 404", async () => {
    const app = makeApp(CONFIG);
    // `MultiplayerGameParams` bounds the segment to the kebab-case shape config already enforces, so an
    // uppercase key — which no game could ever be configured under — is rejected a step before the lookup.
    // The order is deliberate: the validator runs before the handler, so this is a 400 where it would
    // previously have fallen through to the handler's game_not_found 404.
    const malformed = await req(app, "POST", "/multiplayer/games/CHESS", { user: "alice" });
    expect(malformed.status).toBe(400);
    expect((await malformed.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
    // A key that is merely unconfigured is a shape the schema accepts, so config resolution still owns it.
    const unknown = await req(app, "POST", "/multiplayer/games/chess", { user: "alice" });
    expect(unknown.status).toBe(404);
    expect((await unknown.json<{ error: { code: string } }>()).error.code).toBe("multiplayer/game_not_found");
  });

  test("an over-long session id is the validator's 400; an unparseable one stays the handler's 404", async () => {
    const app = makeApp(CONFIG);
    const res = await req(app, "GET", `/multiplayer/sessions/${"a".repeat(129)}`, { user: "alice" });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
    // The id schema is a bound, not a format: `idFromString` still owns whether an id names a session,
    // which is why `not-a-real-id` above is a 404 and not a 400.
  });

  test("the validator runs after the guard — an unauthenticated malformed request is still a 401", async () => {
    const app = makeApp(CONFIG);
    expect((await req(app, "POST", "/multiplayer/games/CHESS")).status).toBe(401);
    expect((await req(app, "POST", `/multiplayer/sessions/${"a".repeat(129)}/join`)).status).toBe(401);
  });

  test("a malformed action is the game's own 400, judged by its declared action schema", async () => {
    // No multiplayer route declares a json schema: the action belongs to the game's model. The `battle` model
    // declares its `action`, so the session parses the body with it — a body-less action and a misshapen one
    // are both `validation/invalid_input`, from the session rather than a body validator, and only once the
    // caller has been judged a member of an active session.
    const app = makeApp(CONFIG);
    const created = await req(app, "POST", "/multiplayer/games/battle", { user: "alice" });
    const id = (await created.json<SessionView>()).sessionId;
    await req(app, "POST", `/multiplayer/sessions/${id}/join`, { user: "bob" });

    const bodyless = await req(app, "POST", `/multiplayer/sessions/${id}/action`, { user: "alice" });
    expect(bodyless.status).toBe(400);
    const bodylessError = await bodyless.json<{ error: { code: string; action?: string } }>();
    expect(bodylessError.error.code).toBe("validation/invalid_input");
    expect(Object.hasOwn(bodylessError.error, "action")).toBe(false);

    const misshapen = await req(app, "POST", `/multiplayer/sessions/${id}/action`, {
      user: "alice",
      body: { offense: "fire" },
    });
    expect(misshapen.status).toBe(400);
    expect((await misshapen.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");

    // A non-member still gets the 403 whatever they send — the action schema runs after the membership check.
    const outsider = await req(app, "POST", `/multiplayer/sessions/${id}/action`, { user: "mallory" });
    expect(outsider.status).toBe(403);
  });

  test("a model that declares no action schema still receives the body untouched, a missing one as no payload", async () => {
    const received: unknown[] = [];
    const echo: GameModel = {
      kind: "test-route-echo",
      config: z.object({}).describe("No rules."),
      state: z.object({}).describe("No state."),
      init: () => ({}),
      apply: (_ctx, state, _player, action) => {
        received.push(action);
        return { state };
      },
      isComplete: () => false,
      resolve: () => ({ outcome: { scores: {}, winnerUserId: null, draw: true } }),
      redact: () => ({}),
    };
    registerGameModel(echo);
    const app = makeApp({ games: [{ key: "echo", kind: "test-route-echo", rules: {} }] });
    const created = await req(app, "POST", "/multiplayer/games/echo", { user: "alice" });
    const id = (await created.json<SessionView>()).sessionId;
    await req(app, "POST", `/multiplayer/sessions/${id}/join`, { user: "bob" });

    expect((await req(app, "POST", `/multiplayer/sessions/${id}/action`, { user: "alice" })).status).toBe(200);
    expect(
      (await req(app, "POST", `/multiplayer/sessions/${id}/action`, { user: "alice", body: { anything: [1] } })).status,
    ).toBe(200);
    expect(received).toEqual([undefined, { anything: [1] }]);
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

  test("the socket route answers a v1 offer with v1 on the 101, and the frames are v1", async () => {
    const app = makeApp(CONFIG);
    const created = await req(app, "POST", "/multiplayer/games/battle", { user: "alice" });
    const id = (await created.json<SessionView>()).sessionId;
    const res = await app.request(
      `http://x/multiplayer/sessions/${id}/socket`,
      {
        method: "GET",
        headers: { "x-user": "alice", upgrade: "websocket", "Sec-WebSocket-Protocol": "pithy.multiplayer.v1" },
      },
      env,
    );
    expect(res.status).toBe(101);
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBe("pithy.multiplayer.v1");
    const socket = res.webSocket;
    if (!socket) throw new Error("no socket");
    const first = new Promise<string>((resolve) =>
      socket.addEventListener("message", (event) => resolve(event.data as string), { once: true }),
    );
    socket.accept();
    const frame: unknown = JSON.parse(await first);
    expect(ServerFrame.parse(frame)).toEqual(frame);
    expect((frame as { type: string }).type).toBe("state");
  });

  test("the socket route keeps an unversioned client on the bare view, with no protocol answered", async () => {
    const app = makeApp(CONFIG);
    const created = await req(app, "POST", "/multiplayer/games/battle", { user: "alice" });
    const id = (await created.json<SessionView>()).sessionId;
    const res = await app.request(
      `http://x/multiplayer/sessions/${id}/socket`,
      { method: "GET", headers: { "x-user": "alice", upgrade: "websocket" } },
      env,
    );
    expect(res.status).toBe(101);
    expect(res.headers.get("Sec-WebSocket-Protocol")).toBeNull();
    const socket = res.webSocket;
    if (!socket) throw new Error("no socket");
    const first = new Promise<string>((resolve) =>
      socket.addEventListener("message", (event) => resolve(event.data as string), { once: true }),
    );
    socket.accept();
    const frame: unknown = JSON.parse(await first);
    expect(SessionView.parse(frame)).toEqual(frame);
    expect(Object.hasOwn(frame as object, "type")).toBe(false);
  });

  test("the socket route refuses an offer it does not serve with a 400, before the session is reached", async () => {
    const app = makeApp(CONFIG);
    const created = await req(app, "POST", "/multiplayer/games/battle", { user: "alice" });
    const id = (await created.json<SessionView>()).sessionId;
    const res = await app.request(
      `http://x/multiplayer/sessions/${id}/socket`,
      { method: "GET", headers: { "x-user": "alice", upgrade: "websocket", "Sec-WebSocket-Protocol": "graphql-ws" } },
      env,
    );
    expect(res.status).toBe(400);
    expect(res.webSocket).toBeNull();
    const body = await conforming(res, ErrorBody);
    expect(body.error.code).toBe("validation/invalid_input");
    // Still a 401 first for a caller nobody verified, whatever they offered.
    const anonymous = await app.request(
      `http://x/multiplayer/sessions/${id}/socket`,
      { method: "GET", headers: { upgrade: "websocket", "Sec-WebSocket-Protocol": "graphql-ws" } },
      env,
    );
    expect(anonymous.status).toBe(401);
  });
});
