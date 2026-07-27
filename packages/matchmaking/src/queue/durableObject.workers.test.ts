import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { MatchmakingQueueSettings, MatchmakingSnapshot } from "../config/config";
import type { MatchmakingQueue, QueueTicket } from "./durableObject";

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
// the helper's type to the concrete queue instance. Runtime behaviour is unchanged; only the types narrow.
const inQueue = runInDurableObject as unknown as <R>(
  stub: DurableObjectStub<MatchmakingQueue>,
  fn: (q: MatchmakingQueue) => R | Promise<R>,
) => Promise<R>;

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
});
