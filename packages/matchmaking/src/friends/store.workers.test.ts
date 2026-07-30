// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { matchmakingDatabase } from "../data/tables";
import { matchmaking_0001_matchmaking } from "../migrations/0001_matchmaking";
import { friendStore } from "./store";

/** Rebuild the matchmaking tables from a clean slate before each test. */
beforeEach(async () => {
  for (const table of ["pithy_matchmaking_friends", "pithy_matchmaking_invites"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await matchmaking_0001_matchmaking.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

const AT = new Date("2026-07-25T10:00:00.000Z");
const LATER = new Date("2026-07-25T11:00:00.000Z");

// `bob` < `zoe` lexicographically, so the canonical pair is (bob, zoe) regardless of who asks.
const BOB = "bob";
const ZOE = "zoe";

describe("friendStore", () => {
  it("request creates a pending edge, incoming/outgoing correct from each side", async () => {
    const store = friendStore(matchmakingDatabase(env.DB));
    await store.request(ZOE, BOB, AT);

    const fromRequester = await store.list(ZOE);
    expect(fromRequester).toEqual([{ userId: BOB, status: "pending", direction: "outgoing", since: AT }]);

    const fromRecipient = await store.list(BOB);
    expect(fromRecipient).toEqual([{ userId: ZOE, status: "pending", direction: "incoming", since: AT }]);
  });

  it("rejects a self-request", async () => {
    const store = friendStore(matchmakingDatabase(env.DB));
    await expect(store.request(BOB, BOB, AT)).rejects.toMatchObject({
      payload: { code: "validation/invalid_input" },
    });
  });

  it("a duplicate request gives already_friends (pair canonicalized regardless of direction)", async () => {
    const store = friendStore(matchmakingDatabase(env.DB));
    await store.request(BOB, ZOE, AT);
    await expect(store.request(ZOE, BOB, LATER)).rejects.toMatchObject({
      payload: { code: "matchmaking/already_friends" },
    });
  });

  it("accept by the recipient works and areFriends becomes true", async () => {
    const store = friendStore(matchmakingDatabase(env.DB));
    await store.request(ZOE, BOB, AT);
    expect(await store.areFriends(BOB, ZOE)).toBe(false);

    await store.accept(BOB, ZOE, LATER);
    expect(await store.areFriends(BOB, ZOE)).toBe(true);
    expect(await store.areFriends(ZOE, BOB)).toBe(true);

    const summaries = await store.list(BOB);
    expect(summaries).toEqual([{ userId: ZOE, status: "accepted", direction: "mutual", since: LATER }]);
  });

  it("accept by the wrong party (the requester) gives friend_request_not_found", async () => {
    const store = friendStore(matchmakingDatabase(env.DB));
    await store.request(ZOE, BOB, AT);
    // Zoe sent the request; only Bob may accept it.
    await expect(store.accept(ZOE, BOB, LATER)).rejects.toMatchObject({
      payload: { code: "matchmaking/friend_request_not_found" },
    });
    expect(await store.areFriends(BOB, ZOE)).toBe(false);
  });

  it("accept with no request gives friend_request_not_found", async () => {
    const store = friendStore(matchmakingDatabase(env.DB));
    await expect(store.accept(BOB, ZOE, AT)).rejects.toMatchObject({
      payload: { code: "matchmaking/friend_request_not_found" },
    });
  });

  it("decline removes a pending edge and is idempotent", async () => {
    const store = friendStore(matchmakingDatabase(env.DB));
    await store.request(ZOE, BOB, AT);
    await store.decline(BOB, ZOE);
    expect(await store.list(BOB)).toEqual([]);
    // Idempotent: declining again does not throw.
    await store.decline(BOB, ZOE);
  });

  it("decline does not touch an accepted edge", async () => {
    const store = friendStore(matchmakingDatabase(env.DB));
    await store.request(ZOE, BOB, AT);
    await store.accept(BOB, ZOE, LATER);
    await store.decline(BOB, ZOE);
    expect(await store.areFriends(BOB, ZOE)).toBe(true);
  });

  it("remove drops an accepted edge and is idempotent", async () => {
    const store = friendStore(matchmakingDatabase(env.DB));
    await store.request(ZOE, BOB, AT);
    await store.accept(BOB, ZOE, LATER);
    await store.remove(ZOE, BOB);
    expect(await store.areFriends(BOB, ZOE)).toBe(false);
    expect(await store.list(BOB)).toEqual([]);
    // Idempotent: removing again does not throw.
    await store.remove(ZOE, BOB);
  });

  it("list returns correct summaries across many edges", async () => {
    const store = friendStore(matchmakingDatabase(env.DB));
    // amy: incoming pending from an accepted friend, plus an outgoing pending.
    await store.request("carl", "amy", AT); // carl -> amy (amy incoming)
    await store.request("amy", "dave", AT); // amy -> dave (amy outgoing)
    await store.request("amy", "bea", AT); // amy -> bea, then accepted (mutual)
    await store.accept("bea", "amy", LATER);

    const summaries = await store.list("amy");
    const byUser = new Map(summaries.map((s) => [s.userId, s]));
    expect(byUser.get("carl")).toEqual({
      userId: "carl",
      status: "pending",
      direction: "incoming",
      since: AT,
    });
    expect(byUser.get("dave")).toEqual({
      userId: "dave",
      status: "pending",
      direction: "outgoing",
      since: AT,
    });
    expect(byUser.get("bea")).toEqual({
      userId: "bea",
      status: "accepted",
      direction: "mutual",
      since: LATER,
    });
    expect(summaries).toHaveLength(3);
  });
});
