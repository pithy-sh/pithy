// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { Capability, PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { ControlPlaneConfig } from "@pithy-sh/core/src/controlPlane/config/config";
import type { ControlPlaneConnection } from "@pithy-sh/core/src/controlPlane/data/connection";
import { type ControlPlaneVerifier, createControlPlaneVerifier } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { exportPublicJwk, mintControlPlaneToken } from "@pithy-sh/core/src/controlPlane/token/mint";
import { CONTROL_PLANE_HEADER } from "@pithy-sh/core/src/controlPlane/wire";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { buildRegistryFromCapabilities } from "@pithy-sh/core/src/migrations/capabilitySets";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { leaderboard } from "@pithy-sh/leaderboard/src/capability";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { z } from "zod";
import { multiplayer } from "../capability";
import { MultiplayerConfig, type MultiplayerConfigInput, validateGames } from "../config/config";
import { sessionIndex } from "../data/sessionStore";
import { resultStore } from "../data/store";
import { multiplayerDatabase } from "../data/tables";
import "../game/builtins";
import { ServerFrame } from "../session/frames";
import { OPERATOR_CLOSE_SOCKET_REASON } from "../session/protocol";
import {
  AdminResultList,
  AdminResultVoided,
  AdminSessionClosed,
  AdminSessionList,
  SessionInspection,
  SessionView,
} from "./responses";
import { registerMultiplayerRoutes } from "./routes";
import { MULTIPLAYER_SESSIONS_MODERATE_SCOPE, MULTIPLAYER_SESSIONS_READ_SCOPE } from "./scopes";

/**
 * The management handlers, actually executed (#820): a real control-plane verifier, the real D1 and session
 * Durable Objects, and a capturing audit seam. `routeContract.workers.test.ts` proves each route refuses with no
 * credential; this proves what each does with one — the reads answer from the index, the session and the results,
 * each act takes a key and a reason, a replay changes nothing and emits nothing, and a closed session's players are
 * told.
 */

const CONFIG: MultiplayerConfigInput = {
  games: [{ key: "ttt", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } }],
};
const CONNECTION_ID = "6f1d2e40-7b3a-4c9e-8d51-2a4b6c8e0f13";
const ISSUER = "https://dashboard.example";
const KEY_ID = "key-1";
const ENVIRONMENT = "prod";
const BOTH = [MULTIPLAYER_SESSIONS_READ_SCOPE, MULTIPLAYER_SESSIONS_MODERATE_SCOPE];

// A composed leaderboard is the one void consumer here, so a void has someone to call. The cascade itself is
// `void/void.workers.test.ts`'s, over the real leaderboard and rating.
const COMPOSED: Capability[] = [
  leaderboard({ boards: [{ key: "wins", direction: "desc", aggregation: "sum" }] }),
  multiplayer(CONFIG),
];
for (const capability of COMPOSED) capability.compose?.({ capabilities: COMPOSED });

let keys: CryptoKeyPair;
let emitted: AuditEventInput[] = [];
/** The events multiplayer emitted — the seam's own events about each verified call are not this suite's. */
const acts = (): AuditEventInput[] => emitted.filter((event) => event.action.startsWith("multiplayer/"));

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
});

beforeEach(async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pithy_%'",
  ).all<{ name: string }>();
  for (const { name } of results) await env.DB.exec(`DROP TABLE IF EXISTS ${name}`);
  for (const provider of Object.values(buildRegistryFromCapabilities(COMPOSED))) {
    await runMigrations(env.DB, provider);
  }
  emitted = [];
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
  registerMultiplayerRoutes({ games: validateGames(MultiplayerConfig.parse(CONFIG)) })(app);
  return app;
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
  return app.request(`http://x${path}`, { method, headers, body }, { ...env, ENVIRONMENT });
}

/** A player call, as `user`. */
function play(app: Hono<PithyHonoEnv>, method: string, path: string, user: string, json?: unknown) {
  const headers: Record<string, string> = { "x-user": user };
  if (json !== undefined) headers["content-type"] = "application/json";
  return app.request(
    `http://x${path}`,
    { method, headers, body: json === undefined ? undefined : JSON.stringify(json) },
    env,
  );
}

/** Read a response through its published schema, and require the parse to hand back exactly what arrived. */
async function conforming<Schema extends z.ZodType>(res: Response, schema: Schema): Promise<z.infer<Schema>> {
  const body: unknown = await res.json();
  expect(schema.parse(body)).toEqual(body);
  return body as z.infer<Schema>;
}

const errorCode = async (res: Response) => (await res.json<{ error: { code: string } }>()).error.code;

/** Open a tic-tac-toe session as `x`, joined by `o` when given. Answers its id. */
async function opened(app: Hono<PithyHonoEnv>, x: string, o?: string): Promise<string> {
  const created = await play(app, "POST", "/multiplayer/games/ttt", x);
  expect(created.status).toBe(201);
  const { sessionId } = SessionView.parse(await created.json());
  if (o) expect((await play(app, "POST", `/multiplayer/sessions/${sessionId}/join`, o)).status).toBe(200);
  return sessionId;
}

/** Play an opened, joined session to an x win. */
async function won(app: Hono<PithyHonoEnv>, sessionId: string, x: string, o: string): Promise<void> {
  for (const [player, row, col] of [
    [x, 0, 0],
    [o, 1, 0],
    [x, 0, 1],
    [o, 1, 1],
    [x, 0, 2],
  ] as const) {
    expect((await play(app, "POST", `/multiplayer/sessions/${sessionId}/action`, player, { row, col })).status).toBe(
      200,
    );
  }
}

describe("GET /admin/sessions", () => {
  test("lists the sessions in flight, newest first, with players and age, and not the ones that ended", async () => {
    const app = makeApp();
    const first = await opened(app, "ada", "bo");
    const second = await opened(app, "cy");
    const ended = await opened(app, "dee", "eve");
    await won(app, ended, "dee", "eve");

    const res = await manage(app, "GET", "/multiplayer/admin/sessions", MULTIPLAYER_SESSIONS_READ_SCOPE);
    expect(res.status).toBe(200);
    const body = await conforming(res, AdminSessionList);
    expect(body.sessions.map((session) => session.sessionId)).toEqual([second, first]);
    expect(body.sessions[0]).toMatchObject({ gameKey: "ttt", phase: "open", players: ["cy"] });
    expect(body.sessions[1]).toMatchObject({ phase: "active", players: ["ada", "bo"] });
    expect(body.sessions[1]?.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(body.nextCursor).toBeNull();
  });

  test("pages by cursor, and an unconfigured game is the capability's 404", async () => {
    const app = makeApp();
    await opened(app, "ada");
    await opened(app, "bo");
    const page = await conforming(
      await manage(app, "GET", "/multiplayer/admin/sessions?limit=1&game=ttt", MULTIPLAYER_SESSIONS_READ_SCOPE),
      AdminSessionList,
    );
    expect(page.sessions).toHaveLength(1);
    const next = await conforming(
      await manage(
        app,
        "GET",
        `/multiplayer/admin/sessions?limit=1&cursor=${page.nextCursor}`,
        MULTIPLAYER_SESSIONS_READ_SCOPE,
      ),
      AdminSessionList,
    );
    expect(next.sessions).toHaveLength(1);
    expect(next.sessions[0]?.sessionId).not.toBe(page.sessions[0]?.sessionId);

    const unknown = await manage(app, "GET", "/multiplayer/admin/sessions?game=chess", MULTIPLAYER_SESSIONS_READ_SCOPE);
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe("multiplayer/game_not_found");
  });
});

describe("GET /admin/sessions/:id", () => {
  test("reads the session from its Durable Object, and never the game's state", async () => {
    const app = makeApp();
    const id = await opened(app, "ada", "bo");
    const res = await manage(app, "GET", `/multiplayer/admin/sessions/${id}`, MULTIPLAYER_SESSIONS_READ_SCOPE);
    expect(res.status).toBe(200);
    const body = await conforming(res, SessionInspection);
    expect(body).toMatchObject({
      sessionId: id,
      gameKey: "ttt",
      kind: "connect-n",
      mode: "match",
      phase: "active",
      players: ["ada", "bo"],
      joined: ["ada", "bo"],
      connected: [],
      deadline: null,
      outcome: null,
    });
    expect(body).not.toHaveProperty("state");
  });

  test("an id that names no session is a 404", async () => {
    const app = makeApp();
    const never = env.SESSIONS.newUniqueId().toString();
    const res = await manage(app, "GET", `/multiplayer/admin/sessions/${never}`, MULTIPLAYER_SESSIONS_READ_SCOPE);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("multiplayer/session_not_found");
    const garbled = await manage(app, "GET", "/multiplayer/admin/sessions/zz", MULTIPLAYER_SESSIONS_READ_SCOPE);
    expect(garbled.status).toBe(404);
  });
});

describe("POST /admin/sessions/:id/close", () => {
  test("ends the session, tells its players why, records no result, and emits one event", async () => {
    const app = makeApp();
    const id = await opened(app, "ada", "bo");
    const socket = await app.request(
      `http://x/multiplayer/sessions/${id}/socket`,
      { headers: { upgrade: "websocket", "x-user": "ada", "sec-websocket-protocol": "pithy.multiplayer.v1" } },
      env,
    );
    const ws = socket.webSocket;
    if (!ws) throw new Error("no socket on the 101");
    const frames: ServerFrame[] = [];
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })),
    );
    ws.addEventListener("message", (event) => frames.push(ServerFrame.parse(JSON.parse(String(event.data)))));
    ws.accept();

    const res = await manage(
      app,
      "POST",
      `/multiplayer/admin/sessions/${id}/close`,
      MULTIPLAYER_SESSIONS_MODERATE_SCOPE,
      {
        idempotencyKey: "close-1",
        reason: "Stuck for an hour.",
      },
    );
    expect(res.status).toBe(200);
    const body = await conforming(res, AdminSessionClosed);
    expect(body.replayed).toBe(false);
    expect(body.session.phase).toBe("abandoned");
    expect(body.session.outcome).toMatchObject({ status: "abandoned", closedReason: "Stuck for an hour." });

    // The player was told: a last state frame with the reason, then the socket closed.
    expect(await closed).toEqual({ code: 1000, reason: OPERATOR_CLOSE_SOCKET_REASON });
    const last = frames.at(-1);
    expect(last?.type).toBe("state");
    expect(last?.type === "state" ? last.outcome?.closedReason : undefined).toBe("Stuck for an hour.");

    const db = multiplayerDatabase(env.DB);
    expect(await resultStore(env.DB).get(id)).toBeUndefined();
    expect(await sessionIndex(db).get(id)).toBeUndefined();
    expect(acts()).toHaveLength(1);
    expect(acts()[0]).toMatchObject({
      action: "multiplayer/session_closed",
      actorType: "control-plane",
      actorId: "operator-1",
      resourceType: "multiplayer_session",
      resourceId: id,
      metadata: {
        connectionId: CONNECTION_ID,
        gameKey: "ttt",
        players: ["ada", "bo"],
        reason: "Stuck for an hour.",
        idempotencyKey: "close-1",
      },
    });
  });

  test("a retry with the same key changes nothing and emits nothing; a new key on an ended session is a 409", async () => {
    const app = makeApp();
    const id = await opened(app, "ada");
    const close = (idempotencyKey: string) =>
      manage(app, "POST", `/multiplayer/admin/sessions/${id}/close`, MULTIPLAYER_SESSIONS_MODERATE_SCOPE, {
        idempotencyKey,
        reason: "Stuck.",
      });
    expect((await close("k1")).status).toBe(200);
    const again = await conforming(await close("k1"), AdminSessionClosed);
    expect(again.replayed).toBe(true);
    expect(acts()).toHaveLength(1);

    const other = await close("k2");
    expect(other.status).toBe(409);
    expect(await errorCode(other)).toBe("multiplayer/invalid_transition");
    expect(acts()).toHaveLength(1);
  });

  test("a finished session cannot be closed, and nothing is emitted", async () => {
    const app = makeApp();
    const id = await opened(app, "ada", "bo");
    await won(app, id, "ada", "bo");
    const res = await manage(
      app,
      "POST",
      `/multiplayer/admin/sessions/${id}/close`,
      MULTIPLAYER_SESSIONS_MODERATE_SCOPE,
      {
        idempotencyKey: "k1",
        reason: "Late.",
      },
    );
    expect(res.status).toBe(409);
    expect(acts()).toEqual([]);
  });

  test("the body is a key and a reason, and nothing else", async () => {
    const app = makeApp();
    const id = await opened(app, "ada");
    for (const body of [{ idempotencyKey: "k1" }, { idempotencyKey: "k1", reason: "  " }, { reason: "x" }]) {
      const res = await manage(
        app,
        "POST",
        `/multiplayer/admin/sessions/${id}/close`,
        MULTIPLAYER_SESSIONS_MODERATE_SCOPE,
        body,
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const extra = await manage(
      app,
      "POST",
      `/multiplayer/admin/sessions/${id}/close`,
      MULTIPLAYER_SESSIONS_MODERATE_SCOPE,
      {
        idempotencyKey: "k1",
        reason: "x",
        force: true,
      },
    );
    expect(extra.status).toBe(400);
  });
});

describe("GET /admin/results", () => {
  test("lists results most recently ended first, with status, players, scores and winner, and filters voided", async () => {
    const app = makeApp();
    const first = await opened(app, "ada", "bo");
    await won(app, first, "ada", "bo");
    const second = await opened(app, "cy", "dee");
    await won(app, second, "cy", "dee");
    await manage(app, "POST", `/multiplayer/admin/results/${first}/void`, MULTIPLAYER_SESSIONS_MODERATE_SCOPE, {
      idempotencyKey: "v1",
      reason: "Collusion.",
    });

    const all = await conforming(
      await manage(app, "GET", "/multiplayer/admin/results", MULTIPLAYER_SESSIONS_READ_SCOPE),
      AdminResultList,
    );
    expect(all.results.map((result) => result.sessionId)).toEqual([second, first]);
    expect(all.results[0]).toMatchObject({
      status: "resolved",
      players: ["cy", "dee"],
      winnerUserId: "cy",
      draw: false,
      voidedAt: null,
      consumers: [],
    });
    expect(all.results[0]?.scores).not.toBeNull();

    const voided = await conforming(
      await manage(app, "GET", "/multiplayer/admin/results?voided=true", MULTIPLAYER_SESSIONS_READ_SCOPE),
      AdminResultList,
    );
    expect(voided.results.map((result) => result.sessionId)).toEqual([first]);
    expect(voided.results[0]?.consumers).toEqual([{ consumer: "leaderboard", status: "done", error: null }]);
    const counting = await conforming(
      await manage(app, "GET", "/multiplayer/admin/results?voided=false&game=ttt", MULTIPLAYER_SESSIONS_READ_SCOPE),
      AdminResultList,
    );
    expect(counting.results.map((result) => result.sessionId)).toEqual([second]);
  });
});

describe("POST /admin/results/:id/void", () => {
  test("voids the result, reports each consumer, emits one event, and a replay changes nothing", async () => {
    const app = makeApp();
    const id = await opened(app, "ada", "bo");
    await won(app, id, "ada", "bo");
    const voiding = (idempotencyKey: string) =>
      manage(app, "POST", `/multiplayer/admin/results/${id}/void`, MULTIPLAYER_SESSIONS_MODERATE_SCOPE, {
        idempotencyKey,
        reason: "Collusion.",
      });

    const res = await voiding("v1");
    expect(res.status).toBe(200);
    const body = await conforming(res, AdminResultVoided);
    expect(body.replayed).toBe(false);
    expect(body.result.voidedAt).not.toBeNull();
    expect(body.consumers.map(({ consumer, status }) => ({ consumer, status }))).toEqual([
      { consumer: "leaderboard", status: "done" },
    ]);
    expect(acts()).toEqual([
      expect.objectContaining({
        action: "multiplayer/result_voided",
        resourceId: id,
        metadata: expect.objectContaining({
          connectionId: CONNECTION_ID,
          gameKey: "ttt",
          players: ["ada", "bo"],
          consumers: [{ consumer: "leaderboard", status: "done" }],
          reason: "Collusion.",
          idempotencyKey: "v1",
        }),
      }),
    ]);

    // The player's own read says it was voided.
    const read = await play(app, "GET", `/multiplayer/sessions/${id}/result`, "ada");
    expect((await read.json<{ voidedAt: string | null }>()).voidedAt).toBe(body.result.voidedAt);

    for (const key of ["v1", "v2"]) {
      const again = await conforming(await voiding(key), AdminResultVoided);
      expect(again.replayed).toBe(true);
    }
    expect(acts()).toHaveLength(1);
  });

  test("a session with no result is a 404, and a key spent on another result is a 409", async () => {
    const app = makeApp();
    const open = await opened(app, "ada");
    const none = await manage(
      app,
      "POST",
      `/multiplayer/admin/results/${open}/void`,
      MULTIPLAYER_SESSIONS_MODERATE_SCOPE,
      {
        idempotencyKey: "v1",
        reason: "x",
      },
    );
    expect(none.status).toBe(404);

    const first = await opened(app, "ada", "bo");
    await won(app, first, "ada", "bo");
    const second = await opened(app, "cy", "dee");
    await won(app, second, "cy", "dee");
    await manage(app, "POST", `/multiplayer/admin/results/${first}/void`, MULTIPLAYER_SESSIONS_MODERATE_SCOPE, {
      idempotencyKey: "v1",
      reason: "x",
    });
    const reused = await manage(
      app,
      "POST",
      `/multiplayer/admin/results/${second}/void`,
      MULTIPLAYER_SESSIONS_MODERATE_SCOPE,
      {
        idempotencyKey: "v1",
        reason: "x",
      },
    );
    expect(reused.status).toBe(409);
    expect(await errorCode(reused)).toBe("core/conflict");
    expect(acts()).toHaveLength(1);
  });
});

describe("the scopes", () => {
  test("a connection without the moderate scope cannot act, and one without the read scope cannot read", async () => {
    const readOnly = makeApp([MULTIPLAYER_SESSIONS_READ_SCOPE]);
    const id = await opened(readOnly, "ada");
    const act = await manage(
      readOnly,
      "POST",
      `/multiplayer/admin/sessions/${id}/close`,
      MULTIPLAYER_SESSIONS_MODERATE_SCOPE,
      {
        idempotencyKey: "k1",
        reason: "x",
      },
    );
    expect(act.status).toBe(403);

    const actOnly = makeApp([MULTIPLAYER_SESSIONS_MODERATE_SCOPE]);
    const read = await manage(actOnly, "GET", "/multiplayer/admin/sessions", MULTIPLAYER_SESSIONS_READ_SCOPE);
    expect(read.status).toBe(403);
    // A token minted for the act does not open the read either: each route verifies its own scope.
    const crossed = await manage(actOnly, "GET", "/multiplayer/admin/results", MULTIPLAYER_SESSIONS_MODERATE_SCOPE);
    expect(crossed.status).toBe(403);
    expect(acts()).toEqual([]);
  });
});
