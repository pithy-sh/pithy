// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { authPeer } from "@pithy-sh/auth/src/peer";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import { ErrorBody } from "@pithy-sh/core/src/error/wire";
import { SUBPROTOCOL_HEADER } from "@pithy-sh/core/src/http/subprotocol";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { Hono } from "hono";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { MATCHMAKING_MIGRATION_ORDER } from "../capability";
import { MatchmakingConfig } from "../config/config";
import { InviteView } from "../http/responses";
import { registerMatchmakingRoutes } from "../http/routes";
import { matchmaking_0001_matchmaking } from "../migrations/0001_matchmaking";
import { presenceSocket } from "./channel";
import { PRESENCE_VERSIONS, PresenceServerFrame } from "./frames";

/**
 * **The presence socket, driven through the real route and the real Durable Object, against its contract.**
 *
 * Every JSON frame a socket receives here is parsed with the schema the capability publishes, and the parse
 * must hand back exactly what arrived — a key the Durable Object adds without the schema fails here. Both
 * versions are opened: `pithy.presence.v1`, and the unversioned socket every client before versions speaks.
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

function makeApp() {
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);
  app.use("*", async (c, next) => {
    const user = c.req.header("x-user");
    c.set("auth", user ? { userId: user, sessionId: "s1", scopes: [] } : null);
    await next();
  });
  registerMatchmakingRoutes({
    config: MatchmakingConfig.parse({
      games: [{ key: "duel", players: 2, snapshot: { kind: "connect-n", rules: {} } }],
    }),
    peers: () => ({ auth: authPeer }),
  })(app);
  return app;
}

async function seedAuthUser(id: string, email: string): Promise<void> {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS pithy_auth_users (id TEXT PRIMARY KEY, name TEXT, email TEXT, email_verified INTEGER, image TEXT, created_at TEXT, updated_at TEXT, locale TEXT)",
  );
  await env.DB.prepare(
    "INSERT INTO pithy_auth_users (id, name, email, email_verified, image, created_at, updated_at) VALUES (?, ?, ?, 1, NULL, ?, ?)",
  )
    .bind(id, id, email, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")
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

/** Every frame one socket received, in order, and a way to wait for the next few. */
interface Inbox {
  readonly frames: string[];
  next(count: number): Promise<string[]>;
}

function collect(ws: WebSocket): Inbox {
  const frames: string[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (event) => {
    frames.push(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
    for (const wake of waiters.splice(0)) wake();
  });
  return {
    frames,
    async next(count) {
      const start = frames.length;
      const target = start + count;
      while (frames.length < target) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`waited for ${count} frame(s), got ${frames.length - start}`)),
            2000,
          );
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return frames.slice(start, target);
    },
  };
}

/** Open a presence socket as `user` through the real route, offering `protocol` when given. */
async function open(
  app: Hono<PithyHonoEnv>,
  user: string,
  protocol?: string,
): Promise<{ response: Response; ws: WebSocket; inbox: Inbox }> {
  const headers: Record<string, string> = { upgrade: "websocket", "x-user": user };
  if (protocol !== undefined) headers[SUBPROTOCOL_HEADER] = protocol;
  const response = await app.request("/matchmaking/presence", { headers }, requestEnv());
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("no socket on the 101");
  const inbox = collect(ws);
  ws.accept();
  return { response, ws, inbox };
}

/** A JSON frame, held to the published schema: it parses, and the parse is exactly what arrived. */
function conforming(raw: string): PresenceServerFrame {
  const frame: unknown = JSON.parse(raw);
  expect(PresenceServerFrame.parse(frame)).toEqual(frame);
  return frame as PresenceServerFrame;
}

/** The socket's published JSON schemas, read off the declaration rather than imported beside it. */
const DECLARED = new Map(presenceSocket().send.map((message) => [message.name, message]));

/**
 * Drive one player's socket through every frame the Worker sends: init, invite, friend request, match,
 * pong, then a malformed frame or five: an error frame each on a versioned socket, silence on an unversioned
 * one. Returns the raw frames up to the malformed ones, which both versions share, so they can be compared.
 */
async function driveSocket(protocol: string | undefined, suffix: string): Promise<string[]> {
  const app = makeApp();
  const ada = `ada-${suffix}`;
  const ben = `ben-${suffix}`;
  await seedAuthUser(ada, `${ada}@example.com`);
  await seedAuthUser(ben, `${ben}@example.com`);

  // Ben invites Ada before she connects, so her init frame carries a pending invite.
  const sent = await app.request(
    "/matchmaking/games/duel/invites",
    {
      method: "POST",
      headers: { "x-user": ben, "content-type": "application/json" },
      body: JSON.stringify({ email: `${ada}@example.com` }),
    },
    requestEnv(),
  );
  expect(sent.status).toBe(201);
  const firstInvite = InviteView.parse(await sent.json());

  const { response, ws, inbox } = await open(app, ada, protocol);
  expect(response.headers.get(SUBPROTOCOL_HEADER)).toBe(protocol ?? null);
  const [initRaw] = await inbox.next(1);
  const init = conforming(initRaw ?? "");
  expect(init).toEqual({ type: "init", pendingInvites: [firstInvite], onlineFriends: [] });

  // A live invite, a friend request, and (Ada accepting Ben's invite) a match pushed to Ben, not Ada.
  const pushed = inbox.next(2);
  await app.request(
    "/matchmaking/games/duel/invites",
    {
      method: "POST",
      headers: { "x-user": ben, "content-type": "application/json" },
      body: JSON.stringify({ email: `${ada}@example.com` }),
    },
    requestEnv(),
  );
  await app.request(
    `/matchmaking/friends/${ada}/request`,
    { method: "POST", headers: { "x-user": ben } },
    requestEnv(),
  );
  const [inviteRaw, friendRaw] = await pushed;
  expect(conforming(inviteRaw ?? "")).toMatchObject({ type: "invite", gameKey: "duel", from: ben });
  expect(conforming(friendRaw ?? "")).toEqual({ type: "friend_request", from: ben });

  const benSocket = await open(app, ben, protocol);
  const [benInit] = await benSocket.inbox.next(1);
  conforming(benInit ?? "");
  const matched = benSocket.inbox.next(1);
  const accepted = await app.request(
    `/matchmaking/invites/${firstInvite.id}/accept`,
    { method: "POST", headers: { "x-user": ada } },
    requestEnv(),
  );
  expect(accepted.status).toBe(200);
  const [matchRaw] = await matched;
  expect(conforming(matchRaw ?? "")).toMatchObject({ type: "match_found", gameKey: "duel" });

  // The keepalive is the plain-text exception, and the declaration says so.
  ws.send("ping");
  const [pong] = await inbox.next(1);
  expect(pong).toBe(DECLARED.get("pong")?.text);

  // The frames both versions share end here; what a malformed frame gets is where they part.
  const shared = inbox.frames.length;
  const malformed = ["hello", "{not json", '{"type":"nope"}', '{"type":"ping"}', "PING"];
  if (protocol === undefined) {
    // The unversioned socket ignores anything but `ping`, as it did before versions existed: the next
    // frame after each malformed one is the `pong` for the `ping` sent behind it.
    for (const frame of malformed) {
      ws.send(frame);
      ws.send("ping");
      const [next] = await inbox.next(1);
      expect(next, `unversioned socket answered ${frame}`).toBe("pong");
    }
  } else {
    // A versioned socket answers each with the error an HTTP route would send, and never its operator fields.
    for (const frame of malformed) {
      ws.send(frame);
      const [raw] = await inbox.next(1);
      const error = conforming(raw ?? "");
      expect(error).toMatchObject({ type: "error", error: { code: "validation/invalid_input", status: 400 } });
      if (error.type === "error") {
        expect(ErrorBody.shape.error.parse(error.error)).toEqual(error.error);
        expect(error.error).not.toHaveProperty("action");
        expect(error.error).not.toHaveProperty("detail");
      }
    }
  }

  // Every JSON frame was one the declaration names.
  for (const raw of [...inbox.frames, ...benSocket.inbox.frames].filter((frame) => frame !== "pong")) {
    const type = (JSON.parse(raw) as { type: string }).type;
    expect(DECLARED.get(type)?.schema, `undeclared frame ${type}`).toBeDefined();
  }

  ws.close();
  benSocket.ws.close();
  // Normalize the ids and session that differ run to run, so two versions compare frame for frame.
  return inbox.frames.slice(0, shared).map((raw) =>
    raw
      .replaceAll(suffix, "*")
      .replace(/[0-9a-f-]{36}/g, "<uuid>")
      .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<at>"),
  );
}

describe("the presence socket", () => {
  test("pithy.presence.v1: every frame matches the published schema, and the 101 names the version", async () => {
    await driveSocket(PRESENCE_VERSIONS.current, "v1");
  });

  test("an unversioned client gets the same frames, a 101 that names no version, and silence for a malformed frame", async () => {
    // `pithy.presence.v1` speaks today's frames, so "previous" and "current" render the same — except that
    // only a versioned socket is answered with an `error` frame, which `driveSocket` checks per version.
    const versioned = await driveSocket(PRESENCE_VERSIONS.current, "x1");
    const unversioned = await driveSocket(undefined, "x2");
    expect(unversioned).toEqual(versioned);
  });

  test("a client offering only versions this Worker does not serve is refused with a 400, before any socket", async () => {
    const response = await makeApp().request(
      "/matchmaking/presence",
      { headers: { upgrade: "websocket", "x-user": "ada", [SUBPROTOCOL_HEADER]: "pithy.presence.v9" } },
      requestEnv(),
    );
    expect(response.status).toBe(400);
    expect(response.webSocket).toBeNull();
    const body: unknown = await response.json();
    expect(ErrorBody.parse(body)).toEqual(body);
    expect(body).toMatchObject({ error: { code: "validation/invalid_input" } });
    expect((body as ErrorBody).error).not.toHaveProperty("action");
  });
});
