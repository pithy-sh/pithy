// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it } from "vitest";
import { MatchmakingGame } from "../config/config";
import type { SessionMinter } from "../session/minter";
import { createRoom, joinRoom, openRooms } from "./room";

/** A fake minter: mint returns a fixed session id, join records every (sessionId, userId) call. */
function fakeMinter(): SessionMinter & { joins: Array<{ sessionId: string; userId: string }> } {
  const joins: Array<{ sessionId: string; userId: string }> = [];
  return {
    joins,
    async mint() {
      return "session-fixed";
    },
    async join(sessionId, userId) {
      joins.push({ sessionId, userId });
    },
  };
}

const game = MatchmakingGame.parse({
  key: "chess",
  players: 2,
  snapshot: { kind: "chess", rules: {} },
  roomCodes: { ttlSeconds: 900, maxUses: 2 },
});

async function clearRooms(): Promise<void> {
  const listed = await env.MATCHMAKING.list();
  for (const key of listed.keys) {
    await env.MATCHMAKING.delete(key.name);
  }
}

describe("createRoom / joinRoom (real MATCHMAKING KV)", () => {
  beforeEach(clearRooms);

  it("creates a room and redeems it, decrementing usesRemaining each join", async () => {
    const minter = fakeMinter();
    const { code, sessionId } = await createRoom(env.MATCHMAKING, game, minter, "host", new Date());
    expect(sessionId).toBe("session-fixed");
    expect(code).toMatch(/^[A-Z]{4}-[0-9]{4}$/);

    const first = await joinRoom(env.MATCHMAKING, minter, code, "alice", new Date());
    expect(first.sessionId).toBe("session-fixed");
    expect(first.usesRemaining).toBe(1);

    const second = await joinRoom(env.MATCHMAKING, minter, code, "bob", new Date());
    expect(second.usesRemaining).toBe(0);

    // join was called against the room's own session id, once per redemption.
    expect(minter.joins).toEqual([
      { sessionId: "session-fixed", userId: "alice" },
      { sessionId: "session-fixed", userId: "bob" },
    ]);
  });

  it("joining an unknown code throws matchmaking/room_not_found", async () => {
    const minter = fakeMinter();
    try {
      await joinRoom(env.MATCHMAKING, minter, "ABCD-2345", "alice", new Date());
      throw new Error("expected room_not_found");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.code).toBe("matchmaking/room_not_found");
    }
    expect(minter.joins).toHaveLength(0);
  });

  it("redeeming a spent code throws matchmaking/room_full", async () => {
    const minter = fakeMinter();
    const { code } = await createRoom(env.MATCHMAKING, game, minter, "host", new Date());
    await joinRoom(env.MATCHMAKING, minter, code, "alice", new Date());
    await joinRoom(env.MATCHMAKING, minter, code, "bob", new Date());

    try {
      await joinRoom(env.MATCHMAKING, minter, code, "carol", new Date());
      throw new Error("expected room_full");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.code).toBe("matchmaking/room_full");
    }
    // The full join was rejected before minting a seat.
    expect(minter.joins).toEqual([
      { sessionId: "session-fixed", userId: "alice" },
      { sessionId: "session-fixed", userId: "bob" },
    ]);
  });
});

describe("openRooms (the management read, real MATCHMAKING KV)", () => {
  beforeEach(clearRooms);

  const other = MatchmakingGame.parse({ key: "go", players: 2, snapshot: { kind: "go", rules: {} } });

  it("lists one game's open rooms with code, host, session, occupancy and age", async () => {
    const minter = fakeMinter();
    const opened = new Date("2026-10-01T12:00:00.000Z");
    const { code } = await createRoom(env.MATCHMAKING, game, minter, "host", opened);
    await createRoom(env.MATCHMAKING, other, minter, "elsewhere", opened);
    await joinRoom(env.MATCHMAKING, minter, code, "alice", opened);

    const page = await openRooms(env.MATCHMAKING, game, {});
    expect(page.rooms).toEqual([
      {
        code,
        hostId: "host",
        sessionId: "session-fixed",
        // The host, and the one player who redeemed the code.
        occupancy: 2,
        usesRemaining: 1,
        createdAt: opened,
        expiresAt: new Date(opened.getTime() + 900_000),
      },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("leaves out a spent code: it is no longer open", async () => {
    const minter = fakeMinter();
    const { code } = await createRoom(env.MATCHMAKING, game, minter, "host", new Date());
    await joinRoom(env.MATCHMAKING, minter, code, "alice", new Date());
    await joinRoom(env.MATCHMAKING, minter, code, "bob", new Date());
    expect((await openRooms(env.MATCHMAKING, game, {})).rooms).toEqual([]);
  });

  it("reads a room written before metadata existed, against the configured use limit", async () => {
    const at = new Date("2026-10-01T12:00:00.000Z");
    await env.MATCHMAKING.put(
      "matchmaking:WXYZ-2345",
      JSON.stringify({
        code: "WXYZ-2345",
        gameKey: "chess",
        hostId: "host",
        sessionId: "s-old",
        usesRemaining: 1,
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + 900_000).toISOString(),
      }),
      { expirationTtl: 900 },
    );
    const page = await openRooms(env.MATCHMAKING, game, {});
    expect(page.rooms).toEqual([expect.objectContaining({ code: "WXYZ-2345", occupancy: 2, usesRemaining: 1 })]);
  });

  it("pages by KV cursor", async () => {
    const minter = fakeMinter();
    await createRoom(env.MATCHMAKING, game, minter, "h1", new Date());
    await createRoom(env.MATCHMAKING, game, minter, "h2", new Date());

    const first = await openRooms(env.MATCHMAKING, game, { limit: 1 });
    expect(first.rooms).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await openRooms(env.MATCHMAKING, game, { limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.rooms).toHaveLength(1);
    expect(second.rooms[0]?.code).not.toBe(first.rooms[0]?.code);
  });
});
