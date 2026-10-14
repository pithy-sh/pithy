// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { FriendList, InviteList, InviteView, QueueStanding, RoomCreated, RoomJoined } from "../http/responses";
import { PRESENCE_PATH } from "../presence/channel";
import { PRESENCE_VERSIONS } from "../presence/frames";
import {
  acceptFriend,
  acceptInvite,
  createRoom,
  declineFriend,
  declineInvite,
  joinQueue,
  joinRoom,
  leaveQueue,
  listFriends,
  listInvites,
  MATCHMAKING_BASE_PATH,
  MATCHMAKING_CROSS_ORIGIN,
  MATCHMAKING_PRESENCE_PROTOCOL,
  MATCHMAKING_UNREACHABLE,
  MATCHMAKING_UNREADABLE,
  type MatchmakingFetch,
  type MatchmakingRequestInit,
  type MatchmakingResponse,
  presencePath,
  readQueue,
  removeFriend,
  requestFriend,
  sendInvite,
} from "./api";

/** A fetch that answers once, and records what it was asked. */
function answering(body: unknown, status = 200) {
  const calls: { url: string; init?: MatchmakingRequestInit }[] = [];
  const send: MatchmakingFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (status === 204) throw new SyntaxError("Unexpected end of JSON input");
        return body;
      },
    } satisfies MatchmakingResponse;
  };
  return { send, calls };
}

// Every fixture is parsed through the server's own response schema, so a field renamed on the wire fails
// here rather than in a player's client. The module under test imports nothing; this test is the one place
// the two halves are held together.
const INVITE = InviteView.parse({
  id: "11111111-1111-4111-8111-111111111111",
  gameKey: "duel",
  inviterId: "ben",
  inviteeId: "ada",
  status: "pending",
  sessionId: null,
  createdAt: "2026-07-25T10:00:00.000Z",
  respondedAt: null,
});
const ACCEPTED = InviteView.parse({
  ...INVITE,
  status: "accepted",
  sessionId: "s1",
  respondedAt: "2026-07-25T11:00:00.000Z",
});
const ROOM = RoomCreated.parse({ code: "WXYZ-1234", sessionId: "s1" });
const JOINED = RoomJoined.parse({ sessionId: "s1", usesRemaining: 2 });
const INVITES = InviteList.parse({ invites: [INVITE] });
const FRIENDS = FriendList.parse({
  friends: [{ userId: "ben", status: "pending", direction: "incoming", since: "2026-07-25T10:00:00.000Z" }],
});
const QUEUED = QueueStanding.parse({ state: "queued", sessionId: null, waitingMs: 0 });

describe("every route, with what it sends and what it reads back", () => {
  test.each([
    ["createRoom", () => createRoom, ["duel"], ROOM, "POST", "/games/duel/rooms", ROOM],
    ["joinRoom", () => joinRoom, ["WXYZ-1234"], JOINED, "POST", "/rooms/WXYZ-1234/join", JOINED],
    ["acceptInvite", () => acceptInvite, [INVITE.id], ACCEPTED, "POST", `/invites/${INVITE.id}/accept`, ACCEPTED],
    ["declineInvite", () => declineInvite, [INVITE.id], INVITE, "POST", `/invites/${INVITE.id}/decline`, INVITE],
    ["listInvites", () => listInvites, [], INVITES, "GET", "/invites", INVITES.invites],
    ["listFriends", () => listFriends, [], FRIENDS, "GET", "/friends", FRIENDS.friends],
    ["joinQueue", () => joinQueue, ["duel"], QUEUED, "POST", "/games/duel/queue", QUEUED],
    ["readQueue", () => readQueue, ["duel"], QUEUED, "GET", "/games/duel/queue", QUEUED],
  ] as const)("%s", async (_name, fn, args, body, method, path, value) => {
    const { send, calls } = answering(body);
    const call = fn() as (...rest: unknown[]) => Promise<unknown>;
    const result = await call(...args, { fetch: send });
    expect(result).toEqual({ ok: true, value });
    expect(calls[0]?.url).toBe(`${MATCHMAKING_BASE_PATH}${path}`);
    expect(calls[0]?.init?.method).toBe(method);
    expect(calls[0]?.init?.credentials).toBe("include");
  });

  test.each([
    ["requestFriend", requestFriend, "POST", "/friends/ben/request"],
    ["acceptFriend", acceptFriend, "POST", "/friends/ben/accept"],
    ["declineFriend", declineFriend, "POST", "/friends/ben/decline"],
    ["removeFriend", removeFriend, "DELETE", "/friends/ben"],
  ] as const)("%s answers null for its empty 204", async (_name, fn, method, path) => {
    const { send, calls } = answering(undefined, 204);
    expect(await fn("ben", { fetch: send })).toEqual({ ok: true, value: null });
    expect(calls[0]?.url).toBe(`${MATCHMAKING_BASE_PATH}${path}`);
    expect(calls[0]?.init?.method).toBe(method);
  });

  test("leaveQueue answers null for its empty 204", async () => {
    const { send, calls } = answering(undefined, 204);
    expect(await leaveQueue("duel", { fetch: send })).toEqual({ ok: true, value: null });
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  test("sendInvite posts the target as JSON", async () => {
    const { send, calls } = answering(INVITE, 201);
    expect(await sendInvite("duel", { email: "ada@example.com" }, { fetch: send })).toEqual({
      ok: true,
      value: INVITE,
    });
    expect(calls[0]?.url).toBe(`${MATCHMAKING_BASE_PATH}/games/duel/invites`);
    expect(calls[0]?.init?.headers?.["content-type"]).toBe("application/json");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ email: "ada@example.com" }));
  });

  test("a bearer client's headers ride every request", async () => {
    const { send, calls } = answering(INVITE, 201);
    await sendInvite("duel", { name: "Ada" }, { fetch: send, headers: { authorization: "Bearer t" } });
    expect(calls[0]?.init?.headers).toEqual({ authorization: "Bearer t", "content-type": "application/json" });
  });

  test("a path value cannot add a segment of its own", async () => {
    const { send, calls } = answering(QUEUED);
    await readQueue("../invites", { fetch: send });
    expect(calls[0]?.url).toBe(`${MATCHMAKING_BASE_PATH}/games/..%2Finvites/queue`);
    // A lone surrogate would make `encodeURIComponent` throw; it is replaced instead.
    await expect(readQueue("\uD800", { fetch: send })).resolves.toMatchObject({ ok: true });
  });

  test("the presence socket's path and protocol are the ones the Worker serves", () => {
    expect(presencePath()).toEqual({ ok: true, value: `${MATCHMAKING_BASE_PATH}${PRESENCE_PATH}` });
    expect(MATCHMAKING_PRESENCE_PROTOCOL).toBe(PRESENCE_VERSIONS.current);
    expect(presencePath({ basePath: "//evil.example.com" })).toEqual({ ok: false, failure: MATCHMAKING_CROSS_ORIGIN });
  });
});

describe("nothing throws, and every failure is renderable", () => {
  test("a refusal arrives as the server's own code and message", async () => {
    const { send } = answering(
      { error: { code: "matchmaking/room_not_found", status: 404, message: "That room does not exist." } },
      404,
    );
    expect(await joinRoom("ZZZZ-9999", { fetch: send })).toEqual({
      ok: false,
      failure: { code: "matchmaking/room_not_found", message: "That room does not exist.", action: null },
    });
  });

  test("an unreachable worker is a failure, not a rejection", async () => {
    const send: MatchmakingFetch = async () => {
      throw new Error("offline");
    };
    await expect(listInvites({ fetch: send })).resolves.toEqual({ ok: false, failure: MATCHMAKING_UNREACHABLE });
  });

  test("a program with no fetch at all is the same failure", async () => {
    await expect(listInvites({ global: {} })).resolves.toEqual({ ok: false, failure: MATCHMAKING_UNREACHABLE });
  });

  test("a proxy's HTML page is unreadable rather than a crash", async () => {
    const send: MatchmakingFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(listInvites({ fetch: send })).resolves.toEqual({ ok: false, failure: MATCHMAKING_UNREADABLE });
  });

  test("a non-JSON error page keeps its status in the code", async () => {
    const send: MatchmakingFetch = async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    const result = await listInvites({ fetch: send });
    expect(!result.ok && result.failure.code).toBe("client/http_502");
  });

  test("an answer of the wrong shape is unreadable rather than handed on", async () => {
    const { send } = answering({ invites: [{ id: "x" }] });
    await expect(listInvites({ fetch: send })).resolves.toEqual({ ok: false, failure: MATCHMAKING_UNREADABLE });
    const queue = answering({ state: "waiting", sessionId: null, waitingMs: 0 });
    await expect(readQueue("duel", { fetch: queue.send })).resolves.toEqual({
      ok: false,
      failure: MATCHMAKING_UNREADABLE,
    });
  });
});

describe("the request never leaves this origin", () => {
  test.each([
    ["//evil.example.com", "a protocol-relative authority"],
    ["/\\evil.example.com", "the backslash form a URL parser reads as one"],
    ["https://evil.example.com/matchmaking", "an absolute URL"],
    ["matchmaking", "an unrooted path"],
  ])("%s is refused before anything is sent — %s", async (basePath) => {
    const { send, calls } = answering(INVITES);
    expect(await listInvites({ basePath, fetch: send })).toEqual({ ok: false, failure: MATCHMAKING_CROSS_ORIGIN });
    expect(calls).toEqual([]);
  });
});

describe("the module compiles into a client bundle", () => {
  test("and imports nothing, so the Worker's schema graph does not come with it", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "api.ts"), "utf8");
    const imports = source.match(/^\s*import\s.+$/gm) ?? [];
    expect(imports).toEqual([]);
  });
});
