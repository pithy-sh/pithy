// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { matchmakingDatabase } from "../data/tables";
import { MATCHMAKING_MIGRATIONS } from "../migrations/chain";
import { inviteStore } from "./store";

/** Rebuild the matchmaking tables from a clean slate before each test. */
beforeEach(async () => {
  for (const table of ["pithy_matchmaking_friends", "pithy_matchmaking_invites"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const db = createDatabase(env.DB, {}) as unknown as Kysely<unknown>;
  for (const migration of Object.values(MATCHMAKING_MIGRATIONS)) await migration.up(db);
});

const AT = new Date("2026-07-25T10:00:00.000Z");
const LATER = new Date("2026-07-25T11:00:00.000Z");
const LATEST = new Date("2026-07-25T12:00:00.000Z");

const base = {
  gameKey: "chess",
  inviterId: "alice",
  inviteeId: "bob",
};

describe("inviteStore", () => {
  it("create persists a pending invite and pendingFor returns it", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    const created = await store.create({ id: "inv-1", ...base, at: AT });
    expect(created).toEqual({
      id: "inv-1",
      gameKey: "chess",
      inviterId: "alice",
      inviteeId: "bob",
      status: "pending",
      sessionId: null,
      createdAt: AT,
      respondedAt: null,
      cancelKey: null,
    });

    const pending = await store.pendingFor("bob");
    expect(pending).toEqual([created]);
    expect(await store.get("inv-1")).toEqual(created);
  });

  it("pendingFor returns newest first and excludes non-pending", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await store.create({ id: "old", ...base, at: AT });
    await store.create({ id: "new", ...base, at: LATER });
    await store.create({ id: "newest", ...base, at: LATEST });
    await store.decline("old", LATEST);

    const pending = await store.pendingFor("bob");
    expect(pending.map((i) => i.id)).toEqual(["newest", "new"]);
  });

  it("accept sets status, sessionId, and respondedAt", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await store.create({ id: "inv-2", ...base, at: AT });

    const accepted = await store.accept("inv-2", "sess-99", LATER);
    expect(accepted.status).toBe("accepted");
    expect(accepted.sessionId).toBe("sess-99");
    expect(accepted.respondedAt).toEqual(LATER);

    const reread = await store.get("inv-2");
    expect(reread).toEqual(accepted);
    expect(await store.pendingFor("bob")).toEqual([]);
  });

  it("decline sets status declined and respondedAt, leaves sessionId null", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await store.create({ id: "inv-3", ...base, at: AT });

    const declined = await store.decline("inv-3", LATER);
    expect(declined.status).toBe("declined");
    expect(declined.sessionId).toBeNull();
    expect(declined.respondedAt).toEqual(LATER);

    const reread = await store.get("inv-3");
    expect(reread).toEqual(declined);
  });

  it("get on a missing invite returns undefined", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    expect(await store.get("nope")).toBeUndefined();
  });

  it("accept and decline on a missing invite throw invite_not_found", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await expect(store.accept("nope", "sess", AT)).rejects.toMatchObject({
      payload: { code: "matchmaking/invite_not_found" },
    });
    await expect(store.decline("nope", AT)).rejects.toMatchObject({
      payload: { code: "matchmaking/invite_not_found" },
    });
  });

  it("accept and decline refuse an invite that is no longer pending, and change nothing", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await store.create({ id: "done", ...base, at: AT });
    const declined = await store.decline("done", LATER);

    await expect(store.accept("done", "sess", LATEST)).rejects.toMatchObject({
      payload: { code: "matchmaking/invite_not_found" },
    });
    await expect(store.decline("done", LATEST)).rejects.toMatchObject({
      payload: { code: "matchmaking/invite_not_found" },
    });
    expect(await store.get("done")).toEqual(declined);
  });
});

describe("inviteStore.cancel (a management client's cancel)", () => {
  it("cancels a pending invite under its idempotency key", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await store.create({ id: "inv", ...base, at: AT });

    const outcome = await store.cancel("inv", "key-1", LATER);
    expect(outcome.replayed).toBe(false);
    expect(outcome.invite).toMatchObject({ status: "canceled", respondedAt: LATER, cancelKey: "key-1" });
    expect(await store.get("inv")).toEqual(outcome.invite);
    expect(await store.pendingFor("bob")).toEqual([]);
  });

  it("a replay of the same key on the same invite changes nothing and says so", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await store.create({ id: "inv", ...base, at: AT });
    const first = await store.cancel("inv", "key-1", LATER);

    const again = await store.cancel("inv", "key-1", LATEST);
    expect(again).toEqual({ invite: first.invite, replayed: true });
  });

  it("refuses an invite that was accepted, declined, or canceled under another key", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await store.create({ id: "taken", ...base, at: AT });
    await store.accept("taken", "sess", LATER);
    await store.create({ id: "gone", ...base, at: AT });
    await store.cancel("gone", "key-1", LATER);

    for (const [id, key] of [
      ["taken", "key-2"],
      ["gone", "key-3"],
    ] as const) {
      await expect(store.cancel(id, key, LATEST)).rejects.toMatchObject({
        payload: { code: "matchmaking/invite_not_found" },
      });
    }
    expect((await store.get("taken"))?.status).toBe("accepted");
  });

  it("refuses a key already spent on a different invite", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await store.create({ id: "one", ...base, at: AT });
    await store.create({ id: "two", ...base, at: AT });
    await store.cancel("one", "key-1", LATER);

    await expect(store.cancel("two", "key-1", LATEST)).rejects.toMatchObject({ payload: { code: "core/conflict" } });
    expect((await store.get("two"))?.status).toBe("pending");
  });

  it("two cancels of one invite sent together: one cancels, the other is its replay", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await store.create({ id: "inv", ...base, at: AT });
    const outcomes = await Promise.all([store.cancel("inv", "key-1", LATER), store.cancel("inv", "key-1", LATER)]);
    expect(outcomes.map((o) => o.replayed).sort()).toEqual([false, true]);
  });

  it("refuses a missing invite", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await expect(store.cancel("nope", "key-1", AT)).rejects.toMatchObject({
      payload: { code: "matchmaking/invite_not_found" },
    });
  });
});

describe("inviteStore.listPending (the management read)", () => {
  it("pages every pending invite newest first, by keyset, optionally for one game", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await store.create({ id: "a", ...base, at: AT });
    await store.create({ id: "b", ...base, at: LATER });
    await store.create({ id: "c", ...base, at: LATER });
    await store.create({ id: "d", ...base, gameKey: "go", at: LATEST });
    await store.create({ id: "e", ...base, at: LATEST });
    await store.decline("e", LATEST);

    const first = await store.listPending({ limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual(["d", "c"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listPending({ limit: 2, cursor: first.nextCursor ?? undefined });
    // "b" and "c" share a timestamp: the id tiebreak keeps the boundary exact.
    expect(second.items.map((i) => i.id)).toEqual(["b", "a"]);
    expect(second.nextCursor).toBeNull();

    const chess = await store.listPending({ gameKey: "chess" });
    expect(chess.items.map((i) => i.id)).toEqual(["c", "b", "a"]);
  });

  it("a malformed cursor is a first page, not an error", async () => {
    const store = inviteStore(matchmakingDatabase(env.DB));
    await store.create({ id: "a", ...base, at: AT });
    expect((await store.listPending({ cursor: "not-a-cursor" })).items.map((i) => i.id)).toEqual(["a"]);
  });
});
