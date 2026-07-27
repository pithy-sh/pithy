import { env } from "cloudflare:test";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, it } from "vitest";
import { MatchmakingGame } from "../config/config";
import type { SessionMinter } from "../session/minter";
import { createRoom, joinRoom } from "./room";

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
