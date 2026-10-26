// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { MatchmakingQueueSettings, MatchmakingSnapshot } from "../config/config";
import type { MatchmakingQueue, MatchmakingQueueEnv, QueueTicket } from "./durableObject";
import type { WaitingTicket } from "./matching";

// The workers test env binds DB, MATCHMAKING (KV), QUEUE and PRESENCE — but no SESSIONS. With multiplayer
// absent the coordinator still pairs players; the minted session id is simply null.
const SNAPSHOT = MatchmakingSnapshot.parse({ kind: "connect-n", rules: {} });
const SETTINGS = MatchmakingQueueSettings.parse({});

function ticket(userId: string, over: Partial<QueueTicket> = {}): QueueTicket {
  return {
    userId,
    skill: 1000,
    region: "na",
    gameKey: "g",
    players: 2,
    settings: SETTINGS,
    snapshot: SNAPSHOT,
    ...over,
  };
}

/** A fresh, uniquely-named coordinator per test so their storage never overlaps. */
function queue(name: string): DurableObjectStub<MatchmakingQueue> {
  return env.QUEUE.get(env.QUEUE.idFromName(name));
}

// `runInDurableObject`'s `O` constraint only admits a DO with a `fetch` handler or one whose env is the full
// test Env. This coordinator is RPC-only (no WebSockets) with a narrow env, so it satisfies neither — reshape
// the helper's type to the concrete queue instance. Runtime behavior is unchanged; only the types narrow.
const inQueue = runInDurableObject as unknown as <R>(
  stub: DurableObjectStub<MatchmakingQueue>,
  fn: (q: MatchmakingQueue, state: DurableObjectState) => R | Promise<R>,
) => Promise<R>;

/** A waiting ticket written straight to storage, so a test can stage a queue the enqueue path would pair at once. */
function waitingTicket(userId: string, region: string): WaitingTicket {
  return { userId, skill: 1000, region, players: 2, snapshot: SNAPSHOT, settings: SETTINGS, enqueuedAt: Date.now() };
}

/**
 * A SESSIONS stand-in whose mint is held open until the test releases it — the window an RPC to the session DO
 * leaves, in which another call can run against the coordinator. `minting` resolves once the sweep is waiting.
 */
function slowSessions(): { sessions: unknown; minting: Promise<void>; release: () => void } {
  let started!: () => void;
  let release!: () => void;
  const minting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stub = {
    async create() {
      started();
      await held;
      return { sessionId: "session-1" };
    },
    async join() {
      return { sessionId: "session-1" };
    },
  };
  const sessions = { newUniqueId: () => ({ toString: () => "id" }), idFromString: () => "id", get: () => stub };
  return { sessions, minting, release };
}

/** Point a live coordinator at a SESSIONS stand-in. The instance's env is a plain field; only the type hides it. */
function bindSessions(q: MatchmakingQueue, sessions: unknown): void {
  const holder = q as unknown as { env: MatchmakingQueueEnv };
  holder.env = { ...holder.env, SESSIONS: sessions as MatchmakingQueueEnv["SESSIONS"] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("MatchmakingQueue (the open-queue coordinator DO)", () => {
  test("two compatible players pair on the second enqueue; status delivers each match once", async () => {
    const stub = queue("pair");

    const first = await inQueue(stub, (q) => q.enqueue(ticket("a", { skill: 1000 })));
    expect(first.state).toBe("queued");
    expect(first.sessionId).toBeNull();

    // The second player fills the roster — this enqueue returns matched (no SESSIONS → null session id).
    const second = await inQueue(stub, (q) => q.enqueue(ticket("b", { skill: 1050 })));
    expect(second.state).toBe("matched");
    expect(second.sessionId).toBeNull();

    // Both players are recorded; status hands the match to each exactly once.
    const statusA = await inQueue(stub, (q) => q.status("a"));
    expect(statusA.state).toBe("matched");
    expect(statusA.sessionId).toBeNull();
    const statusB = await inQueue(stub, (q) => q.status("b"));
    expect(statusB.state).toBe("matched");

    // Deliver-once: a re-poll finds no standing at all.
    await expect(inQueue(stub, (q) => q.status("a"))).rejects.toThrow(/not in this queue/i);
  });

  test("a re-enqueue after matching returns the pending match", async () => {
    const stub = queue("rejoin");
    await inQueue(stub, (q) => q.enqueue(ticket("a")));
    await inQueue(stub, (q) => q.enqueue(ticket("b")));

    // "a" was matched by "b"'s enqueue but has not polled — enqueuing again hands back the waiting match.
    const again = await inQueue(stub, (q) => q.enqueue(ticket("a")));
    expect(again.state).toBe("matched");
    expect(again.sessionId).toBeNull();
  });

  test("a lone player stays queued, and the sweep alarm cannot conjure an opponent", async () => {
    const stub = queue("lonely");

    const status = await inQueue(stub, (q) => q.enqueue(ticket("solo")));
    expect(status.state).toBe("queued");
    expect(status.sessionId).toBeNull();

    // The enqueue armed a sweep; running it re-attempts pairing and finds no partner.
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const after = await inQueue(stub, (q) => q.status("solo"));
    expect(after.state).toBe("queued");
    expect(after.waitingMs).toBeGreaterThanOrEqual(0);
  });

  test("leaving the queue, then checking status, reports not-queued", async () => {
    const stub = queue("leaver");

    await inQueue(stub, (q) => q.enqueue(ticket("gone")));
    await inQueue(stub, (q) => q.leave("gone"));

    await expect(inQueue(stub, (q) => q.status("gone"))).rejects.toThrow(/not in this queue/i);
  });

  test("waiting() lists who is queued, in which region, with what skill and band, since when", async () => {
    const stub = queue("snapshot");
    await inQueue(stub, (q) => q.enqueue(ticket("a", { region: "eu", skill: 1200 })));
    await inQueue(stub, (q) => q.enqueue(ticket("b", { region: "na", skill: null })));

    const waiting = await inQueue(stub, (q) => q.waiting());
    expect(waiting.map((t) => t.userId)).toEqual(["a", "b"]);
    expect(waiting[0]).toMatchObject({ userId: "a", region: "eu", skill: 1200 });
    expect(waiting[0]?.skillBand).toBeGreaterThanOrEqual(SETTINGS.initialBand);
    expect(typeof waiting[0]?.enqueuedAt).toBe("number");
    // An unrated player has no band: they pair with anyone.
    expect(waiting[1]).toMatchObject({ userId: "b", region: "na", skill: null, skillBand: null });
  });

  test("waiting() on a coordinator nobody ever joined is empty", async () => {
    expect(await inQueue(queue("untouched"), (q) => q.waiting())).toEqual([]);
  });

  test("drop() removes a waiting player, and a replay of the same key changes nothing", async () => {
    const stub = queue("drop");
    await inQueue(stub, (q) => q.enqueue(ticket("a", { region: "eu" })));
    await inQueue(stub, (q) => q.enqueue(ticket("b", { region: "na" })));

    expect(await inQueue(stub, (q) => q.drop("a", "key-1"))).toEqual({ replayed: false });
    expect((await inQueue(stub, (q) => q.waiting())).map((t) => t.userId)).toEqual(["b"]);

    // The same request again: answered as a replay, and "b" is untouched.
    expect(await inQueue(stub, (q) => q.drop("a", "key-1"))).toEqual({ replayed: true });
    expect((await inQueue(stub, (q) => q.waiting())).map((t) => t.userId)).toEqual(["b"]);
    await expect(inQueue(stub, (q) => q.status("a"))).rejects.toThrow(/not in this queue/i);
  });

  test("drop() of a player who is not queued is refused, and records nothing", async () => {
    const stub = queue("drop-missing");
    await expect(inQueue(stub, (q) => q.drop("nobody", "key-1"))).rejects.toThrow(/matchmaking\/not_queued/);
    // The key was not spent: once the player is queued, the same key drops them.
    await inQueue(stub, (q) => q.enqueue(ticket("nobody")));
    expect(await inQueue(stub, (q) => q.drop("nobody", "key-1"))).toEqual({ replayed: false });
  });

  test("drop() refuses a key already spent on a different player", async () => {
    const stub = queue("drop-reuse");
    await inQueue(stub, (q) => q.enqueue(ticket("a", { region: "eu" })));
    await inQueue(stub, (q) => q.enqueue(ticket("b", { region: "na" })));
    await inQueue(stub, (q) => q.drop("a", "key-1"));

    await expect(inQueue(stub, (q) => q.drop("b", "key-1"))).rejects.toThrow(/core\/conflict/);
    expect((await inQueue(stub, (q) => q.waiting())).map((t) => t.userId)).toEqual(["b"]);
  });

  test("dropping the last waiting player clears the sweep alarm", async () => {
    const stub = queue("drop-last");
    await inQueue(stub, (q) => q.enqueue(ticket("solo")));
    await inQueue(stub, (q) => q.drop("solo", "key-1"));
    expect(await inQueue(stub, (_q, state) => state.storage.getAlarm())).toBeNull();
  });

  test("a drop that lands while a sweep is minting sticks once the sweep finishes", async () => {
    const stub = queue("drop-during-mint");
    const outcome = await inQueue(stub, async (q, state) => {
      await state.storage.put("gameKey", "g");
      await state.storage.put("waiting", [
        waitingTicket("a", "na"),
        waitingTicket("b", "na"),
        waitingTicket("x", "eu"),
      ]);
      const slow = slowSessions();
      bindSessions(q, slow.sessions);

      const sweep = q.alarm();
      await slow.minting;
      const drop = q.drop("x", "key-1");
      slow.release();
      await sweep;
      return drop;
    });

    expect(outcome).toEqual({ replayed: false });
    expect(await inQueue(stub, (q) => q.waiting())).toEqual([]);
    expect((await inQueue(stub, (q) => q.status("a"))).state).toBe("matched");
  });

  test("a drop of a player the in-flight sweep is pairing finds them matched, not queued", async () => {
    const stub = queue("drop-matched-during-mint");
    const drop = await inQueue(stub, async (q, state) => {
      await state.storage.put("gameKey", "g");
      await state.storage.put("waiting", [waitingTicket("a", "na"), waitingTicket("b", "na")]);
      const slow = slowSessions();
      bindSessions(q, slow.sessions);

      const sweep = q.alarm();
      await slow.minting;
      const dropping = q.drop("b", "key-1").then(
        () => "dropped",
        (error: unknown) => String(error),
      );
      slow.release();
      await sweep;
      return dropping;
    });

    // The sweep paired "b" first, so the drop is refused: no queue_dropped frame, no audit row for a drop that did not happen.
    expect(drop).toMatch(/matchmaking\/not_queued/);
    expect((await inQueue(stub, (q) => q.status("b"))).sessionId).toBe("session-1");
    expect(await inQueue(stub, (q) => q.waiting())).toEqual([]);
  });

  test("a drop forgets drop keys past the retention window and malformed records, and keeps its own", async () => {
    const stub = queue("drop-prune");
    await inQueue(stub, async (_q, state) => {
      await state.storage.put("drop:old", { userId: "x", at: Date.now() - DAY_MS - 60 * 60 * 1000 });
      await state.storage.put("drop:recent", { userId: "y", at: Date.now() - 60 * 60 * 1000 });
      await state.storage.put("drop:junk", "not-a-record");
    });
    await inQueue(stub, (q) => q.enqueue(ticket("a")));

    expect(await inQueue(stub, (q) => q.drop("a", "fresh"))).toEqual({ replayed: false });

    const keys = await inQueue(stub, async (_q, state) => [...(await state.storage.list({ prefix: "drop:" })).keys()]);
    expect(keys.sort()).toEqual(["drop:fresh", "drop:recent"]);
    expect(await inQueue(stub, (q) => q.drop("a", "fresh"))).toEqual({ replayed: true });
  });
});
