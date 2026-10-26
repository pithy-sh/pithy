// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { authPeer } from "@pithy-sh/auth/src/peer";
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
import { MATCHMAKING_MIGRATION_ORDER } from "../capability";
import { MatchmakingConfig } from "../config/config";
import { MATCHMAKING_MIGRATIONS } from "../migrations/chain";
import { PresenceServerFrame } from "../presence/frames";
import {
  AdminInviteCanceled,
  AdminInviteList,
  AdminQueue,
  AdminQueuePlayerDropped,
  AdminRoomList,
  InviteView,
  RoomCreated,
} from "./responses";
import { registerMatchmakingRoutes } from "./routes";
import { MATCHMAKING_QUEUES_MODERATE_SCOPE, MATCHMAKING_QUEUES_READ_SCOPE, matchmakingAdminRoutes } from "./scopes";

/**
 * The management handlers, actually executed: a real control-plane verifier, the real D1, KV and both Durable
 * Objects, and a capturing audit seam. `routeContract.test.ts` proves each route refuses with no credential; this
 * proves what each does with one — the reads answer from where the data lives, each act takes a key and a reason,
 * a replay changes nothing and emits nothing, and the players are told through presence.
 */

const CONFIG = MatchmakingConfig.parse({
  games: [{ key: "duel", players: 2, snapshot: { kind: "connect-n", rules: {} } }],
});
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const ISSUER = "https://dashboard.example";
const KEY_ID = "key-1";
const ENVIRONMENT = "prod";
const BOTH = [MATCHMAKING_QUEUES_READ_SCOPE, MATCHMAKING_QUEUES_MODERATE_SCOPE];

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];
/** The events matchmaking emitted — the seam's own events about each verified call are not this suite's. */
const acts = (): AuditEventInput[] => emitted.filter((event) => event.action.startsWith("matchmaking/"));
/** A distinct suffix per test: the presence object is shared across the file, so user ids must not repeat. */
let run = 0;

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "matchmaking",
      order: MATCHMAKING_MIGRATION_ORDER,
      migrations: MATCHMAKING_MIGRATIONS,
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error("no app provider");
  return found;
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
  for (const key of (await env.MATCHMAKING.list()).keys) await env.MATCHMAKING.delete(key.name);
  emitted = [];
  run++;
});

async function connection(scopes: readonly ControlPlaneScope[]): Promise<ControlPlaneConnection> {
  const at = new Date(Date.now() - 86_400_000);
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
        validFrom: at,
        validUntil: null,
        revokedAt: null,
      },
    ],
    createdAt: at,
    updatedAt: at,
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
    now: () => new Date(),
  });
}

/** The app: players by `x-user`, management clients by a signed token, audit captured. */
function makeApp(scopes: readonly ControlPlaneScope[] = BOTH) {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  const cpVerifier = verifier(scopes);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    c.set("auth", user ? { userId: user, sessionId: "s1", scopes: [] } : null);
    c.set("controlPlane", null);
    c.set("controlPlaneVerifier", cpVerifier);
    c.set("emit", async (event: AuditEventInput) => void emitted.push(event));
    c.set("log", noopLogger);
    await next();
  });
  registerMatchmakingRoutes({ config: CONFIG, peers: () => ({ auth: authPeer }) })(app);
  return app;
}

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
  return { ...env, SESSIONS: fakeSessions, ENVIRONMENT } as unknown as typeof env;
}

/** A management call, signed over its body with a single-scope token. */
async function manage(
  app: Hono<PithyHonoEnv>,
  method: "GET" | "POST",
  path: string,
  scope: ControlPlaneScope,
  json?: unknown,
): Promise<Response> {
  const body = json === undefined ? undefined : JSON.stringify(json);
  const token = await mintControlPlaneToken({
    privateKey: keys.privateKey,
    keyId: KEY_ID,
    issuer: ISSUER,
    connectionId: CONNECTION_ID,
    subject: "operator-1",
    scope,
    body: body === undefined ? undefined : new TextEncoder().encode(body),
  });
  const headers: Record<string, string> = { [CONTROL_PLANE_HEADER]: token };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(`http://x${path}`, { method, headers, body }, requestEnv());
}

/** A player call, as `user`. */
function play(app: Hono<PithyHonoEnv>, method: string, path: string, user: string, json?: unknown) {
  const headers: Record<string, string> = { "x-user": user };
  if (json !== undefined) headers["content-type"] = "application/json";
  return app.request(
    `http://x${path}`,
    { method, headers, body: json === undefined ? undefined : JSON.stringify(json) },
    requestEnv(),
  );
}

/** Read a response through its published schema, and require the parse to hand back exactly what arrived. */
async function conforming<Schema extends z.ZodType>(res: Response, schema: Schema): Promise<z.infer<Schema>> {
  const body: unknown = await res.json();
  expect(schema.parse(body)).toEqual(body);
  return body as z.infer<Schema>;
}

const errorCode = async (res: Response) => (await res.json<{ error: { code: string } }>()).error.code;

async function seedAuthUser(id: string): Promise<void> {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS pithy_auth_users (id TEXT PRIMARY KEY, name TEXT, email TEXT, email_verified INTEGER, image TEXT, created_at TEXT, updated_at TEXT, locale TEXT)",
  );
  await env.DB.prepare(
    "INSERT INTO pithy_auth_users (id, name, email, email_verified, image, created_at, updated_at) VALUES (?, ?, ?, 1, NULL, ?, ?)",
  )
    .bind(id, id, `${id}@example.com`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")
    .run();
}

/** `inviter` invites `invitee` to a duel through the player route. */
async function invite(app: Hono<PithyHonoEnv>, inviter: string, invitee: string): Promise<InviteView> {
  await seedAuthUser(inviter);
  await seedAuthUser(invitee);
  const res = await play(app, "POST", "/matchmaking/games/duel/invites", inviter, { email: `${invitee}@example.com` });
  expect(res.status).toBe(201);
  return InviteView.parse(await res.json());
}

/** Every JSON frame one presence socket receives, and a way to wait for the next. */
async function presence(app: Hono<PithyHonoEnv>, user: string) {
  const res = await app.request(
    "http://x/matchmaking/presence",
    { headers: { upgrade: "websocket", "x-user": user } },
    requestEnv(),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket on the 101");
  const frames: PresenceServerFrame[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || event.data === "pong") return;
    frames.push(PresenceServerFrame.parse(JSON.parse(event.data)));
    for (const wake of waiters.splice(0)) wake();
  });
  ws.accept();
  const until = async (type: string): Promise<PresenceServerFrame> => {
    for (;;) {
      const found = frames.find((frame) => frame.type === type);
      if (found) return found;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type} frame`)), 2000);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  return { frames, until, close: () => ws.close() };
}

/** `user` joins the duel queue, pinned to `country` so two players in different countries never pair. */
async function enqueue(app: Hono<PithyHonoEnv>, user: string, country: string): Promise<void> {
  const req = new Request("http://x/matchmaking/games/duel/queue", { method: "POST", headers: { "x-user": user } });
  Object.defineProperty(req, "cf", { value: { country } });
  const res = await app.request(req, undefined, requestEnv());
  expect(res.status).toBe(200);
}

describe("GET /matchmaking/admin/games/:game/queue", () => {
  test("reads who is waiting from the queue Durable Object", async () => {
    const app = makeApp();
    const [ada, ben] = [`qa-${run}`, `qb-${run}`];
    await enqueue(app, ada, "GB");
    await enqueue(app, ben, "US");

    const res = await manage(app, "GET", "/matchmaking/admin/games/duel/queue", MATCHMAKING_QUEUES_READ_SCOPE);
    expect(res.status).toBe(200);
    const body = await conforming(res, AdminQueue);
    expect(body.gameKey).toBe("duel");
    const mine = body.waiting.filter((t) => t.userId === ada || t.userId === ben);
    expect(mine).toEqual([
      expect.objectContaining({ userId: ada, region: "GB", skill: null, skillBand: null }),
      expect.objectContaining({ userId: ben, region: "US", skill: null, skillBand: null }),
    ]);

    // Clean the shared coordinator for the next test.
    await play(app, "DELETE", "/matchmaking/games/duel/queue", ada);
    await play(app, "DELETE", "/matchmaking/games/duel/queue", ben);
  });

  test("an unconfigured game is the capability's own 404", async () => {
    const res = await manage(makeApp(), "GET", "/matchmaking/admin/games/chess/queue", MATCHMAKING_QUEUES_READ_SCOPE);
    expect(res.status).toBe(404);
  });

  test("a connection never granted the read scope is refused", async () => {
    const res = await manage(
      makeApp([MATCHMAKING_QUEUES_MODERATE_SCOPE]),
      "GET",
      "/matchmaking/admin/games/duel/queue",
      MATCHMAKING_QUEUES_READ_SCOPE,
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /matchmaking/admin/games/:game/rooms", () => {
  test("lists the game's open rooms with code, host, occupancy and since when", async () => {
    const app = makeApp();
    const opened = await play(app, "POST", "/matchmaking/games/duel/rooms", `host-${run}`);
    const room = RoomCreated.parse(await opened.json());
    await play(app, "POST", `/matchmaking/rooms/${room.code}/join`, `guest-${run}`);

    const res = await manage(app, "GET", "/matchmaking/admin/games/duel/rooms", MATCHMAKING_QUEUES_READ_SCOPE);
    expect(res.status).toBe(200);
    const body = await conforming(res, AdminRoomList);
    expect(body.rooms).toEqual([
      expect.objectContaining({
        code: room.code,
        hostId: `host-${run}`,
        sessionId: room.sessionId,
        occupancy: 2,
        capacity: 2,
      }),
    ]);
    expect(body.nextCursor).toBeNull();
  });
});

describe("GET /matchmaking/admin/invites", () => {
  test("pages every pending invite with game, inviter, invitee and age", async () => {
    const app = makeApp();
    const sent = await invite(app, `ia-${run}`, `ib-${run}`);

    const res = await manage(app, "GET", "/matchmaking/admin/invites", MATCHMAKING_QUEUES_READ_SCOPE);
    expect(res.status).toBe(200);
    const body = await conforming(res, AdminInviteList);
    expect(body.invites).toEqual([
      {
        id: sent.id,
        gameKey: "duel",
        inviterId: `ia-${run}`,
        inviteeId: `ib-${run}`,
        createdAt: sent.createdAt,
        ageMs: expect.any(Number),
      },
    ]);
    expect(body.nextCursor).toBeNull();
  });

  test("a game filter naming an unconfigured game is a 404, not an empty page", async () => {
    const res = await manage(makeApp(), "GET", "/matchmaking/admin/invites?game=chess", MATCHMAKING_QUEUES_READ_SCOPE);
    expect(res.status).toBe(404);
  });
});

describe("POST /matchmaking/admin/invites/:id/cancel", () => {
  test("cancels, tells both players, and audits once; a replay changes nothing and emits nothing", async () => {
    const app = makeApp();
    const [inviter, invitee] = [`ca-${run}`, `cb-${run}`];
    const sent = await invite(app, inviter, invitee);
    const inviterSocket = await presence(app, inviter);
    const inviteeSocket = await presence(app, invitee);
    const body = { idempotencyKey: `cancel-${run}`, reason: "Reported as harassment." };

    const res = await manage(
      app,
      "POST",
      `/matchmaking/admin/invites/${sent.id}/cancel`,
      MATCHMAKING_QUEUES_MODERATE_SCOPE,
      body,
    );
    expect(res.status).toBe(200);
    const canceled = await conforming(res, AdminInviteCanceled);
    expect(canceled).toEqual({
      invite: expect.objectContaining({ id: sent.id, status: "canceled" }),
      replayed: false,
    });

    const frame = { type: "invite_canceled", inviteId: sent.id, gameKey: "duel" };
    expect(await inviterSocket.until("invite_canceled")).toEqual(frame);
    expect(await inviteeSocket.until("invite_canceled")).toEqual(frame);

    expect(acts()).toHaveLength(1);
    expect(acts()[0]).toMatchObject({
      action: "matchmaking/invite_canceled",
      outcome: "success",
      severity: "warning",
      actorType: "control-plane",
      actorId: "operator-1",
      resourceType: "matchmaking_invite",
      resourceId: sent.id,
      metadata: {
        connectionId: CONNECTION_ID,
        gameKey: "duel",
        inviteId: sent.id,
        inviterId: inviter,
        inviteeId: invitee,
        reason: body.reason,
        idempotencyKey: body.idempotencyKey,
      },
    });

    const again = await manage(
      app,
      "POST",
      `/matchmaking/admin/invites/${sent.id}/cancel`,
      MATCHMAKING_QUEUES_MODERATE_SCOPE,
      body,
    );
    expect(again.status).toBe(200);
    expect((await conforming(again, AdminInviteCanceled)).replayed).toBe(true);
    expect(acts()).toHaveLength(1);
    expect(inviteeSocket.frames.filter((f) => f.type === "invite_canceled")).toHaveLength(1);

    // The invitee cannot accept a canceled invite, and nothing is minted trying.
    const accept = await play(app, "POST", `/matchmaking/invites/${sent.id}/accept`, invitee);
    expect(accept.status).toBe(404);
    expect(await errorCode(accept)).toBe("matchmaking/invite_not_found");

    inviterSocket.close();
    inviteeSocket.close();
  });

  test("a missing, empty or whitespace reason is refused before anything changes", async () => {
    const app = makeApp();
    const sent = await invite(app, `ra-${run}`, `rb-${run}`);
    for (const body of [
      { idempotencyKey: "k" },
      { idempotencyKey: "k", reason: "" },
      { idempotencyKey: "k", reason: "  " },
    ]) {
      const res = await manage(
        app,
        "POST",
        `/matchmaking/admin/invites/${sent.id}/cancel`,
        MATCHMAKING_QUEUES_MODERATE_SCOPE,
        body,
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const missingKey = await manage(
      app,
      "POST",
      `/matchmaking/admin/invites/${sent.id}/cancel`,
      MATCHMAKING_QUEUES_MODERATE_SCOPE,
      { reason: "Spam." },
    );
    expect(missingKey.status).toBe(400);
    expect(acts()).toEqual([]);
    const listed = await conforming(
      await manage(app, "GET", "/matchmaking/admin/invites", MATCHMAKING_QUEUES_READ_SCOPE),
      AdminInviteList,
    );
    expect(listed.invites.map((i) => i.id)).toEqual([sent.id]);
  });

  test("an invite already answered is refused, and emits nothing", async () => {
    const app = makeApp();
    const sent = await invite(app, `da-${run}`, `db-${run}`);
    await play(app, "POST", `/matchmaking/invites/${sent.id}/decline`, `db-${run}`);
    const res = await manage(
      app,
      "POST",
      `/matchmaking/admin/invites/${sent.id}/cancel`,
      MATCHMAKING_QUEUES_MODERATE_SCOPE,
      { idempotencyKey: `k-${run}`, reason: "Stale." },
    );
    expect(res.status).toBe(404);
    expect(acts()).toEqual([]);
  });

  test("the read scope does not confer the act", async () => {
    const app = makeApp([MATCHMAKING_QUEUES_READ_SCOPE]);
    const sent = await invite(app, `sa-${run}`, `sb-${run}`);
    const res = await manage(
      app,
      "POST",
      `/matchmaking/admin/invites/${sent.id}/cancel`,
      MATCHMAKING_QUEUES_MODERATE_SCOPE,
      { idempotencyKey: "k", reason: "Spam." },
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /matchmaking/admin/games/:game/queue/:userId/drop", () => {
  test("drops the player, tells their socket why, and audits once; a replay changes nothing and emits nothing", async () => {
    const app = makeApp();
    const player = `dp-${run}`;
    await enqueue(app, player, "FR");
    const socket = await presence(app, player);
    const body = { idempotencyKey: `drop-${run}`, reason: "Queued from two devices at once." };
    const path = `/matchmaking/admin/games/duel/queue/${player}/drop`;

    const res = await manage(app, "POST", path, MATCHMAKING_QUEUES_MODERATE_SCOPE, body);
    expect(res.status).toBe(200);
    expect(await conforming(res, AdminQueuePlayerDropped)).toEqual({
      gameKey: "duel",
      userId: player,
      replayed: false,
    });
    expect(await socket.until("queue_dropped")).toEqual({
      type: "queue_dropped",
      gameKey: "duel",
      reason: body.reason,
    });

    expect(acts()).toHaveLength(1);
    expect(acts()[0]).toMatchObject({
      action: "matchmaking/queue_player_dropped",
      severity: "warning",
      actorType: "control-plane",
      resourceType: "matchmaking_queue_ticket",
      resourceId: `duel:${player}`,
      metadata: {
        connectionId: CONNECTION_ID,
        gameKey: "duel",
        userId: player,
        reason: body.reason,
        idempotencyKey: body.idempotencyKey,
      },
    });

    const status = await play(app, "GET", "/matchmaking/games/duel/queue", player);
    expect(await errorCode(status)).toBe("matchmaking/not_queued");

    const again = await manage(app, "POST", path, MATCHMAKING_QUEUES_MODERATE_SCOPE, body);
    expect((await conforming(again, AdminQueuePlayerDropped)).replayed).toBe(true);
    expect(acts()).toHaveLength(1);
    expect(socket.frames.filter((f) => f.type === "queue_dropped")).toHaveLength(1);
    socket.close();
  });

  test("a player who is not queued is a 404, and emits nothing", async () => {
    const res = await manage(
      makeApp(),
      "POST",
      `/matchmaking/admin/games/duel/queue/ghost-${run}/drop`,
      MATCHMAKING_QUEUES_MODERATE_SCOPE,
      { idempotencyKey: `k-${run}`, reason: "Stuck." },
    );
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("matchmaking/not_queued");
    expect(acts()).toEqual([]);
  });
});

describe("the friend graph is the players' own", () => {
  test("every admin route answers, every act on a real target, with the friends table gone", async () => {
    // If any management handler read or wrote a friend edge — on a read, or on an act's success path, where it
    // updates, notifies and records — it would fail here on the missing table. So each act gets a target that
    // exists: a pending invite, a queued player.
    const app = makeApp();
    const pending = await invite(app, `fa-${run}`, `fb-${run}`);
    const queued = `fq-${run}`;
    await enqueue(app, queued, "NZ");
    await env.DB.exec("DROP TABLE pithy_matchmaking_friends");

    for (const route of matchmakingAdminRoutes("/matchmaking")) {
      const path = route.path.replace(":game", "duel").replace(":userId", queued).replace(":id", pending.id);
      const res = await manage(
        app,
        route.method as "GET" | "POST",
        path,
        route.scope ?? MATCHMAKING_QUEUES_READ_SCOPE,
        route.method === "POST" ? { idempotencyKey: `k-${run}-${route.path}`, reason: "Check." } : undefined,
      );
      expect(res.status, `${route.method} ${path}`).toBe(200);
      if (route.method === "POST") {
        expect((await res.json<{ replayed: boolean }>()).replayed, `${route.method} ${path}`).toBe(false);
      }
    }

    // Both acts ran to the end: each recorded its audit event.
    expect(
      acts()
        .map((event) => event.action)
        .sort(),
    ).toEqual(["matchmaking/invite_canceled", "matchmaking/queue_player_dropped"]);
  });
});
