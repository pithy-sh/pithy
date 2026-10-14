// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, runInDurableObject } from "cloudflare:test";
import { ErrorBody } from "@pithy-sh/core/src/error/wire";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { leaderboard } from "@pithy-sh/leaderboard/src/capability";
import { ledger } from "@pithy-sh/ledger/src/capability";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import type { z } from "zod";
import { MULTIPLAYER_MIGRATION_ORDER, multiplayer } from "../capability";
import { battleGame } from "../game/games/battle";
import { multiplayer_0001_results } from "../migrations/0001_results";
import type { MultiplayerSession } from "./durableObject";
import { ErrorFrame, ServerFrame, type StateFrame } from "./frames";
import { USER_HEADER } from "./protocol";
import type { GameSnapshot } from "./state";
import { SessionView } from "./view";

/** The battle game's declared view — what a resolved state frame's `state` must conform to. */
const BattleView = battleGame.view as z.ZodType;

// The composition an adopter's `createEntrypoint` performs at load (#645): every capability's `compose` hook over
// the whole set. It is what hands the session its ledger and its leaderboard, which the session never imports;
// the Durable Object runs in this isolate, so it reads what this composed.
const composed = [
  ledger({ currencies: [{ code: "chips", name: "Chips" }] }),
  leaderboard({ boards: [{ key: "wins", direction: "desc", aggregation: "sum" }] }),
  multiplayer({ games: [{ key: "tic-tac-toe", kind: "connect-n", rules: { rows: 3, cols: 3, connect: 3 } }] }),
];
for (const capability of composed) capability.compose?.({ capabilities: composed });

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

const game: GameSnapshot = {
  key: "battle",
  kind: "battle",
  mode: "match",
  players: 2,
  turnTimeoutMs: null,
  leaderboard: null,
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
};

type SimultaneousView = { you: { submission: unknown }; opponents: { submission: unknown }[] };

function upgrade(stub: DurableObjectStub<MultiplayerSession>, userId: string): Promise<Response> {
  const request = new Request("https://do/socket", { headers: { upgrade: "websocket", [USER_HEADER]: userId } });
  return stub.fetch(request);
}

function nextView(ws: WebSocket): Promise<SessionView> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string) as SessionView), { once: true });
    ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
  });
}

describe("MultiplayerSession — WebSocket (Hibernation API)", () => {
  test("a member's upgrade is accepted as a hibernatable socket and gets an initial snapshot", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(game, "alice"));

    const response = await upgrade(stub, "alice");
    expect(response.status).toBe(101);
    const client = response.webSocket;
    expect(client).toBeTruthy();
    if (!client) throw new Error("no socket");
    client.accept();
    const initial = await nextView(client);
    expect(initial.sessionId).toBeTruthy();

    const connected = await runInDurableObject(stub, (s: MultiplayerSession) => s.connectedUserIds());
    expect(connected).toEqual(["alice"]);
  });

  test("a non-member's upgrade is refused", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(game, "alice"));
    expect((await upgrade(stub, "mallory")).status).toBe(403);
  });

  test("acting over the socket resolves the session and pushes the reveal", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(game, "alice"));
    await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));

    const socketResponse = await upgrade(stub, "alice");
    const aliceSocket = socketResponse.webSocket;
    if (!aliceSocket) throw new Error("no socket");
    aliceSocket.accept();
    await nextView(aliceSocket); // drop the initial snapshot

    aliceSocket.send(JSON.stringify({ type: "action", payload: { offense: ["fire"], defense: ["guard-ice"] } }));
    const afterAlice = await nextView(aliceSocket);
    expect((afterAlice.state as SimultaneousView).you.submission).toEqual({
      offense: ["fire"],
      defense: ["guard-ice"],
    });

    const resolvedPush = nextView(aliceSocket);
    await runInDurableObject(stub, (s: MultiplayerSession) =>
      s.action("bob", { offense: ["ice"], defense: ["guard-fire"] }),
    );
    const pushed = await resolvedPush;
    expect(pushed.phase).toBe("resolved");
    expect((pushed.state as SimultaneousView).opponents[0]?.submission).toEqual({
      offense: ["ice"],
      defense: ["guard-fire"],
    });
  });

  test("an error frame carries no operator remedy — the socket is a client transport", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    // Created but not filled: the session sits in `open`, so acting throws an invalid transition, whose
    // payload carries the `action` every multiplayer error defaults. A real socket, a real thrown error.
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(game, "alice"));
    const socketResponse = await upgrade(stub, "alice");
    const socket = socketResponse.webSocket;
    if (!socket) throw new Error("no socket");
    socket.accept();
    await nextView(socket);

    const raw = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => resolve(event.data as string), { once: true });
    });
    socket.send(JSON.stringify({ type: "action", payload: { offense: ["fire"], defense: ["guard-ice"] } }));
    const text = await raw;
    const frame = JSON.parse(text) as { type: string; error: Record<string, unknown> };

    expect(frame.type).toBe("error");
    expect(frame.error.code).toBe("multiplayer/invalid_transition");
    expect(Object.hasOwn(frame.error, "action")).toBe(false);
    expect(Object.hasOwn(frame.error, "detail")).toBe(false);
    // The bytes, not just the parsed object — an `action` cannot ride along under another key either.
    expect(text).not.toContain("Check the session's phase");
    expect(text).not.toContain("in phase open");
  });

  test("a malformed socket message returns an error frame, not a crash", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    await runInDurableObject(stub, (s: MultiplayerSession) => s.create(game, "alice"));
    const socketResponse = await upgrade(stub, "alice");
    const socket = socketResponse.webSocket;
    if (!socket) throw new Error("no socket");
    socket.accept();
    await nextView(socket);
    const errorFrame = new Promise<{ type: string; error: { code: string } }>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)), { once: true });
    });
    socket.send("not json");
    const frame = await errorFrame;
    expect(frame.type).toBe("error");
    expect(frame.error.code).toBe("validation/invalid_input");
  });
});

/**
 * Every frame one socket receives, kept in order, with a way to wait for the next. So a test can assert on
 * the frames it cares about and still hold **every** frame the socket was sent to the published schema.
 */
function recorder(ws: WebSocket) {
  const frames: string[] = [];
  const waiting: ((text: string) => void)[] = [];
  let read = 0;
  ws.addEventListener("message", (event) => {
    const text = event.data as string;
    frames.push(text);
    const resolve = waiting.shift();
    if (resolve) {
      read++;
      resolve(text);
    }
  });
  return {
    frames,
    /** The next frame not yet read, parsed. */
    next(): Promise<unknown> {
      if (read < frames.length) return Promise.resolve(JSON.parse(frames[read++] as string));
      return new Promise((resolve) => waiting.push((text) => resolve(JSON.parse(text))));
    },
  };
}

/** Require a frame to parse with a schema, and the parse to hand back exactly what arrived. */
function conforming(schema: z.ZodType, text: string): void {
  const frame: unknown = JSON.parse(text);
  expect(schema.parse(frame)).toEqual(frame);
}

function upgradeOffering(
  stub: DurableObjectStub<MultiplayerSession>,
  userId: string,
  offered: string,
): Promise<Response> {
  const request = new Request("https://do/socket", {
    headers: { upgrade: "websocket", [USER_HEADER]: userId, "Sec-WebSocket-Protocol": offered },
  });
  return stub.fetch(request);
}

async function activeBattle(): Promise<DurableObjectStub<MultiplayerSession>> {
  const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
  await runInDurableObject(stub, (s: MultiplayerSession) => s.create(game, "alice"));
  await runInDurableObject(stub, (s: MultiplayerSession) => s.join("bob"));
  return stub;
}

describe("MultiplayerSession — the socket contract, both versions", () => {
  test("pithy.multiplayer.v1: the 101 names it, and every frame is a published ServerFrame", async () => {
    const stub = await activeBattle();
    const response = await upgradeOffering(stub, "alice", "pithy.multiplayer.v1");
    expect(response.status).toBe(101);
    // A browser drops a socket whose answer does not name a protocol it offered.
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("pithy.multiplayer.v1");
    const socket = response.webSocket;
    if (!socket) throw new Error("no socket");
    socket.accept();
    const frames = recorder(socket);

    const initial = (await frames.next()) as StateFrame;
    expect(initial.type).toBe("state");
    expect(initial.phase).toBe("active");

    socket.send(JSON.stringify({ type: "state" }));
    expect(((await frames.next()) as StateFrame).type).toBe("state");

    // Malformed, four ways: not JSON, a `type` the socket does not accept, no `type` at all, and a payload
    // the game refuses. A v1 socket answers every one.
    socket.send("not json");
    expect((await frames.next()) as ErrorFrame).toMatchObject({
      type: "error",
      error: { code: "validation/invalid_input" },
    });
    socket.send(JSON.stringify({ type: "move", payload: {} }));
    expect((await frames.next()) as ErrorFrame).toMatchObject({
      type: "error",
      error: { code: "validation/invalid_input" },
    });
    socket.send(JSON.stringify({ payload: {} }));
    expect((await frames.next()) as ErrorFrame).toMatchObject({
      type: "error",
      error: { code: "validation/invalid_input" },
    });
    socket.send(JSON.stringify({ type: "action", payload: { offense: "fire" } }));
    const refused = (await frames.next()) as ErrorFrame;
    expect(refused).toMatchObject({ type: "error", error: { code: "validation/invalid_input", status: 400 } });
    expect(refused.error.issues?.length).toBeGreaterThan(0);
    expect(Object.hasOwn(refused.error, "detail")).toBe(false);

    // A well-formed action, then the resolving one from the other seat: both pushed as state frames.
    socket.send(JSON.stringify({ type: "action", payload: { offense: ["fire"], defense: ["guard-ice"] } }));
    expect(((await frames.next()) as StateFrame).type).toBe("state");
    await runInDurableObject(stub, (s: MultiplayerSession) =>
      s.action("bob", { offense: ["ice"], defense: ["guard-fire"] }),
    );
    const resolved = (await frames.next()) as StateFrame;
    expect(resolved.phase).toBe("resolved");
    expect(BattleView.parse(resolved.state)).toEqual(resolved.state);

    expect(frames.frames.length).toBe(8);
    for (const text of frames.frames) conforming(ServerFrame, text);
  });

  test("unversioned: no protocol answered, and the state is the bare view it always was", async () => {
    const stub = await activeBattle();
    const response = await upgrade(stub, "alice");
    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBeNull();
    const socket = response.webSocket;
    if (!socket) throw new Error("no socket");
    socket.accept();
    const frames = recorder(socket);

    const initial = (await frames.next()) as Record<string, unknown>;
    expect(Object.hasOwn(initial, "type")).toBe(false);
    // Not JSON is the one malformed frame the unversioned protocol always answered.
    socket.send("not json");
    expect(await frames.next()).toMatchObject({ type: "error", error: { code: "validation/invalid_input" } });
    // A `type` it does not know, or none at all, it always ignored. The `state` request after them is
    // answered next, so nothing came back for any of the four.
    socket.send(JSON.stringify({ type: "nonsense" }));
    socket.send(JSON.stringify({ payload: {} }));
    socket.send(JSON.stringify(5));
    socket.send(JSON.stringify(null));
    socket.send(JSON.stringify({ type: "state" }));
    expect(Object.hasOwn((await frames.next()) as object, "type")).toBe(false);
    socket.send(JSON.stringify({ type: "action", payload: { offense: ["fire"], defense: ["guard-ice"] } }));
    expect(Object.hasOwn((await frames.next()) as object, "type")).toBe(false);

    expect(frames.frames.length).toBe(4);
    const [first, error, resync, acted] = frames.frames as [string, string, string, string];
    conforming(SessionView, first);
    conforming(ErrorFrame, error);
    conforming(SessionView, resync);
    conforming(SessionView, acted);
  });

  test("a v1 socket and an unversioned one on the same session each get their own version of one change", async () => {
    const stub = await activeBattle();
    const v1 = (await upgradeOffering(stub, "alice", "pithy.multiplayer.v1")).webSocket;
    const bare = (await upgrade(stub, "bob")).webSocket;
    if (!v1 || !bare) throw new Error("no socket");
    v1.accept();
    bare.accept();
    const v1Frames = recorder(v1);
    const bareFrames = recorder(bare);
    await v1Frames.next();
    await bareFrames.next();

    await runInDurableObject(stub, (s: MultiplayerSession) =>
      s.action("bob", { offense: ["ice"], defense: ["guard-fire"] }),
    );
    expect(((await v1Frames.next()) as StateFrame).type).toBe("state");
    expect(Object.hasOwn((await bareFrames.next()) as object, "type")).toBe(false);
    for (const text of v1Frames.frames) conforming(ServerFrame, text);
    for (const text of bareFrames.frames) conforming(SessionView, text);
  });

  test("an offer this socket does not serve is a 400 before the upgrade, as the ordinary error body", async () => {
    const stub = await activeBattle();
    const response = await upgradeOffering(stub, "alice", "pithy.multiplayer.v9");
    expect(response.status).toBe(400);
    expect(response.webSocket).toBeNull();
    const body: unknown = await response.json();
    expect(ErrorBody.parse(body)).toEqual(body);
    expect((body as ErrorBody).error.code).toBe("validation/invalid_input");
    expect(Object.hasOwn((body as ErrorBody).error, "action")).toBe(false);
  });

  test("an offer naming v1 among others is answered with v1", async () => {
    const stub = await activeBattle();
    const response = await upgradeOffering(stub, "alice", "chat, pithy.multiplayer.v1");
    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("pithy.multiplayer.v1");
  });
});
