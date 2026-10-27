// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { freshMultiplayerDatabase } from "../test-utils/database";
import { sessionIndex } from "./sessionStore";
import { multiplayerDatabase } from "./tables";

beforeEach(async () => {
  await freshMultiplayerDatabase(env.DB);
});

const index = () => sessionIndex(multiplayerDatabase(env.DB));
const at = (ms: number) => new Date(ms);

describe("sessionIndex", () => {
  test("put inserts a row, and a second put rewrites phase and players but keeps openedAt", async () => {
    await index().put({ sessionId: "s1", gameKey: "duel", phase: "open", players: ["ada"], openedAt: at(1_000) });
    await index().put({
      sessionId: "s1",
      gameKey: "duel",
      phase: "active",
      players: ["ada", "bo"],
      openedAt: at(9_000),
    });
    const row = await index().get("s1");
    expect(row).toMatchObject({ phase: "active", players: ["ada", "bo"], openedAt: at(1_000) });
  });

  test("remove deletes the row, and removing a session with none is not an error", async () => {
    await index().put({ sessionId: "s1", gameKey: "duel", phase: "open", players: ["ada"], openedAt: at(1) });
    await index().remove("s1");
    await index().remove("s1");
    expect(await index().get("s1")).toBeUndefined();
  });

  test("list pages newest first, by game, and resumes exactly where the last page ended", async () => {
    for (let i = 0; i < 5; i++) {
      await index().put({
        sessionId: `s${i}`,
        gameKey: i % 2 === 0 ? "duel" : "race",
        phase: "open",
        players: [],
        // Two share an opening time, so the id breaks the tie.
        openedAt: at(i === 4 ? 3_000 : (i + 1) * 1_000),
      });
    }
    const first = await index().list({ limit: 2 });
    expect(first.items.map((row) => row.sessionId)).toEqual(["s3", "s4"]);
    const second = await index().list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((row) => row.sessionId)).toEqual(["s2", "s1"]);
    const third = await index().list({ limit: 2, cursor: second.nextCursor ?? undefined });
    expect(third.items.map((row) => row.sessionId)).toEqual(["s0"]);
    expect(third.nextCursor).toBeNull();

    const duels = await index().list({ gameKey: "duel" });
    expect(duels.items.map((row) => row.sessionId)).toEqual(["s4", "s2", "s0"]);
  });

  test("a malformed cursor is a first page, not an error", async () => {
    await index().put({ sessionId: "s1", gameKey: "duel", phase: "open", players: [], openedAt: at(1) });
    expect((await index().list({ cursor: "not-a-cursor" })).items).toHaveLength(1);
  });

  test("withPlayer finds the sessions a player is in, and only those", async () => {
    await index().put({ sessionId: "s1", gameKey: "duel", phase: "open", players: ["ada"], openedAt: at(1) });
    await index().put({ sessionId: "s2", gameKey: "duel", phase: "active", players: ["bo", "ada"], openedAt: at(2) });
    await index().put({ sessionId: "s3", gameKey: "duel", phase: "open", players: ["adam"], openedAt: at(3) });
    expect((await index().withPlayer("ada")).map((row) => row.sessionId)).toEqual(["s1", "s2"]);
  });
});
