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
import { z } from "zod";
import { MULTIPLAYER_MIGRATION_ORDER } from "../capability";
import { MultiplayerConfig, type MultiplayerConfigInput, validateGames } from "../config/config";
import "../game/builtins";
import { type GameModel, registerGameModel } from "../game/model";
import { SessionResult, SessionView } from "../http/responses";
import { registerMultiplayerRoutes } from "../http/routes";
import { multiplayer_0001_results } from "../migrations/0001_results";
import {
  act,
  closeSession,
  createSession,
  joinSession,
  leaveSession,
  type MultiplayerClientOptions,
  type MultiplayerFetch,
  readResult,
  readSession,
} from "./api";

/**
 * **The client against the real Worker.** Every call goes through the real Hono routes, the real session
 * Durable Object and the real D1 result table — the fetch is the app itself, injected. What comes back is
 * narrowed by the client's own hand-written guards, and then parsed by the server's response schemas and
 * required to be the identity: a guard that let through what the schema refuses, or refused what the server
 * sends, fails here.
 */

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

/** A table game with no wagering, so leave and close can be driven without a ledger. */
const lounge: GameModel = {
  kind: "test-client-lounge",
  config: z.object({}).describe("No rules."),
  state: z.object({ seated: z.array(z.string()).describe("Who sat down.") }).describe("The lounge."),
  minPlayers: 1,
  init: (ctx) => ({ seated: [...ctx.players] }),
  apply: (_ctx, state) => ({ state }),
  isComplete: () => false,
  resolve: () => ({ outcome: { scores: {}, winnerUserId: null, draw: true } }),
  redact: (_ctx, state) => state,
};
registerGameModel(lounge);

const CONFIG: MultiplayerConfigInput = {
  games: [
    { key: "tic-tac-toe", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } },
    { key: "lounge", kind: "test-client-lounge", mode: "table", players: 4, rules: {} },
  ],
};

/** The real routes, with a stand-in for `@pithy-sh/auth`: `x-user` sets the player, as a bearer header would. */
function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    c.set("auth", user ? { userId: user, sessionId: "s1", scopes: [] } : null);
    await next();
  });
  registerMultiplayerRoutes({ games: validateGames(MultiplayerConfig.parse(CONFIG)) })(app);
  return app;
}

/** The client's options for one player: the app as its fetch, and their identity as a header. */
function as(user: string, app: Hono<PithyHonoEnv>): MultiplayerClientOptions {
  const send: MultiplayerFetch = async (url, init) =>
    await app.request(url, { method: init?.method, headers: init?.headers, body: init?.body }, env);
  return { fetch: send, headers: { "x-user": user } };
}

/** Unwrap a success, and hold it to the server's own schema. */
function value<T>(result: { ok: true; value: T } | { ok: false; failure: unknown }, schema: z.ZodType): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.failure)}`);
  expect(schema.parse(result.value)).toEqual(result.value);
  return result.value;
}

describe("the multiplayer client, against the real Worker", () => {
  test("a match: create, join, act to a win, read the session and its result", async () => {
    const app = makeApp();
    const alice = as("alice", app);
    const bob = as("bob", app);

    const created = value(await createSession("tic-tac-toe", alice), SessionView);
    expect(created.phase).toBe("open");
    const id = created.sessionId;
    expect(value(await joinSession(id, bob), SessionView).phase).toBe("active");

    // The result is not there while the session is live — a refusal, not a throw.
    const early = await readResult(id, alice);
    expect(!early.ok && early.failure.code).toBe("multiplayer/session_not_found");

    const moves: [MultiplayerClientOptions, number, number][] = [
      [alice, 0, 0],
      [bob, 1, 0],
      [alice, 0, 1],
      [bob, 1, 1],
      [alice, 0, 2],
    ];
    let last = created;
    for (const [player, row, col] of moves) last = value(await act(id, { row, col }, player), SessionView);
    expect(last.phase).toBe("resolved");
    expect(last.outcome?.winnerUserId).toBe("alice");

    expect(value(await readSession(id, bob), SessionView).phase).toBe("resolved");
    const result = value(await readResult(id, bob), SessionResult);
    expect(result.winnerUserId).toBe("alice");
    expect(result.sessionId).toBe(id);
  });

  test("a table: sit, leave, and close", async () => {
    const app = makeApp();
    const alice = as("alice", app);
    const bob = as("bob", app);
    const id = value(await createSession("lounge", alice), SessionView).sessionId;
    expect(value(await joinSession(id, bob), SessionView).players).toEqual(["alice", "bob"]);
    expect(value(await leaveSession(id, bob), SessionView).players).toEqual(["alice"]);
    expect(value(await closeSession(id, alice), SessionView).phase).toBe("resolved");
  });

  test("the Worker's refusals arrive as renderable failures", async () => {
    const app = makeApp();
    const alice = as("alice", app);
    const id = value(await createSession("tic-tac-toe", alice), SessionView).sessionId;
    value(await joinSession(id, as("bob", app)), SessionView);

    const malformed = await act(id, { row: "top" }, alice);
    expect(!malformed.ok && malformed.failure.code).toBe("validation/invalid_input");
    const outOfTurn = await act(id, { row: 0, col: 0 }, as("bob", app));
    expect(!outOfTurn.ok && outOfTurn.failure.code).toBe("multiplayer/invalid_transition");
    const intruder = await act(id, { row: 0, col: 0 }, as("mallory", app));
    expect(!intruder.ok && intruder.failure.code).toBe("multiplayer/not_a_member");
    const unknown = await createSession("chess", alice);
    expect(!unknown.ok && unknown.failure.code).toBe("multiplayer/game_not_found");
    // The server never sends an operator's remedy, so a failure from it carries none.
    expect(!unknown.ok && unknown.failure.action).toBeNull();

    const anonymous = await readSession(id, { fetch: as("x", app).fetch });
    expect(anonymous.ok).toBe(false);
    expect(!anonymous.ok && anonymous.failure.message.length).toBeGreaterThan(0);
  });
});
