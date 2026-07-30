// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env, runInDurableObject } from "cloudflare:test";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { matchmakingDatabase } from "../data/tables";
import { friendStore } from "../friends/store";
import { inviteStore } from "../invite/store";
import { matchmaking_0001_matchmaking } from "../migrations/0001_matchmaking";
import { type MatchmakingPresence, PRESENCE_USER_HEADER, type PresenceEvent } from "./durableObject";

/** Rebuild the matchmaking tables from a clean slate before each test (the presence connect reads them). */
beforeEach(async () => {
  for (const table of ["pithy_matchmaking_friends", "pithy_matchmaking_invites"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await matchmaking_0001_matchmaking.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
});

const AT = new Date("2026-07-25T10:00:00.000Z");
const LATER = new Date("2026-07-25T11:00:00.000Z");

/** The initial frame the DO sends on connect. Only the fields the tests assert are typed. */
type InitFrame = {
  type: "init";
  pendingInvites: { id: string; gameKey: string; status: string }[];
  onlineFriends: string[];
};

/** A freshly-named presence object per test so their live socket sets never overlap. */
function presence(name: string): DurableObjectStub<MatchmakingPresence> {
  return env.PRESENCE.get(env.PRESENCE.idFromName(name));
}

/** Upgrade an authenticated presence socket for `userId`; asserts 101 and hands back the (un-accepted) client. */
async function openSocket(stub: DurableObjectStub<MatchmakingPresence>, userId: string): Promise<WebSocket> {
  const request = new Request("https://do/presence", {
    headers: { upgrade: "websocket", [PRESENCE_USER_HEADER]: userId },
  });
  const response = await stub.fetch(request);
  expect(response.status).toBe(101);
  const client = response.webSocket;
  if (!client) throw new Error("no socket on the 101 response");
  return client;
}

/**
 * Resolve with the socket's next message, parsed from JSON. The listener is attached synchronously (the
 * Promise executor runs eagerly), so calling this immediately after `accept()` never races the first frame.
 */
function nextFrame<T>(ws: WebSocket): Promise<T> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string) as T), { once: true });
    ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
  });
}

// The presence DO's env is narrow, so widen `runInDurableObject` to the concrete instance (the queue test's
// trick). Runtime behaviour is unchanged; only the types narrow.
const inPresence = runInDurableObject as unknown as <R>(
  stub: DurableObjectStub<MatchmakingPresence>,
  fn: (p: MatchmakingPresence) => R | Promise<R>,
) => Promise<R>;

describe("MatchmakingPresence (the presence notification DO)", () => {
  test("an upgrade without the user header is refused; a non-upgrade request is a 426", async () => {
    const stub = presence("headers");
    const noUser = await stub.fetch(new Request("https://do/presence", { headers: { upgrade: "websocket" } }));
    expect(noUser.status).toBe(401);
    const notUpgrade = await stub.fetch(
      new Request("https://do/presence", { headers: { [PRESENCE_USER_HEADER]: "ada" } }),
    );
    expect(notUpgrade.status).toBe(426);
  });

  test("connect delivers the player's pending invites and online friends", async () => {
    const stub = presence("init");
    const db = matchmakingDatabase(env.DB);
    // Ada has a pending invite from Ben, and an accepted friendship with Grace.
    await inviteStore(db).create({ id: "inv-1", gameKey: "duel", inviterId: "ben", inviteeId: "ada", at: AT });
    await friendStore(db).request("ada", "grace", AT);
    await friendStore(db).accept("grace", "ada", LATER);

    // Grace comes online first, so she is in the connected set when Ada connects.
    const grace = await openSocket(stub, "grace");
    grace.accept();

    const ada = await openSocket(stub, "ada");
    ada.accept();
    const init = await nextFrame<InitFrame>(ada);

    expect(init.type).toBe("init");
    expect(init.pendingInvites).toHaveLength(1);
    expect(init.pendingInvites[0]?.id).toBe("inv-1");
    expect(init.pendingInvites[0]?.gameKey).toBe("duel");
    expect(init.pendingInvites[0]?.status).toBe("pending");
    // Grace is an accepted friend AND connected → Ada's one online friend. Ada is never her own friend.
    expect(init.onlineFriends).toEqual(["grace"]);

    expect(grace).toBeTruthy(); // keep Grace's socket referenced for the life of the test
  });

  test("connectedUserIds reflects every socket; notify pushes to just the target user", async () => {
    const stub = presence("notify");

    const ada = await openSocket(stub, "ada");
    ada.accept();
    await nextFrame<InitFrame>(ada); // drop Ada's init frame

    const grace = await openSocket(stub, "grace");
    grace.accept();
    await nextFrame<InitFrame>(grace); // drop Grace's init frame

    const connected = await inPresence(stub, (p) => p.connectedUserIds());
    expect([...connected].sort()).toEqual(["ada", "grace"]);

    // Arm Ada's listener, then push — the match reaches Ada's socket, and only Ada's.
    const adaEvent = nextFrame<PresenceEvent>(ada);
    await inPresence(stub, (p) => p.notify("ada", { type: "match_found", sessionId: "s1", gameKey: "duel" }));
    expect(await adaEvent).toEqual({ type: "match_found", sessionId: "s1", gameKey: "duel" });
  });

  test("notify for an offline user is a no-op", async () => {
    const stub = presence("offline");
    await inPresence(stub, (p) => p.notify("nobody", { type: "friend_request", from: "ada" }));
    const connected = await inPresence(stub, (p) => p.connectedUserIds());
    expect(connected).toEqual([]);
  });
});
