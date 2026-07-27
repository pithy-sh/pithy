import { env } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { matchmakingDatabase } from "../data/tables";
import { matchmaking_0001_matchmaking } from "../migrations/0001_matchmaking";
import { inviteStore } from "./store";

/** Rebuild the matchmaking tables from a clean slate before each test. */
beforeEach(async () => {
  for (const table of ["pithy_matchmaking_friends", "pithy_matchmaking_invites"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await matchmaking_0001_matchmaking.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
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
});
