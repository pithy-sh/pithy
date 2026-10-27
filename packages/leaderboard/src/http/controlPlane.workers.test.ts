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
import { LEADERBOARD_MIGRATION_ORDER } from "../capability";
import { LeaderboardBoard, LeaderboardConfig, type LeaderboardConfigInput } from "../config/config";
import { LeaderboardModeration } from "../data/moderation";
import { LEADERBOARD_LOCKS_TABLE, LEADERBOARD_MODERATIONS_TABLE, leaderboardDatabase } from "../data/tables";
import { submitResult } from "../entry/result";
import { entryStore } from "../entry/store";
import { LEADERBOARD_MIGRATIONS } from "../migrations/all";
import { acquireRefreshLock } from "../rank/lock";
import {
  AdminBoardList,
  AdminEntriesPage,
  AdminLockClearResult,
  AdminLockList,
  AdminModerationResult,
} from "./responses";
import { registerLeaderboardRoutes } from "./routes";
import { LEADERBOARD_ENTRIES_MODERATE_SCOPE, LEADERBOARD_ENTRIES_READ_SCOPE } from "./scopes";

/**
 * The management surface (#817), actually executed through a verified control-plane token.
 *
 * `routeContract.test.ts` proves each guard runs and nothing else; every handler body is unreached there.
 * What survives only here: the reads' projections and keyset paging, the acts' idempotency, the reason
 * required before anything is written, the history row, the one audit event, and the refusals.
 */

const NOW = new Date("2026-06-10T12:00:00.000Z");
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const CONTROL_PLANE_ISSUER = "https://dashboard.example";
const CONTROL_PLANE_KEY_ID = "key-1";
const ENVIRONMENT = "prod";
const BOTH = [LEADERBOARD_ENTRIES_READ_SCOPE, LEADERBOARD_ENTRIES_MODERATE_SCOPE];

const CONFIG: LeaderboardConfigInput = {
  boards: [
    { key: "high", direction: "desc", min: 0, max: 1000 },
    { key: "points", direction: "desc", aggregation: "sum" },
    { key: "daily", direction: "asc", window: "0 0 * * *" },
  ],
};
const high = LeaderboardBoard.parse(CONFIG.boards[0]);
const points = LeaderboardBoard.parse(CONFIG.boards[1]);

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  return {
    id: CONNECTION_ID,
    environment: ENVIRONMENT,
    issuer: CONTROL_PLANE_ISSUER,
    workerUrl: "https://acme.example",
    basePath: "/control-plane",
    managementOrigin: null,
    authorizedBy: "ada@example.com",
    actorKind: "dashboard",
    purpose: "The hosted dashboard.",
    scopes: [...scopes],
    keys: [
      {
        keyId: CONTROL_PLANE_KEY_ID,
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

/** The app, with a live control-plane verifier and a capturing audit seam. */
function makeApp(scopes: readonly ControlPlaneScope[] = BOTH, config: LeaderboardConfigInput = CONFIG) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(scopes);
  app.use("*", async (c, next) => {
    c.set("auth", null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    await next();
  });
  registerLeaderboardRoutes({ config: LeaderboardConfig.parse(config), now: () => NOW })(app);
  return app;
}

/** A request carrying a freshly minted, body-bound control-plane token. */
async function call(
  app: Hono<PithyHonoEnv>,
  method: string,
  path: string,
  scope: ControlPlaneScope,
  body?: unknown,
): Promise<Response> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: CONTROL_PLANE_KEY_ID,
    issuer: CONTROL_PLANE_ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    body: payload === undefined ? undefined : new TextEncoder().encode(payload),
    now: () => NOW,
  });
  return app.request(
    `http://x${path}`,
    { method, headers: { "content-type": "application/json", [CONTROL_PLANE_HEADER]: token }, body: payload },
    { ...env, ENVIRONMENT },
  );
}

const read = (app: Hono<PithyHonoEnv>, path: string) => call(app, "GET", path, LEADERBOARD_ENTRIES_READ_SCOPE);
const act = (app: Hono<PithyHonoEnv>, path: string, body: unknown) =>
  call(app, "POST", path, LEADERBOARD_ENTRIES_MODERATE_SCOPE, body);

/** The leaderboard's own events. The guard records every allowed call too, as `controlplane/call_allowed`. */
const acts = () => emitted.filter((event) => event.action.startsWith("leaderboard/"));

const errorCode = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "leaderboard",
      order: LEADERBOARD_MIGRATION_ORDER,
      migrations: LEADERBOARD_MIGRATIONS,
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const db = () => leaderboardDatabase(env.DB);
const store = () => entryStore(db());
const at = (ms: number) => new Date(NOW.getTime() - 3_600_000 + ms);

async function history(): Promise<LeaderboardModeration[]> {
  const rows = await db().selectFrom(LEADERBOARD_MODERATIONS_TABLE).selectAll().orderBy("id").execute();
  return rows.map((row) => LeaderboardModeration.parse(row));
}

beforeEach(async () => {
  for (const t of [
    "pithy_leaderboard_stale_windows",
    "pithy_leaderboard_moderations",
    "pithy_leaderboard_contributions",
    "pithy_leaderboard_entries",
    "pithy_leaderboard_boards",
    "pithy_leaderboard_locks",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await runMigrations(env.DB, provider());
  emitted = [];
});

describe("GET /leaderboard/admin/boards", () => {
  test("lists every board with the window open now", async () => {
    const response = await read(makeApp(), "/leaderboard/admin/boards");
    expect(response.status).toBe(200);
    const body = AdminBoardList.parse(await response.json());
    expect(body.boards).toEqual([
      {
        key: "high",
        store: "d1",
        direction: "desc",
        aggregation: "best",
        window: null,
        currentWindow: "all",
        min: 0,
        max: 1000,
        rank: "live",
      },
      {
        key: "points",
        store: "d1",
        direction: "desc",
        aggregation: "sum",
        window: null,
        currentWindow: "all",
        min: null,
        max: null,
        rank: "live",
      },
      {
        key: "daily",
        store: "d1",
        direction: "asc",
        aggregation: "best",
        window: "0 0 * * *",
        currentWindow: "2026-06-10T00:00:00.000Z",
        min: null,
        max: null,
        rank: "live",
      },
    ]);
  });

  test("names a materialized board's rank mode", async () => {
    const response = await read(
      makeApp(BOTH, { ...CONFIG, rank: { materialize: "0 * * * *" } }),
      "/leaderboard/admin/boards",
    );
    const body = AdminBoardList.parse(await response.json());
    expect(body.boards.map((b) => b.rank)).toEqual(["materialized", "materialized", "materialized"]);
  });

  test("is not audited — a read emits nothing", async () => {
    await read(makeApp(), "/leaderboard/admin/boards");
    expect(acts()).toEqual([]);
  });
});

describe("GET /leaderboard/admin/boards/:board/entries", () => {
  async function seed() {
    await store().submit(high, "all", "ann", 50, at(1), true);
    await store().submit(high, "all", "bob", 90, at(2), true);
    await store().submit(high, "all", "cat", 70, at(3), true);
    await store().submit(high, "all", "dan", 60, at(4), true);
    await store().hide("high", "all", "cat", true);
    await store().setVisibility("high", "all", "dan", false);
  }

  test("ranks visible entries live and shows hidden ones in place with no rank", async () => {
    await seed();
    const response = await read(makeApp(), "/leaderboard/admin/boards/high/entries");
    expect(response.status).toBe(200);
    const body = AdminEntriesPage.parse(await response.json());
    expect(body.board).toBe("high");
    expect(body.window).toBe("all");
    expect(body.nextCursor).toBeNull();
    expect(body.entries.map((e) => [e.userId, e.score, e.rank, e.hidden, e.visible])).toEqual([
      ["bob", 90, 1, false, true],
      ["cat", 70, null, true, true],
      ["dan", 60, null, false, false],
      ["ann", 50, 2, false, true],
    ]);
    expect(body.entries[0]).toEqual({
      userId: "bob",
      score: 90,
      rank: 1,
      achievedAt: at(2).toISOString(),
      submittedAt: at(2).toISOString(),
      visible: true,
      hidden: false,
      resultId: null,
    });
  });

  test("pages by keyset, and the second page keeps counting rank where the first stopped", async () => {
    await seed();
    const app = makeApp();
    const first = AdminEntriesPage.parse(
      await (await read(app, "/leaderboard/admin/boards/high/entries?limit=1")).json(),
    );
    expect(first.entries.map((e) => e.userId)).toEqual(["bob"]);
    expect(first.nextCursor).not.toBeNull();

    // A score landing between the pages would shift an offset; a keyset resumes after bob regardless.
    await store().submit(high, "all", "eve", 99, at(5), true);

    const second = AdminEntriesPage.parse(
      await (await read(app, `/leaderboard/admin/boards/high/entries?limit=3&cursor=${first.nextCursor}`)).json(),
    );
    expect(second.entries.map((e) => [e.userId, e.rank])).toEqual([
      ["cat", null],
      ["dan", null],
      ["ann", 3],
    ]);
    expect(second.nextCursor).toBeNull();
  });

  test("filters to one player, or to hidden entries", async () => {
    await seed();
    const app = makeApp();
    const one = AdminEntriesPage.parse(
      await (await read(app, "/leaderboard/admin/boards/high/entries?userId=ann")).json(),
    );
    expect(one.entries.map((e) => [e.userId, e.rank])).toEqual([["ann", 2]]);
    const hidden = AdminEntriesPage.parse(
      await (await read(app, "/leaderboard/admin/boards/high/entries?hidden=true")).json(),
    );
    expect(hidden.entries.map((e) => e.userId)).toEqual(["cat"]);
  });

  test("names the result that wrote an entry", async () => {
    await submitResult(env.DB, {
      board: points,
      windowKey: "all",
      userId: "ann",
      score: 3,
      at: at(1),
      visibleByDefault: true,
      resultId: "session-1",
    });
    const body = AdminEntriesPage.parse(
      await (await read(makeApp(), "/leaderboard/admin/boards/points/entries")).json(),
    );
    expect(body.entries[0]?.resultId).toBe("session-1");
  });

  test("reads a named window, and the open one by default", async () => {
    const daily = LeaderboardBoard.parse(CONFIG.boards[2]);
    await store().submit(daily, "2026-06-09T00:00:00.000Z", "ann", 30, at(1), true);
    await store().submit(daily, "2026-06-10T00:00:00.000Z", "bob", 40, at(2), true);
    const app = makeApp();
    const open = AdminEntriesPage.parse(await (await read(app, "/leaderboard/admin/boards/daily/entries")).json());
    expect(open.entries.map((e) => e.userId)).toEqual(["bob"]);
    const closed = AdminEntriesPage.parse(
      await (await read(app, "/leaderboard/admin/boards/daily/entries?window=2026-06-09T00:00:00.000Z")).json(),
    );
    expect(closed.entries.map((e) => e.userId)).toEqual(["ann"]);
  });

  test("an unconfigured board is the capability's own 404", async () => {
    const response = await read(makeApp(), "/leaderboard/admin/boards/nope/entries");
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("leaderboard/board_not_found");
  });
});

describe("GET /leaderboard/admin/locks", () => {
  test("is empty when no refresh holds the lock", async () => {
    const body = AdminLockList.parse(await (await read(makeApp(), "/leaderboard/admin/locks")).json());
    expect(body.locks).toEqual([]);
  });

  test("names the holder and when it took the lock", async () => {
    await acquireRefreshLock(db(), "instance-7", at(0));
    const body = AdminLockList.parse(await (await read(makeApp(), "/leaderboard/admin/locks")).json());
    expect(body.locks).toEqual([{ name: "rank-refresh", holder: "instance-7", acquiredAt: at(0).toISOString() }]);
  });
});

describe("scopes", () => {
  test("a connection without the read scope is refused the reads", async () => {
    const response = await read(makeApp([LEADERBOARD_ENTRIES_MODERATE_SCOPE]), "/leaderboard/admin/boards");
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/insufficient_scope");
  });

  test("a connection holding only the read scope cannot moderate", async () => {
    await store().submit(high, "all", "ann", 50, at(1), true);
    const response = await act(
      makeApp([LEADERBOARD_ENTRIES_READ_SCOPE]),
      "/leaderboard/admin/boards/high/entries/ann/hide",
      {
        idempotencyKey: "k1",
        reason: "Cheating.",
      },
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("controlplane/insufficient_scope");
    expect((await store().get("high", "all", "ann"))?.hidden).toBe(false);
    expect(await history()).toEqual([]);
  });
});

describe("POST …/entries/:userId/hide and /unhide", () => {
  const hide = "/leaderboard/admin/boards/high/entries/ann/hide";
  const unhide = "/leaderboard/admin/boards/high/entries/ann/unhide";

  beforeEach(async () => {
    await store().submit(high, "all", "ann", 50, at(1), true);
  });

  test("hides an entry, records it, and emits one audit event with everything a reviewer needs", async () => {
    const response = await act(makeApp(), hide, { idempotencyKey: "k1", reason: "Impossible run." });
    expect(response.status).toBe(200);
    const body = AdminModerationResult.parse(await response.json());
    expect(body).toEqual({
      act: "hide",
      board: "high",
      window: "all",
      userId: "ann",
      before: { score: 50, visible: true, hidden: false },
      after: { score: 50, visible: true, hidden: true },
      reason: "Impossible run.",
      changed: true,
      replayed: false,
      ranks: "live",
    });
    expect((await store().get("high", "all", "ann"))?.hidden).toBe(true);

    expect(acts()).toEqual([
      expect.objectContaining({
        action: "leaderboard/entry_hidden",
        outcome: "success",
        actorType: "control-plane",
        actorId: "operator-1",
        resourceType: "leaderboard_entry",
        resourceId: "high:all:ann",
        metadata: {
          connectionId: CONNECTION_ID,
          board: "high",
          window: "all",
          userId: "ann",
          act: "hide",
          before: { score: 50, visible: true, hidden: false },
          after: { score: 50, visible: true, hidden: true },
          reason: "Impossible run.",
        },
      }),
    ]);

    const [row] = await history();
    expect(row).toMatchObject({
      idempotencyKey: "k1",
      act: "hide",
      boardId: "high",
      windowKey: "all",
      userId: "ann",
      reason: "Impossible run.",
      changed: true,
      connectionId: CONNECTION_ID,
      actorId: "operator-1",
      createdAt: NOW,
    });
  });

  test("a replay changes nothing and emits nothing, and answers what the first request did", async () => {
    const app = makeApp();
    await act(app, hide, { idempotencyKey: "k1", reason: "Impossible run." });
    // Unhidden by somebody else since: a replay of the hide must not hide it again.
    await act(app, unhide, { idempotencyKey: "k2", reason: "Appeal upheld." });
    emitted = [];

    const replay = await act(app, hide, { idempotencyKey: "k1", reason: "Impossible run." });

    expect(replay.status).toBe(200);
    const body = AdminModerationResult.parse(await replay.json());
    expect(body.replayed).toBe(true);
    expect(body.after.hidden).toBe(true);
    expect((await store().get("high", "all", "ann"))?.hidden).toBe(false);
    expect(acts()).toEqual([]);
    expect(await history()).toHaveLength(2);
  });

  test("the same key on a different act is refused", async () => {
    const app = makeApp();
    await act(app, hide, { idempotencyKey: "k1", reason: "Impossible run." });
    const response = await act(app, unhide, { idempotencyKey: "k1", reason: "Appeal upheld." });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("core/conflict");
    expect((await store().get("high", "all", "ann"))?.hidden).toBe(true);
  });

  test("a missing or blank reason is refused before anything is written", async () => {
    const app = makeApp();
    for (const body of [{ idempotencyKey: "k1" }, { idempotencyKey: "k1", reason: "   " }]) {
      const response = await act(app, hide, body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("validation/invalid_input");
    }
    expect((await store().get("high", "all", "ann"))?.hidden).toBe(false);
    expect(await history()).toEqual([]);
    expect(acts()).toEqual([]);
  });

  test("a missing idempotency key is refused", async () => {
    const response = await act(makeApp(), hide, { reason: "Impossible run." });
    expect(response.status).toBe(400);
  });

  test("hiding a hidden entry changes nothing and emits nothing, and keeps its key", async () => {
    const app = makeApp();
    await act(app, hide, { idempotencyKey: "k1", reason: "Impossible run." });
    emitted = [];
    const again = AdminModerationResult.parse(
      await (await act(app, hide, { idempotencyKey: "k2", reason: "Still impossible." })).json(),
    );
    expect(again.changed).toBe(false);
    expect(acts()).toEqual([]);
    expect((await history()).map((row) => [row.idempotencyKey, row.changed])).toEqual([
      ["k1", true],
      ["k2", false],
    ]);
  });

  test("unhide puts the entry back on the board, and its rank returns", async () => {
    const app = makeApp();
    await act(app, hide, { idempotencyKey: "k1", reason: "Impossible run." });
    const body = AdminModerationResult.parse(
      await (await act(app, unhide, { idempotencyKey: "k2", reason: "Appeal upheld." })).json(),
    );
    expect(body.after.hidden).toBe(false);
    expect(acts().map((e) => e.action)).toEqual(["leaderboard/entry_hidden", "leaderboard/entry_unhidden"]);
    const page = AdminEntriesPage.parse(await (await read(app, "/leaderboard/admin/boards/high/entries")).json());
    expect(page.entries[0]?.rank).toBe(1);
  });

  test("an entry that does not exist is a 404, and nothing is recorded", async () => {
    const response = await act(makeApp(), "/leaderboard/admin/boards/high/entries/nobody/hide", {
      idempotencyKey: "k1",
      reason: "Impossible run.",
    });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("leaderboard/entry_not_found");
    expect(await history()).toEqual([]);
  });

  test("on a materialized board the stored rank is cleared for the next refresh pass", async () => {
    await env.DB.exec("UPDATE pithy_leaderboard_entries SET rank = 1");
    const app = makeApp(BOTH, { ...CONFIG, rank: { materialize: "0 * * * *" } });
    const body = AdminModerationResult.parse(
      await (await act(app, hide, { idempotencyKey: "k1", reason: "Impossible run." })).json(),
    );
    expect(body.ranks).toBe("next-refresh");
    expect((await store().get("high", "all", "ann"))?.rank).toBeNull();
  });
});

describe("POST …/entries/:userId/correct", () => {
  const correct = "/leaderboard/admin/boards/high/entries/ann/correct";

  beforeEach(async () => {
    await store().submit(high, "all", "ann", 900, at(1), true);
    await store().submit(high, "all", "bob", 80, at(2), true);
  });

  test("keeps the original on the audit event and in the history, and the ranks recompute", async () => {
    const app = makeApp();
    const response = await act(app, correct, { idempotencyKey: "k1", score: 40, reason: "Clock exploit." });
    expect(response.status).toBe(200);
    const body = AdminModerationResult.parse(await response.json());
    expect(body.before.score).toBe(900);
    expect(body.after.score).toBe(40);

    expect(acts()).toHaveLength(1);
    expect(acts()[0]?.action).toBe("leaderboard/entry_corrected");
    expect(acts()[0]?.metadata).toMatchObject({
      before: { score: 900 },
      after: { score: 40 },
      reason: "Clock exploit.",
    });

    const [row] = await history();
    expect(row?.before).toEqual({ kind: "entry", score: 900, visible: true, hidden: false });
    expect(row?.after).toEqual({ kind: "entry", score: 40, visible: true, hidden: false });

    const page = AdminEntriesPage.parse(await (await read(app, "/leaderboard/admin/boards/high/entries")).json());
    expect(page.entries.map((e) => [e.userId, e.rank])).toEqual([
      ["bob", 1],
      ["ann", 2],
    ]);
  });

  test("a replay with the same key and score answers again; with another score it is refused", async () => {
    const app = makeApp();
    await act(app, correct, { idempotencyKey: "k1", score: 40, reason: "Clock exploit." });
    const replay = AdminModerationResult.parse(
      await (await act(app, correct, { idempotencyKey: "k1", score: 40, reason: "Clock exploit." })).json(),
    );
    expect(replay.replayed).toBe(true);
    expect(acts()).toHaveLength(1);

    const other = await act(app, correct, { idempotencyKey: "k1", score: 41, reason: "Clock exploit." });
    expect(other.status).toBe(409);
    expect((await store().get("high", "all", "ann"))?.score).toBe(40);
  });

  test("is held to the board's bounds, as a submission is", async () => {
    const response = await act(makeApp(), correct, { idempotencyKey: "k1", score: 5000, reason: "Typo." });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("leaderboard/score_rejected");
    expect((await store().get("high", "all", "ann"))?.score).toBe(900);
    expect(await history()).toEqual([]);
  });

  test("a missing score is refused", async () => {
    const response = await act(makeApp(), correct, { idempotencyKey: "k1", reason: "Typo." });
    expect(response.status).toBe(400);
  });
});

describe("POST /leaderboard/admin/locks/:name/clear", () => {
  const clear = "/leaderboard/admin/locks/rank-refresh/clear";

  test("clears the lock the operator saw, records it, and emits one event", async () => {
    await acquireRefreshLock(db(), "instance-7", at(0));
    const response = await act(makeApp(), clear, { idempotencyKey: "k1", holder: "instance-7", reason: "Crashed." });
    expect(response.status).toBe(200);
    const body = AdminLockClearResult.parse(await response.json());
    expect(body).toEqual({
      lock: { name: "rank-refresh", holder: "instance-7", acquiredAt: at(0).toISOString() },
      reason: "Crashed.",
      replayed: false,
    });
    expect(await db().selectFrom(LEADERBOARD_LOCKS_TABLE).selectAll().execute()).toEqual([]);
    expect(acts()).toEqual([
      expect.objectContaining({
        action: "leaderboard/lock_cleared",
        actorType: "control-plane",
        resourceType: "leaderboard_lock",
        resourceId: "rank-refresh",
        metadata: expect.objectContaining({ connectionId: CONNECTION_ID, act: "clear_lock", reason: "Crashed." }),
      }),
    ]);
    expect((await history()).map((row) => [row.act, row.lockName, row.after])).toEqual([
      ["clear_lock", "rank-refresh", null],
    ]);
  });

  test("a replay changes nothing and emits nothing, even once a new refresh holds the lock", async () => {
    const app = makeApp();
    await acquireRefreshLock(db(), "instance-7", at(0));
    await act(app, clear, { idempotencyKey: "k1", holder: "instance-7", reason: "Crashed." });
    await acquireRefreshLock(db(), "instance-8", at(10));
    emitted = [];

    const replay = AdminLockClearResult.parse(
      await (await act(app, clear, { idempotencyKey: "k1", holder: "instance-7", reason: "Crashed." })).json(),
    );

    expect(replay.replayed).toBe(true);
    expect(acts()).toEqual([]);
    const held = await db().selectFrom(LEADERBOARD_LOCKS_TABLE).select("holder").execute();
    expect(held).toEqual([{ holder: "instance-8" }]);
  });

  test("a lock that changed hands is refused, so a live refresh is never cleared", async () => {
    await acquireRefreshLock(db(), "instance-8", at(0));
    const response = await act(makeApp(), clear, { idempotencyKey: "k1", holder: "instance-7", reason: "Crashed." });
    expect(response.status).toBe(409);
    expect(await db().selectFrom(LEADERBOARD_LOCKS_TABLE).select("holder").execute()).toEqual([
      { holder: "instance-8" },
    ]);
    expect(acts()).toEqual([]);
  });

  test("a lock nobody holds is a 404", async () => {
    const response = await act(makeApp(), clear, { idempotencyKey: "k1", holder: "instance-7", reason: "Crashed." });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("core/not_found");
  });

  test("a missing reason or holder is refused before anything is written", async () => {
    await acquireRefreshLock(db(), "instance-7", at(0));
    const app = makeApp();
    for (const body of [
      { idempotencyKey: "k1", holder: "instance-7" },
      { idempotencyKey: "k1", reason: "Crashed." },
    ]) {
      expect((await act(app, clear, body)).status).toBe(400);
    }
    expect(await db().selectFrom(LEADERBOARD_LOCKS_TABLE).select("holder").execute()).toEqual([
      { holder: "instance-7" },
    ]);
    expect(await history()).toEqual([]);
  });
});
