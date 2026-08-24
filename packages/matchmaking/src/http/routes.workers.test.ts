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
import { MATCHMAKING_MIGRATION_ORDER } from "../capability";
import { MatchmakingConfig, type MatchmakingConfigInput } from "../config/config";
import { matchmaking_0001_matchmaking } from "../migrations/0001_matchmaking";
import { registerMatchmakingRoutes } from "./routes";

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "matchmaking",
      order: MATCHMAKING_MIGRATION_ORDER,
      migrations: { "0001_matchmaking": matchmaking_0001_matchmaking },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error("no app provider");
  return found;
}

// A fake multiplayer SESSIONS namespace injected via the request env, so room/invite paths mint a
// session id without a real multiplayer DO. The queue DO has its own env (no SESSIONS), tested separately.
let counter = 0;
const fakeSessions = {
  newUniqueId: () => {
    const id = `sess${++counter}`;
    return { toString: () => id };
  },
  idFromString: (hex: string) => hex,
  get: (id: unknown) => ({
    async create() {
      return { sessionId: String(id) };
    },
    async join() {
      return { sessionId: String(id) };
    },
  }),
};

function requestEnv(): typeof env {
  return { ...env, SESSIONS: fakeSessions } as unknown as typeof env;
}

const CONFIG: MatchmakingConfigInput = {
  games: [{ key: "duel", players: 2, snapshot: { kind: "connect-n", rules: {} } }],
};

function makeApp(input: MatchmakingConfigInput = CONFIG) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    if (user) c.set("auth", { userId: user, sessionId: "s1", scopes: [] });
    else c.set("auth", null);
    await next();
  });
  registerMatchmakingRoutes({ config: MatchmakingConfig.parse(input) })(app);
  return app;
}

async function seedAuthUser(id: string, email: string, name: string): Promise<void> {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS pithy_auth_users (id TEXT PRIMARY KEY, name TEXT, email TEXT, email_verified INTEGER, image TEXT, created_at TEXT, updated_at TEXT, locale TEXT)",
  );
  await env.DB.prepare(
    "INSERT INTO pithy_auth_users (id, name, email, email_verified, image, created_at, updated_at) VALUES (?, ?, ?, 1, NULL, ?, ?)",
  )
    .bind(id, name, email, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")
    .run();
}

beforeEach(async () => {
  for (const t of [
    "pithy_matchmaking_invites",
    "pithy_matchmaking_friends",
    "pithy_auth_users",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
  counter = 0;
});

describe("matchmaking routes — auth", () => {
  test("every route requires authentication", async () => {
    const res = await makeApp().request("/matchmaking/games/duel/rooms", { method: "POST" }, requestEnv());
    expect(res.status).toBe(401);
  });
});

describe("matchmaking routes — rooms", () => {
  test("a host opens a room and another player joins the same session", async () => {
    const app = makeApp();
    const created = await app.request(
      "/matchmaking/games/duel/rooms",
      { method: "POST", headers: { "x-user": "host" } },
      requestEnv(),
    );
    expect(created.status).toBe(201);
    const room = await created.json<{ code: string; sessionId: string }>();
    expect(room.code).toMatch(/^[A-Z]{4}-[0-9]{4}$/);

    const joined = await app.request(
      `/matchmaking/rooms/${room.code}/join`,
      { method: "POST", headers: { "x-user": "guest" } },
      requestEnv(),
    );
    expect(joined.status).toBe(200);
    const result = await joined.json<{ sessionId: string; usesRemaining: number }>();
    expect(result.sessionId).toBe(room.sessionId);
  });

  test("an unknown code is a 404", async () => {
    const res = await makeApp().request(
      "/matchmaking/rooms/ZZZZ-9999/join",
      { method: "POST", headers: { "x-user": "guest" } },
      requestEnv(),
    );
    expect(res.status).toBe(404);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("matchmaking/room_not_found");
  });
});

describe("matchmaking routes — validation", () => {
  test("an over-long room code is rejected by the param schema before the store is touched", async () => {
    const res = await makeApp().request(
      `/matchmaking/rooms/${"A".repeat(64)}/join`,
      { method: "POST", headers: { "x-user": "guest" } },
      requestEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("a badly shaped but short code still reaches normalizeCode and its own error", async () => {
    // The `:code` param schema is a length bound only — the code's real shape stays with normalizeCode,
    // so a plausible-length bad code answers `matchmaking/invalid_code`, not the validator's 400.
    const res = await makeApp().request(
      "/matchmaking/rooms/nope/join",
      { method: "POST", headers: { "x-user": "guest" } },
      requestEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("matchmaking/invalid_code");
  });

  test("an over-long game key is rejected before the game is resolved", async () => {
    const res = await makeApp().request(
      `/matchmaking/games/${"g".repeat(80)}/queue`,
      { method: "POST", headers: { "x-user": "alice" } },
      requestEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("a game key of a plausible shape that is not configured is still a 404", async () => {
    // The param schema is a shape check, never a list of configured keys — resolveMatchmakingGame keeps
    // owning the 404 so an unknown game never reads as a malformed request.
    const res = await makeApp().request(
      "/matchmaking/games/chess/queue",
      { method: "POST", headers: { "x-user": "alice" } },
      requestEnv(),
    );
    expect(res.status).toBe(404);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("core/not_found");
  });

  test("an invite id that is not a UUID is a 400, not the invite store's 404", async () => {
    // Order change: the `:id` param schema now runs before the lookup, so a malformed id is a malformed
    // request. Only a well-shaped id that does not exist still answers matchmaking/invite_not_found.
    const res = await makeApp().request(
      "/matchmaking/invites/not-a-uuid/accept",
      { method: "POST", headers: { "x-user": "bob" } },
      requestEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("a well-shaped invite id that does not exist is still a 404", async () => {
    const res = await makeApp().request(
      "/matchmaking/invites/22222222-2222-4222-8222-222222222222/decline",
      { method: "POST", headers: { "x-user": "bob" } },
      requestEnv(),
    );
    expect(res.status).toBe(404);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("matchmaking/invite_not_found");
  });

  test("an over-long friend user id is rejected by the param schema", async () => {
    const res = await makeApp().request(
      `/matchmaking/friends/${"u".repeat(300)}/request`,
      { method: "POST", headers: { "x-user": "alice" } },
      requestEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("an invite naming both an email and a name is a 400", async () => {
    const res = await makeApp().request(
      "/matchmaking/games/duel/invites",
      {
        method: "POST",
        headers: { "x-user": "alice", "content-type": "application/json" },
        body: JSON.stringify({ email: "bob@example.com", name: "Bob" }),
      },
      requestEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("an unparseable invite body is a 400, not the 500 a bare body read produced", async () => {
    const res = await makeApp().request(
      "/matchmaking/games/duel/invites",
      {
        method: "POST",
        headers: { "x-user": "alice", "content-type": "application/json" },
        body: "{ not json",
      },
      requestEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("a malformed body on an unknown game is the validator's 400, not the game's 404", async () => {
    // Order change: the body validator is middleware, so it answers before the handler resolves the game.
    const res = await makeApp().request(
      "/matchmaking/games/chess/invites",
      { method: "POST", headers: { "x-user": "alice", "content-type": "application/json" }, body: "{}" },
      requestEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("the guards still run before the validators — a bad body without auth is a 401", async () => {
    const res = await makeApp().request(
      "/matchmaking/games/duel/invites",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      requestEnv(),
    );
    expect(res.status).toBe(401);
  });
});

describe("matchmaking routes — invites", () => {
  test("invite by email, then the invitee accepts into a session", async () => {
    await seedAuthUser("bob", "bob@example.com", "Bob");
    const app = makeApp();

    const created = await app.request(
      "/matchmaking/games/duel/invites",
      {
        method: "POST",
        headers: { "x-user": "alice", "content-type": "application/json" },
        body: JSON.stringify({ email: "bob@example.com" }),
      },
      requestEnv(),
    );
    expect(created.status).toBe(201);
    const invite = await created.json<{ id: string; inviteeId: string }>();
    expect(invite.inviteeId).toBe("bob");

    const pending = await app.request("/matchmaking/invites", { headers: { "x-user": "bob" } }, requestEnv());
    expect((await pending.json<{ invites: unknown[] }>()).invites).toHaveLength(1);

    const accepted = await app.request(
      `/matchmaking/invites/${invite.id}/accept`,
      { method: "POST", headers: { "x-user": "bob" } },
      requestEnv(),
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json<{ sessionId: string | null }>()).sessionId).toBeTruthy();
  });

  test("an invite with neither email nor name is a 400, not a misleading 404", async () => {
    const res = await makeApp().request(
      "/matchmaking/games/duel/invites",
      { method: "POST", headers: { "x-user": "alice", "content-type": "application/json" }, body: "{}" },
      requestEnv(),
    );
    expect(res.status).toBe(400);
  });

  test("a direct invite is rejected for a game that needs more than two players", async () => {
    const app = makeApp({ games: [{ key: "ffa", players: 4, snapshot: { kind: "connect-n", rules: {} } }] });
    const res = await app.request(
      "/matchmaking/games/ffa/invites",
      {
        method: "POST",
        headers: { "x-user": "alice", "content-type": "application/json" },
        body: JSON.stringify({ email: "bob@example.com" }),
      },
      requestEnv(),
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("validation/invalid_input");
  });

  test("only the invitee may accept", async () => {
    await seedAuthUser("bob", "bob@example.com", "Bob");
    const app = makeApp();
    const created = await app.request(
      "/matchmaking/games/duel/invites",
      {
        method: "POST",
        headers: { "x-user": "alice", "content-type": "application/json" },
        body: JSON.stringify({ email: "bob@example.com" }),
      },
      requestEnv(),
    );
    const invite = await created.json<{ id: string }>();
    const res = await app.request(
      `/matchmaking/invites/${invite.id}/accept`,
      { method: "POST", headers: { "x-user": "mallory" } },
      requestEnv(),
    );
    expect(res.status).toBe(403);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("matchmaking/invite_forbidden");
  });
});

describe("matchmaking routes — friends", () => {
  test("request, accept, and list a friendship", async () => {
    const app = makeApp();
    await app.request(
      "/matchmaking/friends/bob/request",
      { method: "POST", headers: { "x-user": "alice" } },
      requestEnv(),
    );
    const accept = await app.request(
      "/matchmaking/friends/alice/accept",
      { method: "POST", headers: { "x-user": "bob" } },
      requestEnv(),
    );
    expect(accept.status).toBe(204);
    const list = await app.request("/matchmaking/friends", { headers: { "x-user": "alice" } }, requestEnv());
    const { friends } = await list.json<{ friends: { userId: string; status: string; direction: string }[] }>();
    expect(friends).toEqual([{ userId: "bob", status: "accepted", direction: "mutual", since: expect.any(String) }]);
  });
});

describe("matchmaking routes — queue", () => {
  test("two players enqueue and get matched", async () => {
    const app = makeApp();
    const a = await app.request(
      "/matchmaking/games/duel/queue",
      { method: "POST", headers: { "x-user": "alice" } },
      requestEnv(),
    );
    expect(a.status).toBe(200);
    const b = await app.request(
      "/matchmaking/games/duel/queue",
      { method: "POST", headers: { "x-user": "bob" } },
      requestEnv(),
    );
    const bStatus = await b.json<{ state: string }>();
    // The second enqueue forms the match (region "unknown" for both, no skill pool → same bucket).
    const aStatus = await app.request(
      "/matchmaking/games/duel/queue",
      { headers: { "x-user": "alice" } },
      requestEnv(),
    );
    const aState = await aStatus.json<{ state: string }>();
    expect([bStatus.state, aState.state]).toContain("matched");
  });

  test("leaving the queue then checking status is a 404", async () => {
    const app = makeApp();
    await app.request("/matchmaking/games/duel/queue", { method: "POST", headers: { "x-user": "solo" } }, requestEnv());
    await app.request(
      "/matchmaking/games/duel/queue",
      { method: "DELETE", headers: { "x-user": "solo" } },
      requestEnv(),
    );
    const res = await app.request("/matchmaking/games/duel/queue", { headers: { "x-user": "solo" } }, requestEnv());
    expect(res.status).toBe(404);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("matchmaking/not_queued");
  });
});
