// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, runInDurableObject } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { MULTIPLAYER_MIGRATION_ORDER } from "../capability";
import { multiplayer_0001_results } from "../migrations/0001_results";
import type { MultiplayerSession } from "./durableObject";
import { USER_HEADER } from "./protocol";
import type { GameSnapshot, SessionView } from "./state";

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
