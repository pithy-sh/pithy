// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { authPeer } from "@pithy-sh/auth/src/peer";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { Hono } from "hono";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { MATCHMAKING_MIGRATION_ORDER } from "../capability";
import { MatchmakingConfig, type MatchmakingConfigInput } from "../config/config";
import { FriendView, InviteView, QueueStanding, RoomCreated, RoomJoined } from "../http/responses";
import { registerMatchmakingRoutes } from "../http/routes";
import { matchmaking_0001_matchmaking } from "../migrations/0001_matchmaking";
import {
  acceptFriend,
  acceptInvite,
  createRoom,
  declineFriend,
  declineInvite,
  joinQueue,
  joinRoom,
  leaveQueue,
  listFriends,
  listInvites,
  type MatchmakingClientOptions,
  type MatchmakingFetch,
  readQueue,
  removeFriend,
  requestFriend,
  sendInvite,
} from "./api";

/**
 * **The client against the real Worker.** Every call goes through the real matchmaking routes, with real
 * D1, KV and Durable Object bindings, and every answer is read back through the client's own guards and
 * then through the server's response schema — so the client and the routes cannot disagree about a shape.
 */

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

// A stand-in for multiplayer's SESSIONS namespace, so a room or an accepted invite mints a session id.
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

const CONFIG: MatchmakingConfigInput = {
  games: [{ key: "duel", players: 2, snapshot: { kind: "connect-n", rules: {} } }],
};

/** The routes on a Hono app, with `x-user` standing in for `@pithy-sh/auth`. */
function makeApp(input: MatchmakingConfigInput = CONFIG) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    c.set("auth", user ? { userId: user, sessionId: "s1", scopes: [] } : null);
    await next();
  });
  registerMatchmakingRoutes({ config: MatchmakingConfig.parse(input), peers: () => ({ auth: authPeer }) })(app);
  return app;
}

/** The client's options for `user`: its fetch is the real app, and the user rides a header as a bearer would. */
function as(user: string, app = makeApp()): MatchmakingClientOptions {
  const fetch: MatchmakingFetch = async (url, init) =>
    app.request(url, init as RequestInit, { ...env, SESSIONS: fakeSessions } as unknown as typeof env);
  return { fetch, headers: { "x-user": user } };
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

/** A successful result's value, held to the server's schema: it parses, and the parse is the value. */
function value<T>(
  result: { ok: true; value: T } | { ok: false; failure: unknown },
  schema?: { parse(v: unknown): unknown },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.failure)}`);
  if (schema) expect(schema.parse(result.value)).toEqual(result.value);
  return result.value;
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

describe("the matchmaking client, against the real routes", () => {
  test("rooms: a host opens one and a guest joins it", async () => {
    const app = makeApp();
    const room = value(await createRoom("duel", as("host", app)), RoomCreated);
    const joined = value(await joinRoom(room.code, as("guest", app)), RoomJoined);
    expect(joined.sessionId).toBe(room.sessionId);
  });

  test("invites: sent by email, listed, declined, sent again by name, accepted", async () => {
    await seedAuthUser("ada", "ada@example.com", "Ada");
    const app = makeApp();
    const first = value(await sendInvite("duel", { email: "ada@example.com" }, as("ben", app)), InviteView);
    expect(first.inviteeId).toBe("ada");

    const pending = value(await listInvites(as("ada", app)));
    expect(pending).toEqual([first]);
    for (const invite of pending) InviteView.parse(invite);

    const declined = value(await declineInvite(first.id, as("ada", app)), InviteView);
    expect(declined.status).toBe("declined");

    const second = value(await sendInvite("duel", { name: "Ada" }, as("ben", app)), InviteView);
    const accepted = value(await acceptInvite(second.id, as("ada", app)), InviteView);
    expect(accepted.status).toBe("accepted");
    expect(accepted.sessionId).not.toBeNull();
    expect(value(await listInvites(as("ada", app)))).toEqual([]);
  });

  test("friends: requested, accepted, listed, removed; and a declined request", async () => {
    const app = makeApp();
    expect(value(await requestFriend("grace", as("ada", app)))).toBeNull();
    const incoming = value(await listFriends(as("grace", app)));
    expect(incoming.map((edge) => FriendView.parse(edge))).toEqual(incoming);
    expect(incoming).toMatchObject([{ userId: "ada", status: "pending", direction: "incoming" }]);

    expect(value(await acceptFriend("ada", as("grace", app)))).toBeNull();
    expect(value(await listFriends(as("ada", app)))).toMatchObject([{ userId: "grace", direction: "mutual" }]);
    expect(value(await removeFriend("grace", as("ada", app)))).toBeNull();
    expect(value(await listFriends(as("ada", app)))).toEqual([]);

    expect(value(await requestFriend("ada", as("ben", app)))).toBeNull();
    expect(value(await declineFriend("ben", as("ada", app)))).toBeNull();
    expect(value(await listFriends(as("ada", app)))).toEqual([]);
  });

  test("friends: a Worker that turned them off answers the client's 404", async () => {
    const result = await listFriends(as("ada", makeApp({ ...CONFIG, friends: false })));
    expect(result.ok).toBe(false);
  });

  test("queue: joined, read, left", async () => {
    const app = makeApp();
    const joined = value(await joinQueue("duel", as("solo", app)), QueueStanding);
    expect(joined.state).toBe("queued");
    expect(value(await readQueue("duel", as("solo", app)), QueueStanding).state).toBe("queued");
    expect(value(await leaveQueue("duel", as("solo", app)))).toBeNull();
  });

  test("a refusal arrives as the Worker's own code", async () => {
    const result = await joinRoom("ZZZZ-9999", as("guest"));
    expect(result).toMatchObject({ ok: false, failure: { code: "matchmaking/room_not_found", action: null } });
    const unknownGame = await createRoom("chess", as("host"));
    expect(unknownGame).toMatchObject({ ok: false, failure: { code: "core/not_found" } });
    const anonymous = await listInvites({ fetch: as("x").fetch });
    expect(anonymous).toMatchObject({ ok: false, failure: { code: "auth/invalid_token" } });
  });
});
