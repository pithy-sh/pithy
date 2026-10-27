// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { Hono } from "hono";
import type { MigrationProvider } from "kysely/migration";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { z } from "zod";
import "../algorithm/builtins";
import { RATING_MIGRATION_ORDER } from "../capability";
import { RatingConfig, type RatingConfigInput, validateRatingGames } from "../config/config";
import { ratingStore } from "../data/store";
import { ratingDatabase } from "../data/tables";
import { rating_0001_rating } from "../migrations/0001_rating";
import { rating_0002_outcome_log } from "../migrations/0002_outcome_log";
import {
  RatingAdjustmentResponse,
  RatingAdminPlayerResponse,
  RatingAdminPlayersResponse,
  RatingAdminPoolsResponse,
} from "./responses";
import { registerRatingRoutes } from "./routes";
import { RATING_PLAYERS_ADJUST_SCOPE, RATING_PLAYERS_READ_SCOPE } from "./scopes";

/**
 * The management routes, actually executed: a live control-plane verifier, a capturing audit seam, real D1.
 *
 * `routeContract.test.ts` proves every guard runs by calling with no credential. What survives only here:
 * a connection granted the wrong scope is refused, the keyset paging by skill, the projections against
 * their schemas, the replay that emits nothing, and the reason refused before anything is written.
 */

const NOW = new Date("2026-10-20T12:00:00.000Z");
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const ISSUER = "https://dashboard.example";
const KEY_ID = "key-1";
const ENVIRONMENT = "prod";

const CONFIG: RatingConfigInput = {
  games: [
    { key: "duel", algorithm: "elo", xp: { win: 20, draw: 10, loss: 5 } },
    { key: "ranked", algorithm: "elo", pool: "duel", hideSkill: true },
    { key: "brawl", algorithm: "trueskill", players: 3 },
  ],
};

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "rating",
      order: RATING_MIGRATION_ORDER,
      migrations: { "0001_rating": rating_0001_rating, "0002_outcome_log": rating_0002_outcome_log },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error("no app provider");
  return found;
}

beforeEach(async () => {
  emitted = [];
  for (const table of [
    "pithy_rating_ratings",
    "pithy_rating_outcomes",
    "pithy_rating_outcome_players",
    "pithy_rating_adjustments",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  await runMigrations(env.DB, provider());
});

async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: ISSUER,
    workerUrl: "https://acme.example",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: "ada@example.com",
    actorKind: "dashboard",
    purpose: "The hosted dashboard.",
    scopes: [...scopes],
    keys: [
      {
        keyId: KEY_ID,
        publicKey: await exportPublicJwk(keys.publicKey),
        validFrom: new Date(NOW.getTime() - 86_400_000),
        validUntil: null,
        revokedAt: null,
      },
    ],
    createdAt: new Date(NOW.getTime() - 86_400_000),
    updatedAt: new Date(NOW.getTime() - 86_400_000),
  };
}

function verifier(scopes: readonly ControlPlaneScope[]): ControlPlaneVerifier {
  const registered = connection(scopes);
  const spent = new Set<string>();
  return createControlPlaneVerifier({
    loadConnection: async (id) => {
      const row = await registered;
      return id === row.id ? row : null;
    },
    countConnections: async () => 1,
    replay: {
      async claim(jti) {
        if (spent.has(jti)) return false;
        spent.add(jti);
        return true;
      },
    },
    environment: ENVIRONMENT,
    config: ControlPlaneConfig.parse({}),
    now: () => NOW,
  });
}

/** The app, with a live verifier granting `granted`, a capturing audit seam, and a stand-in for auth. */
function makeApp(granted: readonly ControlPlaneScope[] = [RATING_PLAYERS_READ_SCOPE, RATING_PLAYERS_ADJUST_SCOPE]) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(granted);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    c.set("auth", user ? { userId: user, sessionId: "s1", scopes: ["rating:record"] } : null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    await next();
  });
  const config = RatingConfig.parse(CONFIG);
  registerRatingRoutes({ games: validateRatingGames(config), config })(app);
  return app;
}

/** One request carrying a token minted for `scope` over these exact bytes. */
async function send(
  app: Hono<PithyHonoEnv>,
  method: "GET" | "POST",
  path: string,
  scope: ControlPlaneScope,
  body?: unknown,
): Promise<Response> {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    body: raw === undefined ? undefined : new TextEncoder().encode(raw),
    now: () => NOW,
  });
  return app.request(
    `http://x${path}`,
    { method, headers: { "content-type": "application/json", [CONTROL_PLANE_HEADER]: token }, body: raw },
    { ...env, ENVIRONMENT },
  );
}

/** Record an outcome through the player route, as the adopter's backend does. */
async function record(app: Hono<PithyHonoEnv>, game: string, ranks: Record<string, number>, resultId?: string) {
  const response = await app.request(
    `http://x/rating/games/${game}/outcomes`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-user": "server" },
      body: JSON.stringify({ ranks, ...(resultId ? { resultId } : {}) }),
    },
    env,
  );
  expect(response.status).toBe(201);
}

/** Read a response through its schema, and require the parse to hand back exactly what arrived. */
async function conforming<Schema extends z.ZodType>(res: Response, schema: Schema): Promise<z.infer<Schema>> {
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  expect(schema.parse(body)).toEqual(body);
  return body as z.infer<Schema>;
}

/**
 * The events rating emitted. The control-plane guard audits every verified call and every denial on its own
 * account; those are the seam's, and what is asserted here is what rating itself said.
 */
const ratingEvents = () => emitted.filter((event) => event.action.startsWith("rating/"));

const adjust = (key: string, reason = "Dispute 118: the match was replayed.") => ({ idempotencyKey: key, reason });

describe("rating's control-plane reads", () => {
  test("lists every pool with its algorithm and the games that rate it", async () => {
    const body = await conforming(
      await send(makeApp(), "GET", "/rating/admin/pools", RATING_PLAYERS_READ_SCOPE),
      RatingAdminPoolsResponse,
    );
    expect(body.pools).toEqual([
      { pool: "duel", algorithm: "elo", games: ["duel", "ranked"] },
      { pool: "brawl", algorithm: "trueskill", games: ["brawl"] },
    ]);
  });

  test("pages the ratings in a pool by skill, highest first, with ties broken and nothing repeated", async () => {
    const app = makeApp();
    await record(app, "duel", { ada: 1, bob: 2 });
    await record(app, "duel", { cy: 1, dan: 2 });
    await record(app, "duel", { eve: 1, fay: 2 });
    await record(app, "duel", { ada: 1, cy: 2 });

    const seen: { userId: string; skill: number }[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const page = await conforming(
        await send(app, "GET", `/rating/admin/pools/duel/players${query}`, RATING_PLAYERS_READ_SCOPE),
        RatingAdminPlayersResponse,
      );
      expect(page.players.length).toBeLessThanOrEqual(2);
      seen.push(...page.players.map(({ userId, skill }) => ({ userId, skill })));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen.map((row) => row.userId).sort()).toEqual(["ada", "bob", "cy", "dan", "eve", "fay"]);
    const skills = seen.map((row) => row.skill);
    expect(skills).toEqual([...skills].sort((a, b) => b - a));
    // `ranked` hides skill from players. An operator still sees it.
    expect(seen.every((row) => typeof row.skill === "number")).toBe(true);
  });

  test("reads one player's rating and their outcomes, newest first, paged", async () => {
    const app = makeApp();
    await record(app, "duel", { ada: 1, bob: 2 }, "match-1");
    await record(app, "duel", { bob: 1, ada: 2 }, "match-2");
    await record(app, "duel", { ada: 1, bob: 1 });

    const first = await conforming(
      await send(app, "GET", "/rating/admin/pools/duel/players/ada?limit=2", RATING_PLAYERS_READ_SCOPE),
      RatingAdminPlayerResponse,
    );
    expect(first.rating).toMatchObject({ pool: "duel", userId: "ada", algorithm: "elo", games: 3, xp: 35 });
    expect(first.outcomes.map((outcome) => outcome.resultId)).toEqual([null, "match-2"]);
    expect(first.outcomes[1]).toMatchObject({ game: "duel", rank: 2, voided: false, gamesBefore: 1, xpGained: 5 });
    expect(first.nextCursor).not.toBeNull();

    const second = await conforming(
      await send(
        app,
        "GET",
        `/rating/admin/pools/duel/players/ada?limit=2&cursor=${first.nextCursor}`,
        RATING_PLAYERS_READ_SCOPE,
      ),
      RatingAdminPlayerResponse,
    );
    expect(second.outcomes.map((outcome) => outcome.resultId)).toEqual(["match-1"]);
    expect(second.outcomes[0]).toMatchObject({ skillBefore: 1500, xpBefore: 0, gamesBefore: 0 });
    expect(second.nextCursor).toBeNull();
  });

  test("a player who has not played the pool reads as no rating, not a 404", async () => {
    const body = await conforming(
      await send(makeApp(), "GET", "/rating/admin/pools/duel/players/nobody", RATING_PLAYERS_READ_SCOPE),
      RatingAdminPlayerResponse,
    );
    expect(body).toEqual({ pool: "duel", userId: "nobody", rating: null, outcomes: [], nextCursor: null });
  });

  test("a pool no game rates is the capability's 404", async () => {
    const response = await send(makeApp(), "GET", "/rating/admin/pools/nowhere/players", RATING_PLAYERS_READ_SCOPE);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("rating/pool_not_found");
  });

  test("the reads emit no audit event", async () => {
    await send(makeApp(), "GET", "/rating/admin/pools", RATING_PLAYERS_READ_SCOPE);
    expect(ratingEvents()).toEqual([]);
  });
});

describe("rating's control-plane acts", () => {
  test("recalculate answers with the rating before and after, and emits one audit event", async () => {
    const app = makeApp();
    await record(app, "duel", { ada: 1, bob: 2 });
    const live = await ratingStore(ratingDatabase(env.DB)).get("duel", "ada");

    const body = await conforming(
      await send(
        app,
        "POST",
        "/rating/admin/pools/duel/players/ada/recalculate",
        RATING_PLAYERS_ADJUST_SCOPE,
        adjust("k-1"),
      ),
      RatingAdjustmentResponse,
    );
    expect(body).toMatchObject({
      pool: "duel",
      userId: "ada",
      act: "recalculate",
      reason: "Dispute 118: the match was replayed.",
      replayed: false,
    });
    expect(body.after.skill).toBe(live?.skill);
    expect(body.before?.skill).toBe(live?.skill);

    expect(ratingEvents()).toHaveLength(1);
    expect(ratingEvents()[0]).toMatchObject({
      action: "rating/player_recalculated",
      outcome: "success",
      severity: "warning",
      actorType: "control-plane",
      actorId: "operator-1",
      resourceType: "rating",
      resourceId: "duel:ada",
      metadata: {
        connectionId: CONNECTION_ID,
        pool: "duel",
        userId: "ada",
        act: "recalculate",
        reason: "Dispute 118: the match was replayed.",
        before: body.before,
        after: body.after,
      },
    });
  });

  test("reset keeps the prior rating on the audit event", async () => {
    const app = makeApp();
    await record(app, "duel", { ada: 1, bob: 2 });
    const prior = await ratingStore(ratingDatabase(env.DB)).get("duel", "ada");

    const body = await conforming(
      await send(app, "POST", "/rating/admin/pools/duel/players/ada/reset", RATING_PLAYERS_ADJUST_SCOPE, adjust("k-2")),
      RatingAdjustmentResponse,
    );
    expect(body.after).toEqual({ algorithm: "elo", state: { rating: 1500 }, skill: 1500, xp: 20, games: 1 });
    expect(ratingEvents()).toHaveLength(1);
    expect(ratingEvents()[0]?.action).toBe("rating/player_reset");
    expect(ratingEvents()[0]?.metadata).toMatchObject({ before: { skill: prior?.skill, state: prior?.state } });
  });

  test("a replayed key changes nothing and emits nothing", async () => {
    const app = makeApp();
    await record(app, "duel", { ada: 1, bob: 2 });
    const path = "/rating/admin/pools/duel/players/ada/reset";
    const first = await conforming(
      await send(app, "POST", path, RATING_PLAYERS_ADJUST_SCOPE, adjust("k-3")),
      RatingAdjustmentResponse,
    );
    const second = await conforming(
      await send(app, "POST", path, RATING_PLAYERS_ADJUST_SCOPE, adjust("k-3")),
      RatingAdjustmentResponse,
    );

    expect(second).toEqual({ ...first, replayed: true });
    expect(ratingEvents()).toHaveLength(1);
  });

  test("a missing or blank reason is refused before anything is written", async () => {
    const app = makeApp();
    await record(app, "duel", { ada: 1, bob: 2 });
    const before = await ratingStore(ratingDatabase(env.DB)).get("duel", "ada");
    const path = "/rating/admin/pools/duel/players/ada/reset";
    for (const body of [{ idempotencyKey: "k-4" }, { idempotencyKey: "k-4", reason: "   " }, { reason: "why" }]) {
      const response = await send(app, "POST", path, RATING_PLAYERS_ADJUST_SCOPE, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await ratingStore(ratingDatabase(env.DB)).get("duel", "ada")).toEqual(before);
    const adjustments = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_rating_adjustments").first<{
      n: number;
    }>();
    expect(adjustments?.n).toBe(0);
    expect(ratingEvents()).toEqual([]);
  });

  test("recalculating a rating with no logged outcomes is refused, naming why, and emits nothing", async () => {
    await ratingStore(ratingDatabase(env.DB)).upsert({
      id: 0,
      pool: "duel",
      userId: "veteran",
      algorithm: "elo",
      state: { rating: 1720 },
      skill: 1720,
      xp: 300,
      games: 40,
      updatedAt: NOW,
    });
    const response = await send(
      makeApp(),
      "POST",
      "/rating/admin/pools/duel/players/veteran/recalculate",
      RATING_PLAYERS_ADJUST_SCOPE,
      adjust("k-5"),
    );
    expect(response.status).toBe(409);
    const error = ((await response.json()) as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("core/conflict");
    expect(error.message).toMatch(/predates its history/);
    expect(ratingEvents()).toEqual([]);
  });
});

describe("a connection without the scope is refused", () => {
  test("a read-only connection cannot act, and an adjust-only connection cannot read", async () => {
    const readOnly = makeApp([RATING_PLAYERS_READ_SCOPE]);
    await record(readOnly, "duel", { ada: 1, bob: 2 });
    const act = await send(
      readOnly,
      "POST",
      "/rating/admin/pools/duel/players/ada/reset",
      RATING_PLAYERS_ADJUST_SCOPE,
      adjust("k-6"),
    );
    expect(act.status).toBe(403);

    const adjustOnly = makeApp([RATING_PLAYERS_ADJUST_SCOPE]);
    expect((await send(adjustOnly, "GET", "/rating/admin/pools", RATING_PLAYERS_READ_SCOPE)).status).toBe(403);
    expect(ratingEvents()).toEqual([]);
  });

  test("a token minted for the read scope cannot act, even on a connection granted both", async () => {
    const app = makeApp();
    await record(app, "duel", { ada: 1, bob: 2 });
    const response = await send(
      app,
      "POST",
      "/rating/admin/pools/duel/players/ada/reset",
      RATING_PLAYERS_READ_SCOPE,
      adjust("k-7"),
    );
    expect(response.status).toBe(403);
  });
});
