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
import { BoardPage, BoardSummary, OwnRank } from "../http/responses";
import { registerLeaderboardRoutes } from "../http/routes";
import { leaderboard_0001_entries } from "../migrations/0001_entries";
import {
  hideEntry,
  type LeaderboardClientOptions,
  type LeaderboardFetch,
  type LeaderboardSession,
  listBoards,
  readAround,
  readOwnRank,
  readSegment,
  readTop,
  removeEntry,
  setVisibility,
  submitScore,
} from "./api";

/**
 * **The client against the real Worker.** Every call goes through the real leaderboard routes on a real D1,
 * and every answer is read back through the client's own guards and then through the server's response
 * schema — so the client and the routes cannot disagree about a shape.
 */

const SUBMIT = "leaderboard:submit";
const ADMIN = "leaderboard:admin";
const CONFIG: LeaderboardConfigInput = { boards: [{ key: "b1", direction: "desc" }] };

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

/** The routes on a Hono app, with `x-user` and `x-scopes` standing in for `@pithy-sh/auth`. */
function makeApp(input: LeaderboardConfigInput = CONFIG) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    const scopes = c.req.header("x-scopes")?.split(",").filter(Boolean) ?? [];
    c.set("auth", user ? { userId: user, sessionId: "s1", scopes } : null);
    await next();
  });
  registerLeaderboardRoutes({ config: LeaderboardConfig.parse(input) })(app);
  return app;
}

/** The client's options for `user`: its fetch is the real app, and the identity rides headers as a bearer would. */
function as(
  app: Hono<PithyHonoEnv>,
  user: string,
  scopes = "",
  session?: LeaderboardSession,
): LeaderboardClientOptions {
  const fetch: LeaderboardFetch = async (url, init) => app.request(url, init as RequestInit, env);
  return { fetch, headers: { "x-user": user, "x-scopes": scopes }, session };
}

/** A successful result's value, held to the server's schema when one is given. */
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

describe("the leaderboard client, against the real routes", () => {
  test("every route round-trips through the client's guards and the server's schemas", async () => {
    const app = makeApp();
    const boards = value(await listBoards(as(app, "u1")));
    expect(boards.map((board) => BoardSummary.parse(board))).toEqual(boards);
    expect(boards.map((board) => board.key)).toEqual(["b1"]);

    // The game server submits, with the submit scope. A session threads the write's bookmark to the read.
    const session: LeaderboardSession = { bookmark: null };
    expect(value(await submitScore("b1", 30, as(app, "u1", SUBMIT, session)))).toBe("all");
    expect(session.bookmark).toBeTruthy();
    for (const [user, score] of [
      ["u2", 20],
      ["u3", 10],
    ] as const) {
      value(await submitScore("b1", score, as(app, user, SUBMIT)));
    }

    const top = value(await readTop("b1", { limit: 2 }, as(app, "u1", "", session)), BoardPage);
    expect(top.entries.map((entry) => entry.userId)).toEqual(["u1", "u2"]);
    const offset = value(await readTop("b1", { offset: 2 }, as(app, "u1")), BoardPage);
    expect(offset.entries.map((entry) => entry.rank)).toEqual([3]);

    const segment = value(await readSegment("b1", { userIds: ["u2", "u3"] }, as(app, "u1")), BoardPage);
    expect(segment.entries.map((entry) => entry.userId)).toEqual(["u2", "u3"]);

    const me = value(await readOwnRank("b1", {}, as(app, "u2")), OwnRank);
    expect(me.score).toBe(20);

    const around = value(await readAround("b1", { radius: 1 }, as(app, "u2")), BoardPage);
    expect(around.entries.map((entry) => entry.userId)).toEqual(["u1", "u2", "u3"]);

    expect(value(await setVisibility("b1", false, {}, as(app, "u2")))).toBe(false);
    expect(value(await hideEntry("b1", "u3", true, {}, as(app, "mod", ADMIN)))).toBe(true);
    const visible = value(await readTop("b1", {}, as(app, "u1")), BoardPage);
    expect(visible.entries.map((entry) => entry.userId)).toEqual(["u1"]);

    expect(value(await removeEntry("b1", "u1", {}, as(app, "mod", ADMIN)))).toBe(true);
    expect(await removeEntry("b1", "u1", {}, as(app, "mod", ADMIN))).toMatchObject({
      ok: false,
      failure: { code: "leaderboard/entry_not_found" },
    });
  });

  test("a refusal arrives as the Worker's own code", async () => {
    const app = makeApp();
    expect(await submitScore("b1", 1, as(app, "u1"))).toMatchObject({
      ok: false,
      failure: { code: "leaderboard/submit_forbidden", action: null },
    });
    expect(await readTop("nope", {}, as(app, "u1"))).toMatchObject({ ok: false });
    expect(await readTop("b1", { limit: 500 }, as(app, "u1"))).toMatchObject({
      ok: false,
      failure: { code: "validation/invalid_input" },
    });
    expect(await hideEntry("b1", "u1", true, {}, as(app, "u1"))).toMatchObject({ ok: false });
  });
});
